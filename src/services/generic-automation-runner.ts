import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { logger } from "../lib/logger.js";

import { createRuntimeAgent } from "../runtime/agent.js";
import type { AgentMessage, AgentResponse } from "../runtime/protocol.js";
import { OUTPUT_VOLUME_POLICY } from "../runtime/spreadsheet-output-policy.js";
import { serverTimeFact } from "../runtime/mobile-prompt.js";
import { ACTIVE_BACKEND, portfolioBackend, watchlistBackend } from "../lib/data-backend.js";
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
import { hasReviewArtifactPublication } from "./conversation-artifacts.js";
import { classifyThinkingDepth } from "./thinking-depth-router.js";
import {
  appendRowsToXlsxBytes,
  inspectAutomationXlsx,
  writeAutomationSpreadsheetHelper,
  type AutomationSpreadsheetInspection,
} from "./automation-spreadsheet.js";
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
  spreadsheetContext?: GenericAutomationSpreadsheetContext[];
  xlsxAppendOnly?: boolean;
  monthlyRollover?: MonthlyRollover | null;
  executionDeadlineAt: string | null;
  signal: AbortSignal;
  /** 自纠重试上下文（B 方案）：上一轮回复 + 验证器报错，模型在此基础上修复。 */
  repairContext?: { previousReply: string; validationError: string };
}) => Promise<AgentResponse>;

export type GenericAutomationRunResult = {
  run: AutomationTaskRunRecord;
  conversationId?: string;
  task: AutomationTaskRecord;
};

type ResolvedOutput = { assetId: string; versionId: string; fileName: string; mimeType: string } | null;
type MonthlyRollover = { targetFileName: string; boundFileName: string };
export type GenericAutomationSpreadsheetContext = AutomationSpreadsheetInspection & {
  assetId: string;
  versionId: string;
  fileName: string;
};
export type GenericAutomationReviewTarget = {
  kind: "daily" | "weekly" | "monthly";
  reportKey: string;
  conversationId: string;
};
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

/**
 * Generic runs use an explicit service-tool allowlist.  Keep this list small:
 * the runner already owns task lookup, binding resolution and durable output
 * commits, so the ACP session has no reason to discover automations, inspect
 * conversation confirmations, or patrol watch rules.
 */
export const GENERIC_AUTOMATION_TOOL_ALLOWLIST = [
  // market_watch.snapshot 已摘除（2026-08-28）：冻结的历史快照会被盘中任务
  // 误当作行情事实；实时行情由外部 market-data MCP 工具集提供。
  "file.parse",
  "research.news_search",
  "research.web_search",
  "research.web_read",
  "assets.version.read",
  "portfolio.read",
  "watchlist.read",
  "plans.read",
  "spreadsheet.create",
] as const;

const GENERIC_AUTOMATION_CONTEXT_TASK_TYPE = "automation-execution";

const MARKET_WATCH_TASK_TYPE = "scheduled-market-watch";

/**
 * 2026-08-31 dyk 事件：market-watch 某轮跳过 portfolio.read，凭板块先验自选了
 * 000001（平安银行）/000688（国城矿业）当用户持仓行情推送（价格真实、股票错
 * 位，且与用户实际持仓同板块，极具迷惑性）。个股宇宙改为服务端确定性注入（与
 * portfolio.read / watchlist.read 同源）；模型只消费清单，不再依赖自觉取数。
 * 读取失败时显式标注缺口而非静默省略——静默省略会把洞重新留给模型自选。
 */
export async function buildMarketWatchUniverseFact(scope: AutomationScope): Promise<string> {
  const [holdings, watchlist] = await Promise.all([
    portfolioBackend.listActive(scope.userId, scope.instanceId).catch(() => null),
    watchlistBackend.list(scope.userId, scope.instanceId).catch(() => null),
  ]);
  if (!holdings || !watchlist) {
    return [
      "【持仓事实（服务端注入）】持仓/观察仓读取失败。",
      "简报必须如实说明持仓数据缺口；禁止自行挑选任何个股充当持仓或观察仓行情。",
    ].join("\n");
  }
  const brief = (rows: Array<{ code: string; name: string }>) =>
    rows.length > 0 ? rows.map((row) => `${row.name}(${row.code})`).join("、") : "无";
  return [
    "【持仓事实（服务端注入，与 portfolio.read/watchlist.read 同源；括号内为 6 位代码，可直接用于行情查询）】",
    `持仓：${brief(holdings)}`,
    `观察仓：${brief(watchlist)}`,
    "作为持仓/观察仓行情出现的个股只能是上述清单内的标的；清单为「无」时如实说明，禁止自行挑选清单外个股补位。",
  ].join("\n");
}
// 2026-08-26：10 -> 30。无批量接口的数据维度（如单股筹码 get_stock_profile）在
// 10 次预算内对多标的任务结构性无解（13 只持仓 = 13 次调用），agent 只能整列标缺失。
// 时间侧仍有总截止/租约/单次尝试超时兜底，调高次数不会放大执行时长上限。
// 共创期不设限观测（owner 2026-08-27）：AUTOMATION_UNLIMITED=1 仅注入评测进程，
// 放宽到观测级；生产 .env 不设该变量，行为不变。
const UNLIMITED_EVAL = process.env.AUTOMATION_UNLIMITED === "1";
const GENERIC_AUTOMATION_MAX_TOOL_CALLS = UNLIMITED_EVAL ? 200 : 30;
// 2026-08-27：480s → 570s，与 runtime/agent.ts 的 INTERNAL_AUTOMATION_ATTEMPT_TIMEOUT_MS
// 同步（glm-5.3-flash 三步实测 ~480s 差 90s 被掐；570+300+30=900 恰满租约）。
const GENERIC_AUTOMATION_ATTEMPT_TIMEOUT_MS = UNLIMITED_EVAL ? 3_600_000 : 570_000;
const GENERIC_AUTOMATION_FALLBACK_RESERVE_MS = UNLIMITED_EVAL ? 600_000 : 300_000;
// 自纠重试（B 方案）：报错回喂一次修复机会的预算下限与上一轮回复回喂上限。
const GENERIC_AUTOMATION_REPAIR_MIN_REMAINING_MS = 240_000;
const GENERIC_AUTOMATION_REPAIR_MAX_REPLY_CHARS = 60_000;
const GENERIC_AUTOMATION_COMMIT_RESERVE_MS = 30_000;

