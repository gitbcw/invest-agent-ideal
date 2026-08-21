import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { logger } from "../lib/logger.js";

import { createRuntimeAgent } from "../runtime/agent.js";
import type { AgentMessage, AgentResponse } from "../runtime/protocol.js";
import { OUTPUT_VOLUME_POLICY } from "../runtime/spreadsheet-output-policy.js";
import { serverTimeFact } from "../runtime/mobile-prompt.js";
import { ACTIVE_BACKEND } from "../lib/data-backend.js";
import { ensureWorkspace, resolveWorkspacePath } from "../lib/workspace.js";
import { resolveRegisteredMastraProjectRoot } from "../mastra/workspace-registry.js";
import { enqueuePushJob } from "./push-queue.js";
import {
  activateAutomationTask,
  assertAutomationTaskRunLease,
  bindAutomationTaskRunAssets,
  claimAutomationTaskRun,
  finalizeAutomationTaskRunInTransaction,
  finishAutomationTaskRun,
  getAutomationTask,
  instantiateMonthlyFileName,
  updateAutomationTask,
  updateAutomationTaskRunDelivery,
  AutomationTaskError,
  type AutomationScope,
  type AutomationTaskRecord,
  type AutomationTaskRunRecord,
} from "./automation-tasks.js";
import { classifyTaskError, executionResponseError, type TaskErrorInfo } from "./task-execution.js";
import { appendRowsToXlsxBytes, writeAutomationSpreadsheetHelper } from "./automation-spreadsheet.js";
import {
  createUserAsset,
  findActiveAssetByFileName,
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
  monthlyRollover?: MonthlyRollover | null;
  executionDeadlineAt: string | null;
  signal: AbortSignal;
}) => Promise<AgentResponse>;

export type GenericAutomationRunResult = {
  run: AutomationTaskRunRecord;
  conversationId?: string;
  task: AutomationTaskRecord;
};

type ResolvedOutput = { assetId: string; versionId: string; fileName: string; mimeType: string } | null;
type MonthlyRollover = { targetFileName: string; boundFileName: string };
type ResolvedBindings = {
  inputs: UserAssetBytes[];
  output: ResolvedOutput;
  agentUpdateTargets: Map<string, NonNullable<ResolvedOutput>>;
  writableTargets: Array<NonNullable<ResolvedOutput>>;
  /** T-317: set when an update-mode task declares a monthly rollover and the
   * bound target is not this month's file; the agent must create the target. */
  monthlyRollover: MonthlyRollover | null;
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
  executionDeadlineAt?: string;
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
    executionDeadlineAt: input.executionDeadlineAt,
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
    const deadlineController = new AbortController();
    const executionDeadlineAt = boundRun.executionDeadlineAt ?? null;
    const deadlineMs = executionDeadlineAt ? Date.parse(executionDeadlineAt) : Number.NaN;
    const remainingMs = Number.isFinite(deadlineMs) ? deadlineMs - Date.now() : Number.POSITIVE_INFINITY;
    if (remainingMs <= 0) deadlineController.abort(new Error("AUTOMATION_RUN_EXECUTION_DEADLINE_EXCEEDED"));
    const deadlineTimer = Number.isFinite(remainingMs)
      ? setTimeout(() => deadlineController.abort(new Error("AUTOMATION_RUN_EXECUTION_DEADLINE_EXCEEDED")), remainingMs)
      : undefined;
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
        monthlyRollover: resolved.monthlyRollover,
        executionDeadlineAt,
        signal: deadlineController.signal,
      });
      assertAgentSucceeded(response);
      await assertAutomationTaskRunLease({ ...input.scope, runId: run.runId, leaseToken: run.leaseToken });
      const result = await normalizeStructuredResult(response, task, resolved, input.scope, stagingPath);
      const output = await commitOutput(input.scope, task, run, result, resolved);
      if (resolved.monthlyRollover && output && result.stagedOutput?.operation === "create") {
        await rollTaskBindingToMonthlyFile(input.scope, task, resolved.monthlyRollover, output.assetId);
      }
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
      if (deadlineTimer) clearTimeout(deadlineTimer);
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
    if (!asset || asset.status !== "active" || !asset.currentVersionId) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", `${binding.assetId}: ASSET_INACTIVE`);
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
      // Keep the underlying cause (e.g. ASSET_INVALID_CONTENT) visible for
      // diagnosis instead of flattening every read failure to a binding error.
      if (error instanceof UserAssetError) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", `${binding.assetId}: ${error.code}: ${error.message.slice(0, 120)}`);
      throw error;
    }
  }
  if (task.revision.output.mode !== "update") {
    return {
      inputs,
      output: null,
      agentUpdateTargets,
      writableTargets: [...agentUpdateTargets.values()],
      monthlyRollover: null,
    };
  }
  const outputPolicy = task.revision.output;
  const boundAsset = await getUserAsset({ ...scope, assetId: outputPolicy.assetId });
  if (!boundAsset || boundAsset.status !== "active" || !boundAsset.currentVersion) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", `${outputPolicy.assetId}: ASSET_INACTIVE`);
  // `latest` means every run takes the head it actually read as its CAS
  // baseline. A revision's creation-time expectedVersionId must not pin all
  // future runs to an obsolete head after the first successful commit.
  const versionId = boundAsset.currentVersionId;
  if (!versionId) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", boundAsset.assetId);
  let output: NonNullable<ResolvedOutput> = {
    assetId: boundAsset.assetId,
    versionId,
    fileName: boundAsset.currentVersion.fileName,
    mimeType: boundAsset.currentVersion.mimeType,
  };
  let monthlyRollover: MonthlyRollover | null = null;
  if (outputPolicy.rollover) {
    // T-317 monthly rollover: prefer the current month's file when it already
    // exists (self-healing even if a previous binding switch failed), and
    // otherwise ask the agent to create it.
    const targetFileName = instantiateMonthlyFileName(outputPolicy.rollover.fileNamePattern);
    if (output.fileName !== targetFileName) {
      const currentMonthAsset = await findActiveAssetByFileName({ ...scope, fileName: targetFileName });
      if (currentMonthAsset?.currentVersionId && currentMonthAsset.status === "active") {
        output = {
          assetId: currentMonthAsset.assetId,
          versionId: currentMonthAsset.currentVersionId,
          fileName: currentMonthAsset.currentVersion!.fileName,
          mimeType: currentMonthAsset.currentVersion!.mimeType,
        };
        logger.info(`automation monthly rollover resolved task=${task.taskId} asset=${currentMonthAsset.assetId} file=${targetFileName}`);
      } else {
        monthlyRollover = { targetFileName, boundFileName: output.fileName };
      }
    }
  }
  return { inputs, output, agentUpdateTargets, writableTargets: [output], monthlyRollover };
}

