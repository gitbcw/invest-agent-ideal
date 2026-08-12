import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createRuntimeAgent } from "../runtime/agent.js";
import type { AgentMessage, AgentResponse } from "../runtime/protocol.js";
import { OUTPUT_VOLUME_POLICY } from "../runtime/spreadsheet-output-policy.js";
import { ensureWorkspace, resolveWorkspacePath } from "../lib/workspace.js";
import { enqueuePushJob } from "./push-queue.js";
import {
  assertAutomationTaskRunLease,
  bindAutomationTaskRunAssets,
  claimAutomationTaskRun,
  finalizeAutomationTaskRunInTransaction,
  finishAutomationTaskRun,
  getAutomationTask,
  updateAutomationTaskRunDelivery,
  AutomationTaskError,
  type AutomationScope,
  type AutomationTaskRecord,
  type AutomationTaskRunRecord,
} from "./automation-tasks.js";
import { classifyTaskError, executionResponseError, type TaskErrorInfo } from "./task-execution.js";
import { writeAutomationSpreadsheetHelper } from "./automation-spreadsheet.js";
import {
  createUserAsset,
  getUserAsset,
  readUserAssetVersion,
  uploadUserAssetVersion,
  UserAssetError,
  type UserAssetBytes,
} from "./user-assets.js";

export type GenericAutomationExecutor = (input: {
  scope: AutomationScope;
  task: AutomationTaskRecord;
  run: AutomationTaskRunRecord;
  stagingPath: string;
  inputs: UserAssetBytes[];
  writableTargets: Array<NonNullable<ResolvedOutput>>;
  spreadsheetHelper?: string;
}) => Promise<AgentResponse>;

export type GenericAutomationRunResult = {
  run: AutomationTaskRunRecord;
  conversationId?: string;
  task: AutomationTaskRecord;
};

type ResolvedOutput = { assetId: string; versionId: string; fileName: string; mimeType: string } | null;
type ResolvedBindings = {
  inputs: UserAssetBytes[];
  output: ResolvedOutput;
  agentUpdateTargets: Map<string, NonNullable<ResolvedOutput>>;
  writableTargets: Array<NonNullable<ResolvedOutput>>;
};

class AutomationExecutionFailure extends Error {
  constructor(readonly taskError: TaskErrorInfo) {
    super(taskError.internalReason);
    this.name = "AutomationExecutionFailure";
  }
}