export function resolveGenericAutomationToolAllowlist(
  task: Pick<AutomationTaskRecord, "taskType">,
  options: { xlsxAppendOnly?: boolean } = {},
): string[] {
  const allowed: string[] = [...GENERIC_AUTOMATION_TOOL_ALLOWLIST];
  // Ordinary table-tail appends use the runner's declarative appendRows path;
  // spreadsheet.transform remains available for explicit cell/format edits
  // and monthly rollover creation.
  if (!options.xlsxAppendOnly) allowed.push("spreadsheet.transform");
  // Typed review tasks still publish through the service-owned final action.
  // It is the only additional capability they receive; generic file tasks do
  // not need to see reviews.save at all.
  if (task.taskType === "scheduled-daily-review"
    || task.taskType === "scheduled-weekly-review"
    || task.taskType === "scheduled-monthly-review") {
    allowed.push("reviews.save");
  }
  return allowed;
}

/**
 * Reserve only the terminal commit time from the ACP deadline. Fallback is
 * checked against this same total agent deadline by the runtime, while each
 * individual model attempt has its own shorter timeout.
 */
export function resolveGenericAutomationAgentDeadline(executionDeadlineAt: string | null): string | null {
  if (!executionDeadlineAt) return null;
  const deadlineMs = Date.parse(executionDeadlineAt);
  if (!Number.isFinite(deadlineMs)) return executionDeadlineAt;
  return new Date(deadlineMs - GENERIC_AUTOMATION_COMMIT_RESERVE_MS).toISOString();
}