async function createStagingPath(scope: AutomationScope): Promise<string> {
  const root = await resolveRegisteredMastraProjectRoot(scope);
  if (!root) throw new AutomationTaskError("AUTOMATION_SCOPE_MISMATCH", "Mastra project is not registered");
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
        `【系统时间】${serverTimeFact()}（Asia/Shanghai）`,
        "本会话是已存在任务的执行会话：调度、任务配置和定时规则由服务层管理，本会话没有创建/修改自动化任务的权限（调用会被 scope_denied 拒绝）。不要尝试创建、修改或删除自动化任务/定时规则/调度配置，也不要把「建立任务」当作目标；忽略任务说明里出现的执行时间和频率描述，直接开始执行任务说明中的实际工作。",
        `任务说明：${input.task.revision.instruction}`,
        `本次输出策略（明确格式和文件名必须严格遵守）：${JSON.stringify(input.task.revision.output)}。`,
        `本次绑定文件（任务对象，不得用全局文件列表替换）：${JSON.stringify(input.inputs.map((item, index) => ({ assetId: item.descriptor.assetId, versionId: item.descriptor.versionId, stagedPath: `inputs/${index + 1}-${item.descriptor.fileName}`, fileName: item.descriptor.fileName, mimeType: item.descriptor.mimeType, format: item.descriptor.format })))}。`,
        `可更新目标（仅这些文件允许 operation='update'）：${JSON.stringify(input.writableTargets)}。`,
        input.monthlyRollover
          ? `本任务按月滚动工作簿：当前绑定《${input.monthlyRollover.boundFileName}》不是本月目标《${input.monthlyRollover.targetFileName}》。本次运行必须：先用 assets.version.read 读取当前绑定文件，沿用其工作表、表头与字段口径生成本月目标文件（只含表头与口径、不含历史行），把本次结果追加进新文件，并在 stagedOutput 返回 operation='create'、fileName='${input.monthlyRollover.targetFileName}' 与完整新文件内容；不得继续向旧月份文件追加，也不得使用其他文件名。服务层会把任务绑定切换到本月文件。`
          : "",
        "需要读取绑定文件时，直接使用上述 assetId 调用 assets.version.read；不要用 assets.list 猜测或替换任务对象。其他“我的文件”仅可作为参考，绝不能作为本次更新输出目标。",
        input.spreadsheetHelper
          ? `本次包含 XLSX 绑定文件。若本次变更是向绑定工作簿的某个工作表表尾追加数据行（最常见情形），不要调用 spreadsheet.transform，直接在最终 stagedOutput 返回 {operation:'appendRows', sheet:'工作表名'（工作簿只有一个工作表时可省略）, rows:[[每行各列的值],…]（必须是二维数组：外层=行，内层=单元格，列序与表头一致）, skipIfCellMatches:{column:判重列号(从1起), value:'判重值'}（用于避免同一交易日重复追加；先读取绑定文件确认当日行是否已存在）}，服务层会确定性地追加到表尾并提交新版本，不需要你生成或搬运文件。只有需要修改表头、格式或既有单元格等非追加变更时，才使用 spreadsheet.transform 工具生成更新后的工作簿（inputPath 必须用上面 stagedPath 字段的精确值，outputPath 为暂存目录内的新文件名，changes 的合法操作与期望形状见工具 schema 及其报错提示），然后在 stagedOutput 返回 {operation:'update', assetId: 可更新目标的 assetId, fileName: 可更新目标的原文件名（不得改名）, filePath: transform 的 outputPath}。执行环境不能运行本地脚本，暂存目录中的 automation-sheet.mjs 仅供参考、无法执行；不要把 XLSX 当文本编辑，也不要声称没有电子表格处理能力。transform 失败时按返回的 error 信息修正参数后重试，不要放弃更新。`
          : "本次没有 XLSX 文件，不需要电子表格处理。",
        `结果数量与表格文件规则：${OUTPUT_VOLUME_POLICY}`,
        "默认按可用数据完成任务：除非用户或任务明确要求指定来源一致、对账、审计或逐项严格核验，否则公开来源中包含指标名称、具体数值和日期/时间的结果即可写入文件，即使尚未完成第二次独立核验；必须保留实际来源、时间、口径差异并标明“未独立核验”。若经过合理检索仍没有任何可用数值，且任务没有明确要求记录维护状态，就保持原文件不变、显式返回 outputSkipped:true 并在 summary 说明原因；不得为了证明执行过而写入空值、零值、估算值或无意义状态行。",
        input.task.revision.output.mode === "none"
          ? "最终回复必须是一个 JSON 对象：{summary:string, shouldNotify?:boolean}。本任务不产出文件资产：最终 JSON 里禁止出现 stagedOutput 字段（出现会导致运行被判无效）；一切结果都写入 summary。若任务过程中确需留档，用任务说明允许的领域工具（如 reviews.save）完成，不要用 stagedOutput。"
          : "最终回复必须是一个 JSON 对象：{summary:string, stagedOutput?:{operation:'appendRows'|'update'|'create', …}, shouldNotify?:boolean, outputSkipped?:boolean}。向绑定工作簿表尾追加数据行时优先用 operation:'appendRows'（只带 sheet/rows/skipIfCellMatches，不携带文件内容）；生成完整新文件时优先调用 spreadsheet.create 在当前暂存目录生成 XLSX，并原样返回工具结果里的 stagedOutput；自行生成 XLSX/CSV 时必须返回 {operation:'create', fileName:'带扩展名的文件名', filePath:'暂存目录内的相对路径'}，fileName 和 filePath 缺一不可，不得使用绝对路径或越出暂存目录。只有小型文本结果才使用 base64。更新绑定文件时提供 operation='update'、对应 assetId；仅在任务确有必要新建文件时提供 operation='create'。若本次运行确定无需修改绑定文件（如数据缺失、当日行已存在），必须显式返回 outputSkipped:true 并在 summary 说明原因；缺少 stagedOutput 又未声明 outputSkipped 的运行会被判为失败。",
        ...(input.task.revision.delivery.mode === "none"
          ? []
          : [
              // summary doubles as the WeChat push body for delivery-enabled
              // tasks (a0f7997 covered the legacy scheduler prompts only).
              "本任务的结果会推送微信：summary 会直接作为微信消息正文发送给用户，必须使用适合微信阅读且可由微信渲染的简洁 Markdown；使用 `**重点**` 和清晰分段，并按内容需要使用列表或短标题，不要写成无格式的连续纯文本；禁止输出 Markdown 表格（微信不渲染表格）。若按任务约定本轮不推送（如输出 NO_PUSH），summary 简要说明原因即可。",
            ]),
      ].join("\n"),
    },
    context: {
      // Automation runs are not conversations: a distinct channel keeps them
      // out of the conversation audit scope and any channel-based stats.
      channel: "automation",
      conversationId: `automation-run:${input.run.runId}`,
      userId: input.scope.userId,
      projectId: input.scope.projectId,
      instanceId: input.scope.instanceId,
      workspacePath: input.stagingPath,
      taskType: input.task.taskType ?? "scheduled-automation",
      _executionDeadlineAt: input.executionDeadlineAt,
      _cancelSignal: input.signal,
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

async function normalizeStructuredResult(response: AgentResponse, task: AutomationTaskRecord, resolved: ResolvedBindings, scope: AutomationScope, stagingPath: string): Promise<{
  summary: string;
  shouldNotify: boolean;
  outputSkipped?: boolean;
  stagedOutput?: { operation: "create" | "update"; assetId?: string; fileName: string; mimeType?: string; base64: string };
}> {
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
    // The domain output (e.g. a saved review) may already be persisted by the
    // agent; an unexpected stagedOutput must not fail the whole run (T-324).
    if (stagedRaw !== undefined) {
      logger.warn(`automation run ignored stagedOutput under output.mode=none task=${task.taskId} keys=${Object.keys(stagedRaw as object).join(",")}`);
    }
    return { summary: summary || "自动化运行完成。", shouldNotify };
  }
  if (!stagedRaw || typeof stagedRaw !== "object") {
    if (task.revision.output.mode === "create") {
      throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput is required for a required file");
    }
    // A bound update target with no new version must be an explicit decision,
    // never a silent success: the 2026-08-19 industry-review loss was a run
    // marked succeeded while the workbook stayed untouched.
    if (task.revision.output.mode === "update" && data.outputSkipped !== true) {
      throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput is required for update tasks unless the run explicitly reports outputSkipped:true with the reason in summary");
    }
    return { summary: summary || "自动化运行完成，未修改文件。", shouldNotify, ...(data.outputSkipped === true ? { outputSkipped: true } : {}) };
  }
  const staged = stagedRaw as Record<string, unknown>;
  if (staged.operation === "appendRows") {
    return await normalizeAppendRowsResult(staged, task, resolved, scope, { summary, shouldNotify });
  }
  const fileName = String(staged.fileName || "").trim();
  let base64 = typeof staged.base64 === "string" ? staged.base64 : typeof staged.bytesBase64 === "string" ? staged.bytesBase64 : "";
  const filePath = typeof staged.filePath === "string" ? staged.filePath.trim() : "";
  if (!base64 && filePath) {
    if (path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath) || filePath.includes("\0")) {
      throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput filePath is invalid");
    }
    const root = await realpath(stagingPath);
    const candidate = await realpath(path.resolve(stagingPath, filePath)).catch(() => "");
    if (!candidate || (candidate !== root && !candidate.startsWith(`${root}${path.sep}`))) {
      throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput filePath is outside staging");
    }
    base64 = (await readFile(candidate)).toString("base64");
  }
  if (!fileName || !isStrictBase64(base64)) throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput fileName/base64 is invalid");
  const outputPolicy = task.revision.output;
  // T-317 monthly rollover: when the bound target is not this month's file,
  // the agent may create exactly the monthly target instead of updating.
  const rolloverCreate = outputPolicy.mode === "update"
    && outputPolicy.rollover !== undefined
    && resolved.monthlyRollover !== null
    && staged.operation === "create";
  if (rolloverCreate && fileName !== resolved.monthlyRollover!.targetFileName) {
    throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", `stagedOutput fileName must be the monthly target ${resolved.monthlyRollover!.targetFileName}`);
  }
  const operation = outputPolicy.mode === "agent"
    ? staged.operation
    : rolloverCreate
      ? "create"
      : outputPolicy.mode;
  if (operation !== "create" && operation !== "update") {
    throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput operation is invalid");
  }
  const assetId = typeof staged.assetId === "string" ? staged.assetId : undefined;
  if (outputPolicy.mode === "create" && fileName !== outputPolicy.fileName) throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput fileName does not match output policy");
  if (outputPolicy.mode === "update" && !rolloverCreate && (!resolved.output || assetId !== resolved.output.assetId || !matchesCurrentSpreadsheetName(fileName, resolved.output.fileName))) throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput update target is invalid");
  if (task.revision.output.mode === "agent" && operation === "update") {
    const target = assetId ? resolved.agentUpdateTargets.get(assetId) : undefined;
    if (!target || !matchesCurrentSpreadsheetName(fileName, target.fileName)) throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput update target is invalid");
  }
  return { summary: summary || "自动化运行完成。", shouldNotify, stagedOutput: { operation, ...(assetId ? { assetId } : {}), fileName, mimeType: typeof staged.mimeType === "string" ? staged.mimeType : undefined, base64 } };
}

