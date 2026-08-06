import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createAgent } from "../acp/agent.js";
import type { AcpMessage, AcpResponse } from "../acp/protocol.js";
import { ensureWorkspace, resolveWorkspacePath } from "../lib/workspace.js";
import { enqueuePushJob } from "./push-queue.js";
import {
  appendConversationMessage,
  createConversationSession,
  type ConversationMessageRecord,
} from "./conversation-log.js";
import {
  assertAutomationTaskRunLease,
  bindAutomationTaskRunConversation,
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
}) => Promise<AcpResponse>;

export type GenericAutomationRunResult = {
  run: AutomationTaskRunRecord;
  conversationId?: string;
  assistantMessage?: ConversationMessageRecord;
  task: AutomationTaskRecord;
};

type ResolvedOutput = { assetId: string; versionId: string; fileName: string; mimeType: string } | null;

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

  const conversationId = input.origin === "manual" ? `automation-${run.runId}` : undefined;
  if (conversationId) {
    createConversationSession({
      scope: { ...input.scope, assistantId: input.scope.instanceId },
      conversationId,
      channel: "web",
      title: `自动化：${task.revision.name} - 手动运行`,
      metadata: { taskId: task.taskId, taskRevision: task.currentRevision, runId: run.runId, origin: "automation_manual" },
    });
    bindAutomationTaskRunConversation({ ...input.scope, runId: run.runId, conversationId });
    appendConversationMessage({
      scope: { ...input.scope, assistantId: input.scope.instanceId },
      conversationId,
      channel: "web",
      role: "system",
      content: `这是一次用户主动发起的通用自动化运行。任务：${task.revision.name}。输入资产和输出策略已绑定到本次运行。`,
      metadata: { taskId: task.taskId, taskRevision: task.currentRevision, runId: run.runId, origin: "automation_manual" },
    });
  }
  try {
    const resolved = await resolveBindings(input.scope, task);
    const boundRun = await bindAutomationTaskRunAssets({
      ...input.scope,
      runId: run.runId,
      leaseToken: run.leaseToken,
      inputs: resolved.inputs.map((item) => ({ assetId: item.descriptor.assetId, versionId: item.descriptor.versionId })),
      outputAssetId: resolved.output?.assetId ?? null,
      outputVersionId: resolved.output?.versionId ?? null,
    });
    const stagingPath = await createStagingPath(input.scope);
    try {
      for (const [index, item] of resolved.inputs.entries()) {
        await writeFile(path.join(stagingPath, "inputs", `${index + 1}-${item.descriptor.fileName}`), item.bytes, { flag: "wx", mode: 0o600 });
      }
      const response = await (input.executor || defaultExecutor)({
        scope: input.scope,
        task,
        run: boundRun,
        stagingPath,
        inputs: resolved.inputs,
      });
      assertAcpSucceeded(response);
      await assertAutomationTaskRunLease({ ...input.scope, runId: run.runId, leaseToken: run.leaseToken });
      const result = normalizeStructuredResult(response, task, resolved.output);
      const output = await commitOutput(input.scope, task, run, result, resolved.output);
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
      const assistantMessage = conversationId
        ? appendConversationMessage({
            scope: { ...input.scope, assistantId: input.scope.instanceId },
            conversationId,
            channel: "web",
            role: "assistant",
            content: result.summary,
            traceId: run.runId,
            requestId: run.runId,
            metadata: { taskId: task.taskId, taskRevision: task.currentRevision, runId: run.runId, origin: "automation_manual", outputAssetId: finalRun.outputAssetId },
          })
        : undefined;
      return {
        run: finalRun,
        conversationId,
        assistantMessage,
        task,
      };
    } finally {
      await rm(stagingPath, { recursive: true, force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let failed: AutomationTaskRunRecord;
    try {
      failed = await finishAutomationTaskRun({
        ...input.scope,
        runId: run.runId,
        leaseToken: run.leaseToken,
        status: "failed",
        errorMessage: message,
        traceId: run.runId,
      });
    } catch {
      const current = await (await import("./automation-tasks.js")).getAutomationTaskRun({ ...input.scope, runId: run.runId });
      failed = current || run;
    }
    if (conversationId) {
      appendConversationMessage({
        scope: { ...input.scope, assistantId: input.scope.instanceId },
        conversationId,
        channel: "web",
        role: "assistant",
        content: "这次通用自动化运行失败了，请查看运行详情中的错误并重试。",
        status: "failed",
        traceId: run.runId,
        requestId: run.runId,
        metadata: { taskId: task.taskId, taskRevision: task.currentRevision, runId: run.runId, origin: "automation_manual", error: message.slice(0, 500) },
      });
    }
    return { run: failed, conversationId, task };
  }
}

async function resolveBindings(scope: AutomationScope, task: AutomationTaskRecord): Promise<{ inputs: UserAssetBytes[]; output: ResolvedOutput }> {
  const inputs: UserAssetBytes[] = [];
  for (const binding of task.revision.inputs) {
    const asset = await getUserAsset({ ...scope, assetId: binding.assetId });
    if (!asset || asset.status !== "active" || !asset.currentVersionId) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", binding.assetId);
    const versionId = binding.versionPolicy === "fixed" ? binding.versionId! : asset.currentVersionId;
    try {
      inputs.push(await readUserAssetVersion({ ...scope, assetId: asset.assetId, versionId }));
    } catch (error) {
      if (error instanceof UserAssetError) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", binding.assetId);
      throw error;
    }
  }
  if (task.revision.output.mode !== "update") return { inputs, output: null };
  const asset = await getUserAsset({ ...scope, assetId: task.revision.output.assetId });
  if (!asset || asset.status !== "active" || !asset.currentVersion) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", task.revision.output.assetId);
  // `latest` means every run takes the head it actually read as its CAS
  // baseline. A revision's creation-time expectedVersionId must not pin all
  // future runs to an obsolete head after the first successful commit.
  const versionId = asset.currentVersionId;
  if (!versionId) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", asset.assetId);
  return { inputs, output: { assetId: asset.assetId, versionId, fileName: asset.currentVersion.fileName, mimeType: asset.currentVersion.mimeType } };
}

async function createStagingPath(scope: AutomationScope): Promise<string> {
  await ensureWorkspace({ userId: scope.userId, tenantId: scope.userId, projectId: scope.projectId });
  const root = resolveWorkspacePath(scope.userId);
  const stagingPath = await mkdtemp(path.join(root, ".generic-automation-run-"));
  await mkdir(path.join(stagingPath, "inputs"), { mode: 0o700 });
  return stagingPath;
}

async function defaultExecutor(input: Parameters<GenericAutomationExecutor>[0]): Promise<AcpResponse> {
  const message: AcpMessage = {
    id: input.run.runId,
    from: `automation:${input.task.taskId}`,
    timestamp: Date.now(),
    content: {
      type: "text",
      text: [
        "执行一个受控的通用自动化任务。",
        `任务说明：${input.task.revision.instruction}`,
        `输入资产数量：${input.inputs.length}。输入仅位于受控 inputs 目录。`,
        `输出策略：${JSON.stringify(input.task.revision.output)}`,
        "最终回复必须是一个 JSON 对象：{summary:string, stagedOutput?:{fileName,mimeType,base64}, shouldNotify?:boolean}。output 不是 none 时 stagedOutput 必填；不得返回物理路径或调用写入工具。",
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
  const response = await createAgent().handleMessage(message);
  return parseStructuredAcpResponse(response);
}

/** The ACP client exposes customer text, so generic runs use a strict JSON
 * envelope in the final response to carry the service-owned staged output. */
function parseStructuredAcpResponse(response: AcpResponse): AcpResponse {
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

function assertAcpSucceeded(response: AcpResponse): void {
  if (response.data?.executionStatus === "failed") {
    throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", String(response.data.executionErrorCode || "ACP_TURN_FAILED"));
  }
}

function normalizeStructuredResult(response: AcpResponse, task: AutomationTaskRecord, output: ResolvedOutput): {
  summary: string;
  shouldNotify: boolean;
  stagedOutput?: { fileName: string; mimeType?: string; base64: string };
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
  if (!stagedRaw || typeof stagedRaw !== "object") throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput is required");
  const staged = stagedRaw as Record<string, unknown>;
  const fileName = String(staged.fileName || "").trim();
  const base64 = typeof staged.base64 === "string" ? staged.base64 : typeof staged.bytesBase64 === "string" ? staged.bytesBase64 : "";
  if (!fileName || !isStrictBase64(base64)) throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput fileName/base64 is invalid");
  if (task.revision.output.mode === "create" && fileName !== task.revision.output.fileName) throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput fileName does not match output policy");
  if (task.revision.output.mode === "update" && (!output || fileName !== output.fileName)) throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput fileName does not match update target");
  return { summary: summary || "自动化运行完成。", shouldNotify, stagedOutput: { fileName, mimeType: typeof staged.mimeType === "string" ? staged.mimeType : undefined, base64 } };
}

async function commitOutput(scope: AutomationScope, task: AutomationTaskRecord, run: AutomationTaskRunRecord, result: ReturnType<typeof normalizeStructuredResult>, resolved: ResolvedOutput): Promise<{ assetId: string; versionId: string; checksum: string } | null> {
  if (!result.stagedOutput || task.revision.output.mode === "none") return null;
  const bytes = Buffer.from(result.stagedOutput.base64, "base64");
  const idempotencyKey = `automation:${run.runId}:output`;
  try {
    const descriptor = task.revision.output.mode === "create"
      ? await createUserAsset({
          ...scope,
          name: task.revision.output.titleTemplate || task.revision.name,
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
          assetId: task.revision.output.assetId,
          fileName: result.stagedOutput.fileName,
          mimeType: result.stagedOutput.mimeType,
          bytes,
          expectedVersionId: resolved?.versionId,
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