function shanghaiDate(value: string | null | undefined): string {
  const parsed = value ? new Date(value) : new Date();
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function resolveGenericAutomationReviewTarget(
  task: Pick<AutomationTaskRecord, "taskType">,
  run: Pick<AutomationTaskRunRecord, "scheduledFor" | "claimedAt" | "userId" | "instanceId">,
): GenericAutomationReviewTarget | null {
  const kind = task.taskType === "scheduled-daily-review"
    ? "daily"
    : task.taskType === "scheduled-weekly-review"
      ? "weekly"
      : task.taskType === "scheduled-monthly-review"
        ? "monthly"
        : null;
  if (!kind) return null;
  const date = shanghaiDate(run.scheduledFor ?? run.claimedAt);
  const reportKey = kind === "daily" ? date : kind === "weekly" ? `${date}_weekly` : date.slice(0, 7);
  return {
    kind,
    reportKey,
    conversationId: `scheduler:${kind}-review:${run.userId}:${run.instanceId}`,
  };
}

function isXlsxAsset(fileName: string, format?: string): boolean {
  return format === "xlsx" || fileName.toLowerCase().endsWith(".xlsx");
}

function isXlsxAppendOnlyTask(task: AutomationTaskRecord, resolved: ResolvedBindings): boolean {
  if (task.revision.output.mode !== "update" || !resolved.output || !isXlsxAsset(resolved.output.fileName)) return false;
  if (task.revision.output.rollover || resolved.monthlyRollover) return false;
  const instruction = task.revision.instruction.toLowerCase();
  const hasAppendIntent = /(表尾|追加|新增行|新增数据|append\s*rows?|append-only|table\s*tail)/i.test(instruction);
  if (!hasAppendIntent) return false;
  // Keep transform for explicit structural/cell edits and rollover tasks,
  // even when their instruction also mentions appending rows.
  return !/(rollover|roll\s*over|滚动|切月|月度|表头|格式|单元格|改列|改表|重命名|合并|冻结|筛选|结构|创建|新建|transform|setcells|createSheets|renameSheets)/i.test(instruction);
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
      const spreadsheetContext = usesXlsx
        ? await resolveSpreadsheetContext(input.scope, resolved)
        : undefined;
      const xlsxAppendOnly = isXlsxAppendOnlyTask(task, resolved);
      const reviewTarget = resolveGenericAutomationReviewTarget(task, boundRun);
      const response = await (input.executor || defaultExecutor)({
        scope: input.scope,
        task,
        run: boundRun,
        stagingPath,
        inputs: resolved.inputs,
        writableTargets: resolved.writableTargets,
        spreadsheetHelper,
        spreadsheetContext,
        xlsxAppendOnly,
        monthlyRollover: resolved.monthlyRollover,
        executionDeadlineAt,
        signal: deadlineController.signal,
      });
      assertAgentSucceeded(response);
      if (reviewTarget && !hasReviewArtifactPublication({
        ...input.scope,
        ...reviewTarget,
        updatedAfter: boundRun.claimedAt,
      })) {
        throw new AutomationTaskError(
          "AUTOMATION_RUN_INVALID_RESULT",
          `REVIEW_ARTIFACT_NOT_PUBLISHED:${reviewTarget.kind}:${reviewTarget.reportKey}`,
        );
      }
      await assertAutomationTaskRunLease({ ...input.scope, runId: run.runId, leaseToken: run.leaseToken });
      let result;
      try {
        result = await normalizeStructuredResult(response, task, resolved, input.scope, stagingPath);
      } catch (validationError) {
        // 自纠重试（owner 2026-08-27 B 方案）：验证器报错回喂模型，在其上一轮
        // 输出基础上修复后重新提交，一次机会。只救 AUTOMATION_RUN_INVALID_RESULT
        //（巨型 JSON 括号失配、列数不符等契约违规）；超时/租约/权限类不重试。
        // 无 executionDeadlineAt 意味着预算无限（scheduled 路径不设截止），不是
        // 拒绝重试的理由——原 Number.isFinite 判断曾把生产 scheduled 轮的全部
        // 重试都挡掉（T-376）。
        if (!(validationError instanceof AutomationTaskError) || validationError.code !== "AUTOMATION_RUN_INVALID_RESULT") throw validationError;
        const previousReply = response.content?.text?.trim() ?? "";
        const remainingMs = executionDeadlineAt ? Date.parse(executionDeadlineAt) - Date.now() : Number.POSITIVE_INFINITY;
        if (!previousReply || Number.isNaN(remainingMs) || remainingMs < GENERIC_AUTOMATION_REPAIR_MIN_REMAINING_MS) {
          // T-376（dyk 8-25 / mg 8-26·8-27 连续失败）：shouldNotify 是服务层可
          // 自决的投递开关，缺省不推送与 wechat_on_condition 的 exception_only
          // 语义一致。重试不可行时不再让整轮数据工作被判失败，宽容归一化收尾。
          if (isShouldNotifyValidationError(validationError)) {
            result = await normalizeStructuredResult(response, task, resolved, input.scope, stagingPath, { lenientShouldNotify: true });
          } else throw validationError;
        } else {
        logger.warn(`自动化自纠重试 task=${task.taskId} code=${validationError.code} 剩余预算=${Math.round(remainingMs / 1000)}s 报错=${validationError.message.slice(0, 140)}`);
        const repairResponse = await (input.executor || defaultExecutor)({
          scope: input.scope,
          task,
          run: boundRun,
          stagingPath,
          inputs: resolved.inputs,
          writableTargets: resolved.writableTargets,
          spreadsheetHelper,
          spreadsheetContext,
          xlsxAppendOnly,
          monthlyRollover: resolved.monthlyRollover,
          executionDeadlineAt,
          signal: deadlineController.signal,
          repairContext: { previousReply: previousReply.slice(0, GENERIC_AUTOMATION_REPAIR_MAX_REPLY_CHARS), validationError: validationError.message },
        });
        assertAgentSucceeded(repairResponse);
        await assertAutomationTaskRunLease({ ...input.scope, runId: run.runId, leaseToken: run.leaseToken });
        try {
          result = await normalizeStructuredResult(repairResponse, task, resolved, input.scope, stagingPath);
        } catch (retryError) {
          // T-376：重试后仍缺 shouldNotify 时宽容缺省不推送，run 落 suppressed
          // 而非 failed；其他契约违规维持失败闭环。
          if (isShouldNotifyValidationError(retryError)) {
            result = await normalizeStructuredResult(repairResponse, task, resolved, input.scope, stagingPath, { lenientShouldNotify: true });
          } else throw retryError;
        }
        }
      }
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

async function resolveSpreadsheetContext(scope: AutomationScope, resolved: ResolvedBindings): Promise<GenericAutomationSpreadsheetContext[]> {
  const candidates = new Map<string, { assetId: string; versionId: string; fileName: string; bytes: Uint8Array }>();
  for (const item of resolved.inputs) {
    if (!isXlsxAsset(item.descriptor.fileName, item.descriptor.format)) continue;
    candidates.set(`${item.descriptor.assetId}:${item.descriptor.versionId}`, {
      assetId: item.descriptor.assetId,
      versionId: item.descriptor.versionId,
      fileName: item.descriptor.fileName,
      bytes: item.bytes,
    });
  }
  if (resolved.output && isXlsxAsset(resolved.output.fileName)) {
    const key = `${resolved.output.assetId}:${resolved.output.versionId}`;
    if (!candidates.has(key)) {
      const output = await readUserAssetVersion({
        ...scope,
        assetId: resolved.output.assetId,
        versionId: resolved.output.versionId,
      });
      candidates.set(key, {
        assetId: output.descriptor.assetId,
        versionId: output.descriptor.versionId,
        fileName: output.descriptor.fileName,
        bytes: output.bytes,
      });
    }
  }
  const contexts: GenericAutomationSpreadsheetContext[] = [];
  for (const candidate of candidates.values()) {
    const inspection = await inspectAutomationXlsx(candidate.bytes);
    contexts.push({
      assetId: candidate.assetId,
      versionId: candidate.versionId,
      fileName: candidate.fileName,
      ...inspection,
    });
  }
  return contexts;
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
  const agentDeadlineAt = resolveGenericAutomationAgentDeadline(input.executionDeadlineAt);
  const toolAllowlist = resolveGenericAutomationToolAllowlist(input.task, { xlsxAppendOnly: input.xlsxAppendOnly });
  // Operator/replay pin (mgreplay 2026-08-27): set GENERIC_AUTOMATION_MODEL in the
  // process env to lock the run's model instead of routing the auto chain. Not
  // part of any production .env; the runtime treats an explicit context.model as
  // a user-selection lock (no in-turn auto fallback).
  const pinnedModel = process.env.GENERIC_AUTOMATION_MODEL?.trim() || "";
  const reviewTarget = resolveGenericAutomationReviewTarget(input.task, input.run);
  // 思考深度路由（owner 2026-08-27 扩展到自动化轮）：每轮用任务指令重判一次
  //（指令稳定，但规则集会随 bad case 进化）。决策经 context 传给 runtime，
  // 仅当自动链落点为 glm-5.3-flash 时升级到深度别名；裁判失败 fail-open low。
  // 【确定性守卫·T-396 过渡机制】输出模式为 update/create 的契约任务直接 low，
  // 不问裁判：实盘三次实测（8-27）裁判在「逐股推算 vs 写表契约」边界反复翻转
  //（low/high/low/high），规则集锚定例句无效；且 F1 实验证据表明契约任务
  // 深度越高违约率越高。T-396 根治（裁判确定性）落地后移除此守卫恢复全量裁判。
  const contractOutputMode = input.task.revision.output.mode === "update" || input.task.revision.output.mode === "create";
  const thinkingDecision = contractOutputMode
    ? { depth: "low" as const, reason: "输出契约任务·确定性守卫(T-396过渡)" }
    : await classifyThinkingDepth({
        text: `${input.task.revision.name}\n${input.task.revision.instruction}\n输出模式: ${JSON.stringify(input.task.revision.output)}`,
        mode: "automation",
      });
  logger.info(`思考深度路由(automation) task=${input.task.taskId} depth=${thinkingDecision.depth} reason=${thinkingDecision.reason}`);
  const spreadsheetContextText = input.spreadsheetContext && input.spreadsheetContext.length > 0
    ? `服务端已确定性解析绑定 XLSX 结构（不要猜测）：${JSON.stringify(input.spreadsheetContext)}`
    : "本次没有可注入的 XLSX 结构信息。";
  // market-watch 专属：个股宇宙由服务端注入（dyk 8-31），其他任务类型不注入。
  const marketWatchUniverse = input.task.taskType === MARKET_WATCH_TASK_TYPE
    ? await buildMarketWatchUniverseFact(input.scope)
    : null;
  const message: AgentMessage = {
    id: input.repairContext ? `${input.run.runId}-repair` : input.run.runId,
    from: `automation:${input.task.taskId}`,
    timestamp: Date.now(),
    content: {
      type: "text",
      text: [
        input.repairContext
          ? "修复上一轮的最终提交（服务端验证未通过，你的数据工作已被保留，只需修复输出）。"
          : "执行一个受控的通用自动化任务。",
        `【系统时间】${serverTimeFact()}（Asia/Shanghai）`,
        "本会话是已存在任务的执行会话：调度、任务配置和定时规则由服务层管理，本会话没有创建/修改自动化任务的权限（调用会被 scope_denied 拒绝）。不要尝试创建、修改或删除自动化任务/定时规则/调度配置，也不要把「建立任务」当作目标；忽略任务说明里出现的执行时间和频率描述，直接开始执行任务说明中的实际工作。",
        `任务说明：${input.task.revision.instruction}`,
        ...(marketWatchUniverse ? [marketWatchUniverse] : []),
        `本次输出策略（明确格式和文件名必须严格遵守）：${JSON.stringify(input.task.revision.output)}。`,
        `本次绑定文件（任务对象，不得用全局文件列表替换）：${JSON.stringify(input.inputs.map((item, index) => ({ assetId: item.descriptor.assetId, versionId: item.descriptor.versionId, stagedPath: `inputs/${index + 1}-${item.descriptor.fileName}`, fileName: item.descriptor.fileName, mimeType: item.descriptor.mimeType, format: item.descriptor.format })))}。`,
        `可更新目标（仅这些文件允许 operation='update'）：${JSON.stringify(input.writableTargets)}。`,
        input.repairContext
          ? `【上一轮被拒原因（服务端验证器报错）】${input.repairContext.validationError}\n【修复要求】在上一轮最终回复的基础上修复上述问题（常见原因：JSON 大括号不配对、夹带叙述文本、rows 列数与表头不符、shouldNotify 缺失或不是 boolean），不要重新取数、不要从头重做；只重新输出修正后的完整最终 JSON 对象，不要输出其他内容。\n【上一轮最终回复】${input.repairContext.previousReply}`
          : "",
        reviewTarget
          ? `本次是受控 ${reviewTarget.kind} 复盘：必须调用 reviews.save，并严格使用 kind='${reviewTarget.kind}'、${reviewTarget.kind === "daily" ? "date" : "reportKey"}='${reviewTarget.reportKey}'；只有服务端回读到本次 artifact 后 run 才能成功。`
          : "",
        spreadsheetContextText,
        input.monthlyRollover
          ? `本任务按月滚动工作簿：当前绑定《${input.monthlyRollover.boundFileName}》不是本月目标《${input.monthlyRollover.targetFileName}》。本次运行必须：先用 assets.version.read 读取当前绑定文件，沿用其工作表、表头与字段口径生成本月目标文件（只含表头与口径、不含历史行），把本次结果追加进新文件，并在 stagedOutput 返回 operation='create'、fileName='${input.monthlyRollover.targetFileName}' 与完整新文件内容；不得继续向旧月份文件追加，也不得使用其他文件名。服务层会把任务绑定切换到本月文件。`
          : "",
        "需要读取绑定文件时，直接使用上述 assetId 调用 assets.version.read；不要用 assets.list 猜测或替换任务对象。其他“我的文件”仅可作为参考，绝不能作为本次更新输出目标。",
        input.spreadsheetHelper
          ? `本次包含 XLSX 绑定文件。服务端已注入每个工作表的 sheet/header/columnCount/dedupeColumn/lastDedupeValue；严格沿用这些事实。普通表尾追加不要调用 spreadsheet.transform，直接在最终 stagedOutput 返回 {operation:'appendRows', sheet:'服务端给出的工作表名'（只有一个工作表时可省略）, rows:[[每行各列的值],…]（必须是二维数组，列数必须等于 columnCount，列序必须等于 header）, skipIfCellMatches:{column:dedupeColumn, value:'本次待追加行在判重列中的值'}}。先把本次判重值与 lastDedupeValue 比较：相同则返回 outputSkipped:true；不同则必须使用本次新值作为 skipIfCellMatches.value，绝不能直接使用旧的 lastDedupeValue，否则会把正常新行误判为重复。服务层会确定性追加到表尾并提交新版本。只有确需修改表头、格式或既有单元格等非追加变更时，才使用 spreadsheet.transform 生成更新后的工作簿；不要用它模拟普通追加。执行环境不能运行本地脚本，暂存目录中的 automation-sheet.mjs 仅供参考、无法执行；不要把 XLSX 当文本编辑，也不要声称没有电子表格处理能力。`
          : "本次没有 XLSX 文件，不需要电子表格处理。",
        `执行预算（服务层约束）：最多 ${GENERIC_AUTOMATION_MAX_TOOL_CALLS} 次服务/外部工具调用；单次模型尝试最多 ${GENERIC_AUTOMATION_ATTEMPT_TIMEOUT_MS / 1000} 秒；按“读取绑定输入与结构 → 必要的有限研究 → 一次最终动作”三阶段执行。不要重复读取同一版本、不要探索任务/会话/确认/盯盘配置。自动换模型仅在总 agent 截止时间尚余至少 ${GENERIC_AUTOMATION_FALLBACK_RESERVE_MS / 1000} 秒时发生，截止时间前另预留 ${GENERIC_AUTOMATION_COMMIT_RESERVE_MS / 1000} 秒提交空间；进入收尾阶段后立即返回结构化 JSON。`,
        `结果数量与表格文件规则：${OUTPUT_VOLUME_POLICY}`,
        "默认按可用数据完成任务：除非用户或任务明确要求指定来源一致、对账、审计或逐项严格核验，否则公开来源中包含指标名称、具体数值和日期/时间的结果即可写入文件，即使尚未完成第二次独立核验；必须保留实际来源、时间、口径差异并标明“未独立核验”。若经过合理检索仍没有任何可用数值，且任务没有明确要求记录维护状态，就保持原文件不变、显式返回 outputSkipped:true 并在 summary 说明原因；不得为了证明执行过而写入空值、零值、估算值或无意义状态行。",
        input.task.revision.output.mode === "none"
          ? "最终回复必须是一个 JSON 对象：{summary:string, shouldNotify?:boolean}。本任务不产出文件资产：最终 JSON 里禁止出现 stagedOutput 字段（出现会导致运行被判无效）；一切结果都写入 summary。若任务过程中确需留档，用任务说明允许的领域工具（如 reviews.save）完成，不要用 stagedOutput。"
          : "最终回复必须是一个 JSON 对象：{summary:string, stagedOutput?:{operation:'appendRows'|'update'|'create', …}, shouldNotify?:boolean, outputSkipped?:boolean}。向绑定工作簿表尾追加数据行时优先用 operation:'appendRows'（只带 sheet/rows/skipIfCellMatches，不携带文件内容）；生成完整新文件时优先调用 spreadsheet.create 在当前暂存目录生成 XLSX，并原样返回工具结果里的 stagedOutput；自行生成 XLSX/CSV 时必须返回 {operation:'create', fileName:'带扩展名的文件名', filePath:'暂存目录内的相对路径'}，fileName 和 filePath 缺一不可；filePath 必须原样使用文件写入工具返回的相对路径（通常就是纯文件名），不得自行拼接目录前缀、暂存根路径或绝对路径，也不得越出暂存目录。只有小型文本结果才使用 base64。更新绑定文件时提供 operation='update'、对应 assetId；仅在任务确有必要新建文件时提供 operation='create'。若本次运行确定无需修改绑定文件（如数据缺失、当日行已存在），必须显式返回 outputSkipped:true 并在 summary 说明原因；缺少 stagedOutput 又未声明 outputSkipped 的运行会被判为失败。",
        ...(input.task.revision.delivery.mode === "none"
          ? []
          : [
              // summary doubles as the WeChat push body for delivery-enabled
              // tasks (a0f7997 covered the legacy scheduler prompts only).
              "本任务的结果会推送微信：summary 会直接作为微信消息正文发送给用户，必须使用适合微信阅读且可由微信渲染的简洁 Markdown；使用 `**重点**` 和清晰分段，并按内容需要使用列表或短标题，不要写成无格式的连续纯文本；禁止输出 Markdown 表格（微信不渲染表格）。若按任务约定本轮不推送（如输出 NO_PUSH），summary 简要说明原因即可。",
              ...(input.task.revision.delivery.mode === "wechat_on_condition"
                ? ["本任务按条件推送：最终 JSON 必须显式包含 shouldNotify 字段且只能是 boolean——true 表示本轮应把 summary 作为微信消息推送给用户，false 表示本轮不推送、仅留档。省略该字段或给非 boolean 值会导致本轮运行被判无效。"]
                : []),
            ]),
      ].join("\n"),
    },
    context: {
      // Automation runs are not conversations: a distinct channel keeps them
      // out of the conversation audit scope and any channel-based stats.
      channel: "automation",
      conversationId: reviewTarget?.conversationId ?? `automation-run:${input.run.runId}`,
      userId: input.scope.userId,
      projectId: input.scope.projectId,
      instanceId: input.scope.instanceId,
      workspacePath: input.stagingPath,
      // Keep the registered task type out of the generic ACP scope guard:
      // mcpAllowedTools is the precise per-run grant below. The original
      // scheduled-automation marker expands to every read tool.
      taskType: GENERIC_AUTOMATION_CONTEXT_TASK_TYPE,
      ...(pinnedModel ? { model: pinnedModel } : {}),
      mcpAllowedTools: toolAllowlist,
      expectedReviewKind: reviewTarget?.kind,
      expectedReviewKey: reviewTarget?.reportKey,
      _executionDeadlineAt: agentDeadlineAt,
      _automationMaxToolCalls: GENERIC_AUTOMATION_MAX_TOOL_CALLS,
      _thinkingDepthHint: thinkingDecision,
      _attemptTimeoutMs: GENERIC_AUTOMATION_ATTEMPT_TIMEOUT_MS,
      _fallbackMinRemainingMs: GENERIC_AUTOMATION_FALLBACK_RESERVE_MS,
      _cancelSignal: input.signal,
    },
  };
  const response = await createRuntimeAgent().handleMessage(message);
  return parseStructuredAcpResponse(response);
}

/** Top-level balanced {...} spans in mixed prose+JSON text. String literals
 * are tracked so braces inside values never break depth counting; prose
 * fragments merely produce spans that fail JSON.parse and get skipped. */
function findTopLevelJsonObjectSpans(text: string): string[] {
  const spans: string[] = [];
  const openStack: number[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") openStack.push(index);
    else if (char === "}" && openStack.length > 0) {
      const start = openStack.pop()!;
      if (openStack.length === 0) spans.push(text.slice(start, index + 1));
    }
  }
  return spans;
}

/** The ACP client exposes customer text, so generic runs use a strict JSON
 * envelope in the final response to carry the service-owned staged output. */
export function parseStructuredAcpResponse(response: AgentResponse): AgentResponse {
  if (response.data?.stagedOutput !== undefined || response.data?.summary !== undefined || response.data?.shouldNotify !== undefined) return response;
  const text = response.content.text?.trim() || "";
  // 2026-08-27（mg 行业复盘失败教训）：模型偶发在最终 JSON 前后混入叙述文本，
  // 整段/围栏解析都失败时，兜底抽取文本中的顶层平衡 JSON 对象，最后出现的优先。
  const candidates = [
    text,
    text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] || "",
    ...findTopLevelJsonObjectSpans(text).reverse(),
  ];
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

const STAGING_BASENAME_SEARCH_MAX_ENTRIES = 500;
const STAGING_BASENAME_SEARCH_MAX_DEPTH = 3;

/** T-337 self-heal: when an agent misreferences the staged file (absolute
 * path, wrong prefix, or an invented subdirectory), find the unique staging
 * file with the same basename. Returns "" on zero or ambiguous matches and
 * never resolves outside the staging root (symlinks resolved). */
async function findUniqueStagingFileByBasename(stagingPath: string, root: string, basename: string): Promise<string> {
  const wanted = basename.trim().toLowerCase();
  if (!wanted || wanted === "." || wanted === "..") return "";
  const matches: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: stagingPath, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && matches.length < 2 && visited < STAGING_BASENAME_SEARCH_MAX_ENTRIES) {
    const { dir, depth } = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > STAGING_BASENAME_SEARCH_MAX_ENTRIES) break;
      if (entry.isDirectory()) {
        // `inputs/` is a service-owned copy of bound assets, not an agent
        // output candidate. Never turn a missing output into a copy of input.
        if (entry.name === "inputs") continue;
        if (depth < STAGING_BASENAME_SEARCH_MAX_DEPTH) queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        continue;
      }
      if (!(entry.isFile() || entry.isSymbolicLink()) || entry.name.toLowerCase() !== wanted) continue;
      const resolved = await realpath(path.join(dir, entry.name)).catch(() => "");
      if (!resolved || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))) continue;
      const relative = path.relative(root, resolved);
      if (relative === "inputs" || relative.startsWith(`inputs${path.sep}`) || relative === "automation-sheet.mjs") continue;
      const info = await stat(resolved).catch(() => null);
      if (!info?.isFile()) continue;
      matches.push(resolved);
      if (matches.length >= 2) break;
    }
  }
  if (matches.length !== 1) return "";
  return matches[0]!;
}

