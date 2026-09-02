import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createRuntimeAgent } from "../runtime/agent.js";
import { ACTIVE_BACKEND } from "../lib/data-backend.js";
import type { AgentMessage, AgentResponse } from "../runtime/protocol.js";
import { ensureWorkspace, resolveWorkspacePath } from "../lib/workspace.js";
import { resolveRegisteredMastraProjectRoot } from "../mastra/workspace-registry.js";
import {
  appendConversationMessage,
  createConversationSession,
  type ConversationScope,
} from "./conversation-log.js";
import {
  assertAutomationTaskRunLease,
  claimAutomationTaskRun,
  finishAutomationTaskRun,
  getAutomationTask,
  getAutomationTaskRun,
  refreshAutomationTaskWorkingAsset,
  readAutomationTaskAsset,
  writeAutomationTaskWorkingAsset,
  AutomationTaskError,
  type AutomationScope,
  type AutomationTaskRecord,
  type AutomationTaskRunRecord,
} from "./automation-tasks.js";
import { writeAutomationSpreadsheetHelper } from "./automation-spreadsheet.js";
import { runGenericAutomationTaskNow } from "./generic-automation-runner.js";
import { classifyTaskError } from "./task-execution.js";

export type AutomationRunResult = {
  run: AutomationTaskRunRecord;
  conversationId?: string;
  task: AutomationTaskRecord;
};

/**
 * Interactive chat intentionally turns ACP backend failures into a friendly
 * reply. A durable automation cannot do that: a friendly error is not a
 * successful file-maintenance result. Keep the transport distinction here so
 * the staged working file is never committed after a failed ACP turn.
 */
function assertAutomationAgentSucceeded(response: AgentResponse) {
  if (response.data?.executionStatus !== "failed") return;
  const errorCode = typeof response.data.executionErrorCode === "string"
    ? response.data.executionErrorCode
    : "AGENT_TURN_FAILED";
  throw new Error(errorCode);
}

function conversationScope(scope: AutomationScope): ConversationScope {
  return { ...scope, assistantId: scope.instanceId };
}

function taskPrompt(task: AutomationTaskRecord) {
  const source = task.sourceAsset?.fileName || "source file";
  const working = task.workingAsset?.fileName || "working file";
  return [
    "你正在执行一个受控的用户自动化文件维护任务。",
    `任务名称：${task.revision.name}`,
    `任务说明：${task.revision.description || "（未提供额外说明）"}`,
    `输入原件：source/${source}`,
    `目标工作文件：working/${working}`,
    "这是一次真实执行；请读取原件和当前工作文件，按照任务说明维护工作文件。",
    "硬约束：只能读取 source/ 和 working/ 中的这两个任务文件；绝不能修改 source/，不能访问或修改当前任务目录以外的文件，不能修改投资持仓、规则、策略或配置等确定性状态。",
    "CSV 必须按结构化表格方式处理；XLSX 不得当纯文本拼接。对于 XLSX，请用当前目录的 automation-sheet.mjs 读取或写入结构化工作簿（inspect/apply），再保存 working 文件。完成后用简洁中文说明结果、是否实际更新工作文件和需要用户继续确认的事项。不要暴露绝对路径、内部工具、token 或推理过程。",
  ].join("\n");
}

async function executeAgent(
  scope: AutomationScope,
  task: AutomationTaskRecord,
  run: AutomationTaskRunRecord,
  conversationId?: string,
  leaseToken?: string | null,
) {
  const workspaceRoot = await resolveRegisteredMastraProjectRoot(scope);
  if (!workspaceRoot) throw new AutomationTaskError("AUTOMATION_SCOPE_MISMATCH", "Mastra project is not registered");
  if (!task.sourceAsset || !task.workingAsset) throw new Error("AUTOMATION_ASSET_NOT_FOUND");

  // Never give the ACP process the canonical task directory. It gets a fresh
  // staging directory containing only the two asset bytes; only the service
  // can atomically commit the staged working file after ACP returns. This
  // makes source immutability and "working only" a service boundary instead
  // of a prompt-only convention.
  const stagingPath = await mkdtemp(path.join(workspaceRoot, ".automation-run-"));
  const sourcePath = path.join(stagingPath, "source");
  const workingPath = path.join(stagingPath, "working");
  try {
    await mkdir(sourcePath, { mode: 0o700 });
    await mkdir(workingPath, { mode: 0o700 });
    const [source, working] = await Promise.all([
      readAutomationTaskAsset({ ...scope, assetId: task.sourceAsset.assetId }),
      readAutomationTaskAsset({ ...scope, assetId: task.workingAsset.assetId }),
    ]);
    await Promise.all([
      writeFile(path.join(sourcePath, source.fileName), source.bytes, { flag: "wx", mode: 0o600 }),
      writeFile(path.join(workingPath, working.fileName), working.bytes, { flag: "wx", mode: 0o600 }),
    ]);
    await writeAutomationSpreadsheetHelper(stagingPath);

    const message: AgentMessage = {
      id: run.runId,
      from: conversationId || `automation:${task.taskId}`,
      timestamp: Date.now(),
      content: { type: "text", text: taskPrompt(task) },
      context: {
        // Automation runs are not conversations: a distinct channel keeps them
        // out of the conversation audit scope and any channel-based stats.
        channel: "automation",
        conversationId: conversationId || `automation-run:${run.runId}`,
        userId: scope.userId,
        projectId: scope.projectId,
        instanceId: scope.instanceId,
        workspacePath: stagingPath,
        taskType: task.taskType ?? "scheduled-automation",
      },
    };
    const response = await createRuntimeAgent().handleMessage(message);
    assertAutomationAgentSucceeded(response);
    const stagedWorkingPath = path.join(workingPath, task.workingAsset.fileName);
    const stagedStat = await lstat(stagedWorkingPath).catch(() => null);
    if (!stagedStat || stagedStat.isSymbolicLink() || !stagedStat.isFile()) {
      throw new Error("AUTOMATION_WORKING_OUTPUT_MISSING");
    }
    const stagedWorking = await readFile(stagedWorkingPath);
    await assertAutomationTaskRunLease({ ...scope, runId: run.runId, leaseToken });
    await writeAutomationTaskWorkingAsset({
      ...scope,
      taskId: task.taskId,
      revisionId: task.currentRevisionId || undefined,
      asset: {
        fileName: task.workingAsset.fileName,
        mimeType: task.workingAsset.mimeType,
        bytes: stagedWorking,
      },
    });
    return response;
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }
}