/**
 * Declarative append path (2026-08-19 industry-review fix): the agent returns
 * only the row data — {operation:'appendRows', sheet?, rows, skipIfCellMatches?}
 * — and the service deterministically appends to the bound workbook's current
 * version. This removes the spreadsheet.transform parameter envelope that
 * agents guessed wrong on ~5-7 calls per run.
 */
async function normalizeAppendRowsResult(
  staged: Record<string, unknown>,
  task: AutomationTaskRecord,
  resolved: ResolvedBindings,
  scope: AutomationScope,
  current: { summary: string; shouldNotify: boolean },
): Promise<Awaited<ReturnType<typeof normalizeStructuredResult>>> {
  const outputPolicy = task.revision.output;
  if (outputPolicy.mode !== "update" || !resolved.output) {
    throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput appendRows is only valid for update tasks with a bound workbook; use operation 'update' or 'create'");
  }
  if (resolved.monthlyRollover) {
    throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", `appendRows cannot target the stale monthly file 《${resolved.monthlyRollover.boundFileName}》; create this month's 《${resolved.monthlyRollover.targetFileName}》 with operation 'create' instead`);
  }
  if (!resolved.output.fileName.toLowerCase().endsWith(".xlsx")) {
    throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "stagedOutput appendRows requires an XLSX workbook target; use spreadsheet.transform for other formats");
  }
  const sheet = typeof staged.sheet === "string" && staged.sheet.trim() ? staged.sheet.trim() : undefined;
  const rows = staged.rows;
  const skipIfCellMatches = staged.skipIfCellMatches && typeof staged.skipIfCellMatches === "object"
    ? staged.skipIfCellMatches as { column?: unknown; value?: unknown }
    : undefined;
  const skip = skipIfCellMatches
    ? { column: Number(skipIfCellMatches.column), value: String(skipIfCellMatches.value ?? "") }
    : undefined;
  let outcome: Awaited<ReturnType<typeof appendRowsToXlsxBytes>>;
  try {
    const currentBytes = await readUserAssetVersion({ ...scope, assetId: resolved.output.assetId, versionId: resolved.output.versionId });
    outcome = await appendRowsToXlsxBytes({ bytes: currentBytes.bytes, sheet, rows: rows as unknown[][], skipIfCellMatches: skip });
  } catch (error) {
    throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", `appendRows failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (outcome.kind === "skipped") {
    const note = `已存在匹配行（${outcome.sheetName} 第 ${outcome.matchedRow} 行），未重复追加。`;
    return { summary: current.summary ? `${current.summary}（${note}）` : note, shouldNotify: current.shouldNotify, outputSkipped: true };
  }
  return {
    summary: current.summary || "自动化运行完成。",
    shouldNotify: current.shouldNotify,
    stagedOutput: {
      operation: "update" as const,
      assetId: resolved.output.assetId,
      fileName: resolved.output.fileName,
      mimeType: resolved.output.mimeType,
      base64: outcome.bytes.toString("base64"),
    },
  };
}