function clipPathForError(filePath: string): string {
  return filePath.length > 200 ? `${filePath.slice(0, 197)}...` : filePath;
}

function isShouldNotifyValidationError(error: unknown): boolean {
  // AutomationTaskError.message 的实际格式是 `${code}:${message}`，匹配子串而非前缀。
  return error instanceof AutomationTaskError && error.code === "AUTOMATION_RUN_INVALID_RESULT" && error.message.includes("shouldNotify must be boolean");
}

/** wechat_on_condition 任务必须由模型显式表态是否推送（exception_only 语义）。
 * strict 轮抛 AUTOMATION_RUN_INVALID_RESULT 以触发自纠重试；lenient 轮是 T-376
 * 兜底（重试不可用或重试后仍无效）：字符串 "true"/"false" 宽松转换，其余一律
 * 缺省不推送——宁可少推一条消息，不让已完成的数据工作被判 failed。 */
function resolveShouldNotify(data: Record<string, unknown>, delivery: AutomationTaskRecord["revision"]["delivery"], lenient: boolean, taskId: string): boolean {
  if (delivery.mode !== "wechat_on_condition") return delivery.mode === "wechat_summary";
  const raw = data.shouldNotify;
  if (typeof raw === "boolean") return raw;
  if (!lenient) throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", "shouldNotify must be boolean");
  if (typeof raw === "string") {
    const lowered = raw.trim().toLowerCase();
    if (lowered === "true" || lowered === "false") {
      logger.warn(`automation shouldNotify lenient coerce task=${taskId} raw=${raw.slice(0, 20)}`);
      return lowered === "true";
    }
  }
  logger.warn(`automation shouldNotify missing/invalid -> suppressed task=${taskId} raw=${String(raw).slice(0, 40)}`);
  return false;
}