export async function runGenericAutomationTaskNow(input: {
  scope: AutomationScope;
  taskId: string;
  origin: "manual" | "scheduled";
  idempotencyKey: string;
  scheduledFor?: string;
  executor?: GenericAutomationExecutor;
}): Promise<GenericAutomationRunResult> {
  const task = await getAutomationTask({ ...input.scope, taskId: input.taskId });
  if (!task) throw new AutomationTaskError("AUTOMATION_TASK_NOT_FOUND", input.taskId);
  const claimed = await claimAutomationTaskRun({
    ...input.scope,
    taskId: input.taskId,
    origin: input.origin,
    idempotencyKey: input.idempotencyKey,
    scheduledFor: input.scheduledFor,
  });
  const run = claimed.run;
  if (!claimed.claimed) {
    if (run.idempotencyKey !== input.idempotencyKey) throw new AutomationTaskError("AUTOMATION_TASK_BUSY", "当前任务已有运行中的执行，请等待完成后再试。");
    return { run, conversationId: run.conversationId || undefined, task };
  }

  // Running a task for testing is not an instruction to add it to chat
  // history. The explicit continue-in-chat command owns that transition.
  const conversationId = undefined;
  try {
    const resolved = await resolveBindings(input.scope, task);
    const boundRun = await bindAutomationTaskRunAssets({
      ...input.scope,
      runId: run.runId,
      leaseToken: run.leaseToken,
      inputs: resolved.inputs.map((item) => ({ assetId: item.descriptor.assetId, versionId: item.descriptor.versionId, fileName: item.descriptor.fileName })),
      outputAssetId: resolved.output?.assetId ?? null,
      outputVersionId: resolved.output?.versionId ?? null,
    });
    const stagingPath = await createStagingPath(input.scope);
    try {
      for (const [index, item] of resolved.inputs.entries()) {
        await writeFile(path.join(stagingPath, "inputs", `${index + 1}-${item.descriptor.fileName}`), item.bytes, { flag: "wx", mode: 0o600 });
      }
      const usesXlsx = resolved.inputs.some((item) => item.descriptor.format === "xlsx")
        || resolved.writableTargets.some((item) => item.fileName.toLowerCase().endsWith(".xlsx"))
        || task.revision.output.mode === "agent"
        || (task.revision.output.mode === "create" && task.revision.output.format === "xlsx");
      const spreadsheetHelper = usesXlsx ? await writeAutomationSpreadsheetHelper(stagingPath) : undefined;
      const response = await (input.executor || defaultExecutor)({
        scope: input.scope,
        task,
        run: boundRun,
        stagingPath,
        inputs: resolved.inputs,
        writableTargets: resolved.writableTargets,
        spreadsheetHelper,
      });
      assertAgentSucceeded(response);
      await assertAutomationTaskRunLease({ ...input.scope, runId: run.runId, leaseToken: run.leaseToken });
      const result = normalizeStructuredResult(response, task, resolved);
      const output = await commitOutput(input.scope, task, run, result, resolved);
      const finished = await finishAutomationTaskRun({
        ...input.scope,
        runId: run.runId,
        leaseToken: run.leaseToken,
        status: "succeeded",
        resultSummary: result.summary,
        outputAssetId: output?.assetId ?? null,
        outputVersionId: output?.versionId ?? null,
        outputChecksum: output?.checksum ?? null,
        traceId: run.runId,
      });
      const delivered = await deliverResult(input.scope, task, finished, result);
      const finalRun = delivered.run;
      return {
        run: finalRun,
        conversationId,
        task,
      };
    } finally {
      await rm(stagingPath, { recursive: true, force: true });
    }
  } catch (error) {
    const classified = error instanceof AutomationExecutionFailure ? error.taskError : classifyTaskError(error);
    const message = error instanceof AutomationExecutionFailure
      ? classified.userMessage
      : error instanceof Error ? error.message : String(error);
    let failed: AutomationTaskRunRecord;
    try {
      failed = await finishAutomationTaskRun({
        ...input.scope,
        runId: run.runId,
        leaseToken: run.leaseToken,
        status: "failed",
        errorMessage: message,
        errorCategory: classified.category,
        retryable: classified.retryable,
        traceId: run.runId,
      });
    } catch {
      const current = await (await import("./automation-tasks.js")).getAutomationTaskRun({ ...input.scope, runId: run.runId });
      failed = current || run;
    }
    return { run: failed, conversationId, task };
  }
}

async function resolveBindings(scope: AutomationScope, task: AutomationTaskRecord): Promise<ResolvedBindings> {
  const inputs: UserAssetBytes[] = [];
  const agentUpdateTargets = new Map<string, NonNullable<ResolvedOutput>>();
  for (const binding of task.revision.inputs) {
    const asset = await getUserAsset({ ...scope, assetId: binding.assetId });
    if (!asset || asset.status !== "active" || !asset.currentVersionId) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", binding.assetId);
    const versionId = binding.versionPolicy === "fixed" ? binding.versionId! : asset.currentVersionId;
    try {
      const input = await readUserAssetVersion({ ...scope, assetId: asset.assetId, versionId });
      inputs.push(input);
      if (
        task.revision.output.mode === "agent" &&
        binding.versionPolicy === "latest" &&
        ["markdown", "csv", "xlsx"].includes(input.descriptor.format)
      ) {
        agentUpdateTargets.set(asset.assetId, {
          assetId: asset.assetId,
          versionId: input.descriptor.versionId,
          fileName: input.descriptor.fileName,
          mimeType: input.descriptor.mimeType,
        });
      }
    } catch (error) {
      if (error instanceof UserAssetError) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", binding.assetId);
      throw error;
    }
  }
  if (task.revision.output.mode !== "update") {
    return {
      inputs,
      output: null,
      agentUpdateTargets,
      writableTargets: [...agentUpdateTargets.values()],
    };
  }
  const asset = await getUserAsset({ ...scope, assetId: task.revision.output.assetId });
  if (!asset || asset.status !== "active" || !asset.currentVersion) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", task.revision.output.assetId);
  // `latest` means every run takes the head it actually read as its CAS
  // baseline. A revision's creation-time expectedVersionId must not pin all
  // future runs to an obsolete head after the first successful commit.
  const versionId = asset.currentVersionId;
  if (!versionId) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", asset.assetId);
  const output = { assetId: asset.assetId, versionId, fileName: asset.currentVersion.fileName, mimeType: asset.currentVersion.mimeType };
  return { inputs, output, agentUpdateTargets, writableTargets: [output] };
}