export async function runAutomationTaskNow(input: {
  scope: AutomationScope;
  taskId: string;
  origin: "manual" | "scheduled";
  idempotencyKey: string;
  scheduledFor?: string;
  executor?: typeof executeAgent;
}): Promise<AutomationRunResult> {
  const task = await getAutomationTask({ ...input.scope, taskId: input.taskId });
  if (!task) throw new Error(`AUTOMATION_TASK_NOT_FOUND:${input.taskId}`);
  if (!task.sourceAsset && !task.workingAsset) {
    return runGenericAutomationTaskNow({
      scope: input.scope,
      taskId: input.taskId,
      origin: input.origin,
      idempotencyKey: input.idempotencyKey,
      scheduledFor: input.scheduledFor,
    }) as unknown as AutomationRunResult;
  }
  const claimed = await claimAutomationTaskRun({
    ...input.scope,
    taskId: input.taskId,
    origin: input.origin,
    idempotencyKey: input.idempotencyKey,
    scheduledFor: input.scheduledFor,
  });
  const run = claimed.run;

  // A retry that lost the claim must never execute the ACP turn again. This
  // matters for cross-process scheduler retries as well as a Portal request
  // replay: the database claim is the execution mutex, not merely a lookup.
  if (!claimed.claimed) {
    if (run.idempotencyKey !== input.idempotencyKey) {
      throw new AutomationTaskError(
        "AUTOMATION_TASK_BUSY",
        "当前任务已有运行中的执行，请等待完成后再试。",
      );
    }
    return { run, conversationId: run.conversationId || undefined, task };
  }

  // A test run is execution history, not a customer conversation. Creating a
  // chat session here makes test runs appear in the Portal sidebar before the
  // user has chosen to discuss their result. Only continueAutomationRunInChat
  // creates a normal conversation explicitly.
  const conversationId = undefined;

  inFlightTypedRunIds.add(run.runId);
  try {
    const response = await (input.executor || executeAgent)(input.scope, task, run, conversationId, run.leaseToken);
    assertAutomationAgentSucceeded(response);
    await assertAutomationTaskRunLease({ ...input.scope, runId: run.runId, leaseToken: run.leaseToken });
    const working = task.workingAsset ? await refreshAutomationTaskWorkingAsset({ ...input.scope, taskId: task.taskId, revisionId: task.currentRevisionId || undefined }) : null;
    const resultSummary = response.content.text || "自动化运行完成。";
    const finished = await finishAutomationTaskRun({
      ...input.scope,
      runId: run.runId,
      leaseToken: run.leaseToken,
      status: "succeeded",
      resultSummary,
      outputAssetId: working?.assetId,
      outputChecksum: working?.checksum,
      traceId: run.runId,
    });
    return { run: finished, conversationId, task };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const classified = classifyTaskError(error);
    const failed = await finishAutomationTaskRun({
      ...input.scope,
      runId: run.runId,
      leaseToken: run.leaseToken,
      status: "failed",
      errorMessage: message,
      errorCategory: classified.category,
      retryable: classified.retryable,
      traceId: run.runId,
    });
    return { run: failed, conversationId, task };
  } finally {
    inFlightTypedRunIds.delete(run.runId);
  }
}

/** Typed (source/working-asset) automation runs between claim and finalize —
 * graceful-drain observation, same rationale as the generic runner counter. */
const inFlightTypedRunIds = new Set<string>();
/** 当前进程内在途的 typed automation run 数（优雅排空观测用）。 */
export function activeTypedAutomationRunCount(): number {
  return inFlightTypedRunIds.size;
}

export async function continueAutomationRunInChat(input: { scope: AutomationScope; runId: string }) {
  const run = await getAutomationTaskRun({ ...input.scope, runId: input.runId });
  if (!run) throw new Error(`AUTOMATION_RUN_NOT_FOUND:${input.runId}`);
  const task = await getAutomationTask({ ...input.scope, taskId: run.taskId });
  if (!task) throw new Error(`AUTOMATION_TASK_NOT_FOUND:${run.taskId}`);
  const conversationId = `automation-continue-${run.runId}-${randomUUID().slice(0, 8)}`;
  createConversationSession({
    scope: conversationScope(input.scope),
    conversationId,
    channel: "web",
    title: `自动化：${task.revision.name} - 运行详情`,
    metadata: { taskId: task.taskId, taskRevision: run.revisionId, runId: run.runId, origin: "automation_continue" },
  });
  appendConversationMessage({
    scope: conversationScope(input.scope),
    conversationId,
    channel: "web",
    role: "system",
    content: `这是对自动化运行 ${run.runId} 的新对话入口。运行状态：${run.status}。结果摘要：${run.resultSummary || run.errorMessage || "暂无摘要"}。本入口不会恢复后台上下文，也不会自动再次写入文件；如需继续处理，请明确提出新的互动要求。`,
    metadata: { taskId: task.taskId, taskRevision: run.revisionId, runId: run.runId, origin: "automation_continue" },
  });
  return { conversationId, run, task };
}