async function commitOutput(scope: AutomationScope, task: AutomationTaskRecord, run: AutomationTaskRunRecord, result: Awaited<ReturnType<typeof normalizeStructuredResult>>, resolved: ResolvedBindings): Promise<{ assetId: string; versionId: string; checksum: string } | null> {
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

/** After a rollover create commits, switch the task's output binding to the
 * new monthly asset. updateAutomationTask parks the task at paused (revision
 * semantics), so the switch immediately re-activates the schedule; if either
 * step fails we only log — the next run's resolveBindings self-heals onto the
 * new file by fileName, so a failed switch never breaks the schedule. */
async function rollTaskBindingToMonthlyFile(scope: AutomationScope, task: AutomationTaskRecord, rollover: MonthlyRollover, newAssetId: string): Promise<void> {
  if (task.revision.output.mode !== "update" || !task.revision.output.rollover) return;
  try {
    const updated = await updateAutomationTask({
      ...scope,
      taskId: task.taskId,
      expectedRevision: task.currentRevision,
      output: {
        mode: "update",
        assetId: newAssetId,
        versionPolicy: "latest",
        rollover: task.revision.output.rollover,
      },
    });
    await activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: updated.currentRevision });
    logger.info(`automation monthly rollover binding switched task=${task.taskId} asset=${newAssetId} file=${rollover.targetFileName}`);
  } catch (error) {
    logger.warn(`automation monthly rollover binding switch deferred task=${task.taskId}: ${(error as Error).message}`);
  }
}

async function deliverResult(scope: AutomationScope, task: AutomationTaskRecord, run: AutomationTaskRunRecord, result: Awaited<ReturnType<typeof normalizeStructuredResult>>): Promise<{ run: AutomationTaskRunRecord }> {
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