async function normalizeStructuredResult(response: AgentResponse, task: AutomationTaskRecord, resolved: ResolvedBindings, scope: AutomationScope, stagingPath: string, options?: { lenientShouldNotify?: boolean }): Promise<{
  summary: string;
  shouldNotify: boolean;
  outputSkipped?: boolean;
  stagedOutput?: { operation: "create" | "update"; assetId?: string; fileName: string; mimeType?: string; base64: string };
}> {
  const data = response.data && typeof response.data === "object" ? response.data : {};
  const summaryValue = typeof data.summary === "string" ? data.summary : response.content.text;
  const summary = String(summaryValue || "").trim().slice(0, 12_000);
  const delivery = task.revision.delivery;
  const shouldNotify = resolveShouldNotify(data, delivery, options?.lenientShouldNotify === true, task.taskId);
  const stagedRaw = data.stagedOutput;
  if (task.revision.output.mode === "none") {
    // The domain output (e.g. a saved review) may already be persisted by the
    // agent; an unexpected stagedOutput must not fail the whole run (T-324).
    if (stagedRaw !== undefined && stagedRaw !== null) {
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
    if (filePath.includes("\0")) {
      throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", `stagedOutput filePath is invalid: ${clipPathForError(filePath)}`);
    }
    const root = await realpath(stagingPath);
    const absolute = path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath);
    const normalizedPath = filePath.replace(/\\/g, "/");
    if (normalizedPath.split("/").includes("..")) {
      throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", `stagedOutput filePath is outside staging: ${clipPathForError(filePath)}`);
    }
    const requestedPath = absolute ? filePath : path.resolve(stagingPath, filePath);
    const resolvedRequestedPath = await realpath(requestedPath).catch(() => "");
    const resolvedInside = resolvedRequestedPath !== ""
      && (resolvedRequestedPath === root || resolvedRequestedPath.startsWith(`${root}${path.sep}`));
    const resolvedReserved = resolvedInside && (() => {
      const relative = path.relative(root, resolvedRequestedPath);
      return relative === "inputs" || relative.startsWith(`inputs${path.sep}`) || relative === "automation-sheet.mjs";
    })();
    const requestedInfo = resolvedInside && !resolvedReserved ? await stat(resolvedRequestedPath).catch(() => null) : null;
    let candidate = requestedInfo?.isFile() ? resolvedRequestedPath : "";
    const requestedPathExists = resolvedRequestedPath !== "";
    // Absolute paths are a malformed result even when they happen to resolve
    // inside staging. They may be normalized only when the task has exactly
    // one declared writable target; otherwise the target identity is unclear.
    // Existing paths outside staging are never normalized, so an agent cannot
    // smuggle an arbitrary workspace file through a matching basename.
    const rejection = absolute
      ? resolvedRequestedPath && !resolvedInside ? "is outside staging" : "is invalid"
      : resolvedRequestedPath && !resolvedInside ? "is outside staging" : candidate ? null : "is outside staging";
    if (rejection && requestedPathExists && (!resolvedInside || resolvedReserved || !requestedInfo?.isFile())) {
      throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", `stagedOutput filePath ${rejection}: ${clipPathForError(filePath)}`);
    }
    if (rejection) {
      if (resolved.writableTargets.length !== 1) {
        throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", `stagedOutput filePath ${rejection}; cannot normalize without exactly one writable target: ${clipPathForError(filePath)}`);
      }
      // T-337 (2026-08-21 patrol, mg agent-mode review): agents sometimes
      // prefix the staging root or an invented subdirectory to the file name.
      // Recover deterministically when exactly one file in staging carries the
      // referenced basename; stay failed on zero or ambiguous matches.
      candidate = await findUniqueStagingFileByBasename(stagingPath, root, path.posix.basename(filePath.replace(/\\/g, "/")));
      if (!candidate) {
        throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", `stagedOutput filePath ${rejection}: ${clipPathForError(filePath)}`);
      }
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
  // The spreadsheet prompt recommends appendRows for any XLSX binding
  // regardless of output mode (T-378), so agent-mode tasks with exactly one
  // XLSX update target use the same deterministic append path.
  let target: NonNullable<ResolvedOutput> | null = resolved.output;
  if (outputPolicy.mode === "agent") {
    const xlsxTargets = [...resolved.agentUpdateTargets.values()].filter((item) => isXlsxAsset(item.fileName));
    target = xlsxTargets.length === 1 ? xlsxTargets[0] : null;
  }
  if (!target) {
    throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", outputPolicy.mode === "agent"
      ? "stagedOutput appendRows requires agent tasks to bind exactly one XLSX workbook; use operation 'update' or 'create' otherwise"
      : "stagedOutput appendRows is only valid for update tasks with a bound workbook; use operation 'update' or 'create'");
  }
  if (resolved.monthlyRollover) {
    throw new AutomationTaskError("AUTOMATION_RUN_INVALID_RESULT", `appendRows cannot target the stale monthly file 《${resolved.monthlyRollover.boundFileName}》; create this month's 《${resolved.monthlyRollover.targetFileName}》 with operation 'create' instead`);
  }
  if (!target.fileName.toLowerCase().endsWith(".xlsx")) {
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
    const currentBytes = await readUserAssetVersion({ ...scope, assetId: target.assetId, versionId: target.versionId });
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
      assetId: target.assetId,
      fileName: target.fileName,
      mimeType: target.mimeType,
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