async function createStagingPath(scope: AutomationScope): Promise<string> {
  await ensureWorkspace({ userId: scope.userId, tenantId: scope.userId, projectId: scope.projectId });
  const root = resolveWorkspacePath(scope.userId);
  const stagingPath = await mkdtemp(path.join(root, ".generic-automation-run-"));
  await mkdir(path.join(stagingPath, "inputs"), { mode: 0o700 });
  return stagingPath;
}

async function defaultExecutor(input: Parameters<GenericAutomationExecutor>[0]): Promise<AgentResponse> {
  const message: AgentMessage = {
    id: input.run.runId,
    from: `automation:${input.task.taskId}`,
    timestamp: Date.now(),
    content: {
      type: "text",
      text: [
        "执行一个受控的通用自动化任务。",
        `任务说明：${input.task.revision.instruction}`,
        `本次输出策略（明确格式和文件名必须严格遵守）：${JSON.stringify(input.task.revision.output)}。`,
        `本次绑定文件（任务对象，不得用全局文件列表替换）：${JSON.stringify(input.inputs.map((item) => ({ assetId: item.descriptor.assetId, versionId: item.descriptor.versionId, fileName: item.descriptor.fileName, mimeType: item.descriptor.mimeType, format: item.descriptor.format })))}。`,
        `可更新目标（仅这些文件允许 operation='update'）：${JSON.stringify(input.writableTargets)}。`,
        "需要读取绑定文件时，直接使用上述 assetId 调用 assets.version.read；不要用 assets.list 猜测或替换任务对象。其他“我的文件”仅可作为参考，绝不能作为本次更新输出目标。",
        input.spreadsheetHelper
          ? `处理 XLSX 时使用暂存目录中的 ${input.spreadsheetHelper}：create 可新建工作簿，inspect 可读取工作簿，apply 可按 JSON 执行单元格、公式、样式、列宽、行高、合并、冻结窗格、筛选和工作表调整；不要把 XLSX 当文本编辑。`
          : "本次没有 XLSX 文件，不需要电子表格辅助工具。",
        `结果数量与表格文件规则：${OUTPUT_VOLUME_POLICY}`,
        "默认按可用数据完成任务：除非用户或任务明确要求指定来源一致、对账、审计或逐项严格核验，否则公开来源中包含指标名称、具体数值和日期/时间的结果即可写入文件，即使尚未完成第二次独立核验；必须保留实际来源、时间、口径差异并标明“未独立核验”。若经过合理检索仍没有任何可用数值，且任务没有明确要求记录维护状态，就保持原文件不变并在 summary 说明原因；不得为了证明执行过而写入空值、零值、估算值或无意义状态行。",
        "最终回复必须是一个 JSON 对象：{summary:string, stagedOutput?:{operation:'update'|'create',assetId?:string,fileName,mimeType,base64}, shouldNotify?:boolean}。更新绑定文件时提供 operation='update'、对应 assetId 和完整文件内容；仅在任务确有必要新建文件时提供 operation='create'。不得返回物理路径或调用写入工具。",
      ].join("\n"),
    },
    context: {
      channel: "web",
      conversationId: `automation-run:${input.run.runId}`,
      userId: input.scope.userId,
      projectId: input.scope.projectId,
      instanceId: input.scope.instanceId,
      workspacePath: input.stagingPath,
      taskType: "scheduled-automation",
    },
  };
  const response = await createRuntimeAgent().handleMessage(message);
  return parseStructuredAcpResponse(response);
}

/** The ACP client exposes customer text, so generic runs use a strict JSON
 * envelope in the final response to carry the service-owned staged output. */
function parseStructuredAcpResponse(response: AgentResponse): AgentResponse {
  if (response.data?.stagedOutput !== undefined || response.data?.summary !== undefined || response.data?.shouldNotify !== undefined) return response;
  const text = response.content.text?.trim() || "";
  const candidates = [text, text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] || ""];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const data = parsed as Record<string, unknown>;
      if (data.stagedOutput !== undefined || typeof data.summary === "string" || typeof data.shouldNotify === "boolean") {
        return { ...response, data };
      }
    } catch {
      // The runner fails closed in normalizeStructuredResult when output is required.
    }
  }
  return response;
}

function assertAgentSucceeded(response: AgentResponse): void {
  const error = executionResponseError(response);
  if (error) throw new AutomationExecutionFailure(error);
}

function normalizeStructuredResult(response: AgentResponse, task: AutomationTaskRecord, resolved: ResolvedBindings): {
  summary: string;
  shouldNotify: boolean;
  stagedOutput?: { operation: "create" | "update"; assetId?: string; fileName: string; mimeType?: string; base64: string };
} {
  const data = response.data && typeof response.data === "object" ? response.data : {};
  const summaryValue = typeof data.summary === "string" ? data.summary : response.content.text;
  const summary = String(summaryValue || "").trim().slice(0, 12_000);
  const delivery = task.revision.delivery;
  let shouldNotify = delivery.mode === "wechat_summary";
  if (delivery.mode === "wechat_on_condition") {
    if (typeof data.shouldNotify !== "boolean") throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "shouldNotify must be boolean");
    shouldNotify = data.shouldNotify;
  }
  const stagedRaw = data.stagedOutput;
  if (task.revision.output.mode === "none") {
    if (stagedRaw !== undefined) throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "none output cannot include stagedOutput");
    return { summary: summary || "自动化运行完成。", shouldNotify };
  }
  if (!stagedRaw || typeof stagedRaw !== "object") {
    if (task.revision.output.mode === "create") {
      throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput is required for a required file");
    }
    return { summary: summary || "自动化运行完成，未修改文件。", shouldNotify };
  }
  const staged = stagedRaw as Record<string, unknown>;
  const fileName = String(staged.fileName || "").trim();
  const base64 = typeof staged.base64 === "string" ? staged.base64 : typeof staged.bytesBase64 === "string" ? staged.bytesBase64 : "";
  if (!fileName || !isStrictBase64(base64)) throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput fileName/base64 is invalid");
  const operation = task.revision.output.mode === "agent"
    ? staged.operation
    : task.revision.output.mode;
  if (operation !== "create" && operation !== "update") {
    throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput operation is invalid");
  }
  const assetId = typeof staged.assetId === "string" ? staged.assetId : undefined;
  if (task.revision.output.mode === "create" && fileName !== task.revision.output.fileName) throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput fileName does not match output policy");
  if (task.revision.output.mode === "update" && (!resolved.output || assetId !== resolved.output.assetId || !matchesCurrentSpreadsheetName(fileName, resolved.output.fileName))) throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput update target is invalid");
  if (task.revision.output.mode === "agent" && operation === "update") {
    const target = assetId ? resolved.agentUpdateTargets.get(assetId) : undefined;
    if (!target || !matchesCurrentSpreadsheetName(fileName, target.fileName)) throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput update target is invalid");
  }
  return { summary: summary || "自动化运行完成。", shouldNotify, stagedOutput: { operation, ...(assetId ? { assetId } : {}), fileName, mimeType: typeof staged.mimeType === "string" ? staged.mimeType : undefined, base64 } };
}

async function commitOutput(scope: AutomationScope, task: AutomationTaskRecord, run: AutomationTaskRunRecord, result: ReturnType<typeof normalizeStructuredResult>, resolved: ResolvedBindings): Promise<{ assetId: string; versionId: string; checksum: string } | null> {
  if (!result.stagedOutput || task.revision.output.mode === "none") return null;
  const bytes = Buffer.from(result.stagedOutput.base64, "base64");
  const idempotencyKey = `automation:${run.runId}:output`;
  try {
    const isCreate = task.revision.output.mode === "create" || result.stagedOutput.operation === "create";
    const target = task.revision.output.mode === "update"
      ? resolved.output
      : result.stagedOutput.assetId
        ? resolved.agentUpdateTargets.get(result.stagedOutput.assetId)
        : undefined;
    const descriptor = isCreate
      ? await createUserAsset({
          ...scope,
          name: task.revision.output.mode === "create" ? task.revision.output.titleTemplate || task.revision.name : task.revision.name,
          fileName: result.stagedOutput.fileName,
          mimeType: result.stagedOutput.mimeType,
          bytes,
          source: "automation",
          taskId: task.taskId,
          runId: run.runId,
          leaseToken: run.leaseToken,
          idempotencyKey,
          finalizeRun: ({ assetId, versionId, checksum }) => finalizeAutomationTaskRunInTransaction({
            ...scope, runId: run.runId, leaseToken: run.leaseToken, status: "succeeded",
            resultSummary: result.summary, outputAssetId: assetId, outputVersionId: versionId,
            outputChecksum: checksum, traceId: run.runId,
          }),
        })
      : await uploadUserAssetVersion({
          ...scope,
          assetId: target!.assetId,
          fileName: result.stagedOutput.fileName,
          mimeType: result.stagedOutput.mimeType,
          bytes,
          expectedVersionId: target!.versionId,
          source: "automation",
          taskId: task.taskId,
          runId: run.runId,
          leaseToken: run.leaseToken,
          idempotencyKey,
          finalizeRun: ({ assetId, versionId, checksum }) => finalizeAutomationTaskRunInTransaction({
            ...scope, runId: run.runId, leaseToken: run.leaseToken, status: "succeeded",
            resultSummary: result.summary, outputAssetId: assetId, outputVersionId: versionId,
            outputChecksum: checksum, traceId: run.runId,
          }),
        });
    if (!descriptor.currentVersion) throw new AutomationTaskError("ASSET_SUBMISSION_FAILED", "output version missing");
    return { assetId: descriptor.assetId, versionId: descriptor.currentVersion.versionId, checksum: descriptor.currentVersion.checksum };
  } catch (error) {
    throw error;
  }
}

async function deliverResult(scope: AutomationScope, task: AutomationTaskRecord, run: AutomationTaskRunRecord, result: ReturnType<typeof normalizeStructuredResult>): Promise<{ run: AutomationTaskRunRecord }> {
  const delivery = task.revision.delivery;
  if (delivery.mode === "none") return { run: await updateAutomationTaskRunDelivery({ ...scope, runId: run.runId, status: "not_requested" }) };
  if (!result.shouldNotify) return { run: await updateAutomationTaskRunDelivery({ ...scope, runId: run.runId, status: "suppressed" }) };
  try {
    const job = await enqueuePushJob({
      userId: scope.userId,
      projectId: scope.projectId,
      instanceId: scope.instanceId,
      source: "automation",
      messageKind: "automation_summary",
      originTaskKey: task.taskId,
      originRunId: run.runId,
      message: result.summary,
      idempotencyKey: `automation:${run.runId}:delivery`,
    });
    return { run: await updateAutomationTaskRunDelivery({ ...scope, runId: run.runId, status: "pending", pushJobId: job.id }) };
  } catch (error) {
    await updateAutomationTaskRunDelivery({ ...scope, runId: run.runId, status: "failed" }).catch(() => undefined);
    const current = await (await import("./automation-tasks.js")).getAutomationTaskRun({ ...scope, runId: run.runId });
    return { run: current || run };
  }
}

function isStrictBase64(value: string): boolean {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const padding = value.indexOf("=");
  return padding < 0 || padding >= value.length - 2;
}

function matchesCurrentSpreadsheetName(submitted: string, current: string): boolean {
  if (submitted === current) return true;
  return submitted.toLowerCase().endsWith(".csv")
    && current.toLowerCase() === submitted.replace(/\.csv$/i, ".xlsx").toLowerCase();
}
