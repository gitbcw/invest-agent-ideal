/**
 * W4-R1：Agent Space 装配模式（默认关闭，按 scope 显式启用）。
 *
 * 真实入口接线：conversation（runtime/agent.ts 交互路径）、generic automation
 * 与 scheduled（generic-automation-runner.ts / scheduled-tasks.ts 显式标注，
 * 经 runtime/agent.ts 的同一模型边界）。启用后 turn 的
 * instructions/tools/workspace 来自 agent-space 装配与固定版本内容——不回落
 * 旧 Workspace 挂载/默认技能发现；装配失败即失败，不静默降级。未启用
 * scope 保持既有行为不变（零新增写入）。
 *
 * 开关：AGENT_SPACE_ASSEMBLY_MODE = off（默认）| on | scope:<userId,...>
 */
import { sqlite } from "../db/index.js";
import {
  AgentSpaceError,
  assembleAndRecordRunBasis,
  getRunBasis,
  readMethodVersionContent,
  recordRunBasisInjection,
  type AssemblyEntryKind,
  type RunBasisInjection,
} from "../services/agent-space/index.js";
import { getVersionRow as getSkillVersionRow, readSkillVersionContentBytes } from "../services/agent-space/skills.js";

export const AGENT_SPACE_ASSEMBLY_MODE_ENV = "AGENT_SPACE_ASSEMBLY_MODE";
export const AGENT_SPACE_CONTENT_BUDGET_ENV = "AGENT_SPACE_CONTENT_BUDGET_CHARS";
const DEFAULT_CONTENT_BUDGET_CHARS = 24_000;

export function isAgentSpaceAssemblyModeEnabled(userId: string): boolean {
  const flag = (process.env[AGENT_SPACE_ASSEMBLY_MODE_ENV] ?? "").trim().toLowerCase();
  if (!flag || flag === "off" || flag === "0" || flag === "false") return false;
  if (flag === "on" || flag === "1" || flag === "true") return true;
  if (flag.startsWith("scope:")) {
    const ids = flag.slice("scope:".length).split(",").map((id) => id.trim()).filter(Boolean);
    return ids.includes(userId);
  }
  return false;
}

export function detectAssemblyEntryKind(taskType: string | null | undefined): AssemblyEntryKind {
  if (taskType === "automation-execution") return "generic_automation";
  if (taskType && taskType.startsWith("scheduled-")) return "scheduled";
  return "conversation";
}

function resolveScopeActiveAgentId(scope: { userId: string; projectId: string; instanceId: string }): string {
  // 多个 active Agent 时取最新创建的一个（每 scope 单 Agent 是常态；歧义时
  // 宁取最新，不静默混用旧装配）。
  const row = sqlite
    .prepare(
      `SELECT agent_id FROM agent_space_agents
       WHERE user_id=? AND project_id=? AND instance_id=? AND status='active'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(scope.userId, scope.projectId, scope.instanceId) as { agent_id: string } | undefined;
  if (!row) {
    throw new AgentSpaceError(
      "AGENT_SPACE_INVALID_TRANSITION",
      "agent-space assembly mode requires an active agent for the scope; refusing to fall back to the legacy workspace",
    );
  }
  return row.agent_id;
}

export interface AssemblyTurnOptions {
  instructions: string;
  tools: Record<string, unknown>;
  /** 新模式不挂载任何 workspace；字段显式缺席即模型边界无工作区。 */
  workspace?: undefined;
  basisKey: string;
}

function truncateToBudget(text: string, budget: number): { kept: string; originalChars: number; keptChars: number } {
  if (text.length <= budget) return { kept: text, originalChars: text.length, keptChars: text.length };
  return { kept: text.slice(0, budget), originalChars: text.length, keptChars: budget };
}

/**
 * 组装新模式模型边界输入：basis 冻结解析 → 固定版本内容按预算注入 →
 * 回写实际注入记录（sections/tools/workspace）。装配或必需依赖不满足时
 * 抛错阻断本轮——不回落旧路径、不把空装配当成功。
 */
export async function buildAgentSpaceTurnOptions(input: {
  scope: { userId: string; projectId: string; instanceId: string };
  conversationId: string;
  messageId: string;
  /** 入口显式标注优先（generic_automation/scheduled）；缺省按 taskType 识别。 */
  entryKind?: AssemblyEntryKind;
  taskType?: string | null;
  taskId?: string | null;
  runId?: string | null;
  grantedTools: Record<string, unknown>;
  toolAllowlist?: readonly string[] | null;
}): Promise<AssemblyTurnOptions> {
  const entryKind = input.entryKind ?? detectAssemblyEntryKind(input.taskType);
  const agentId = resolveScopeActiveAgentId(input.scope);
  const basisKey = entryKind === "conversation"
    ? `conversation:${input.conversationId}:message:${input.messageId}`
    : input.runId
      ? `run:${input.runId}:basis`
      : `task:${input.taskId}:message:${input.messageId}`;
  const basis = assembleAndRecordRunBasis({
    scope: input.scope,
    agentId,
    entryKind,
    basisKey,
    ...(entryKind === "conversation"
      ? { conversationId: input.conversationId }
      : { taskId: input.taskId ?? undefined, runId: input.runId ?? undefined }),
    actor: "runtime-assembly",
  });
  const budgetChars = Math.max(1, Number(process.env[AGENT_SPACE_CONTENT_BUDGET_ENV] ?? DEFAULT_CONTENT_BUDGET_CHARS));
  const lines: string[] = [
    `# Agent Space 装配（${entryKind}）`,
    `Agent: ${basis.resolution.agent.name} (${basis.resolution.agent.agentId})`,
    "本轮技能/方法/资产全部为固定版本，按 versionId+checksum 读取。",
  ];
  const sections: RunBasisInjection["sections"] = [];
  let remaining = budgetChars;
  const pushContent = (section: string, header: string, content: string | null) => {
    if (content === null) {
      lines.push(header);
      sections.push({ section, originalChars: 0, keptChars: 0, reason: "reference-only (content not injected)" });
      return;
    }
    const fit = truncateToBudget(content, remaining);
    lines.push(header);
    if (fit.kept.length > 0) lines.push(fit.kept);
    remaining -= fit.keptChars;
    sections.push({
      section,
      originalChars: fit.originalChars,
      keptChars: fit.keptChars,
      ...(fit.keptChars < fit.originalChars ? { reason: "content-budget-truncated" } : {}),
    });
  };
  for (const method of basis.resolution.methods) {
    let content: string | null = null;
    try {
      content = (await readMethodVersionContent(input.scope, method.versionId)).bytes.toString("utf8");
    } catch (error) {
      sections.push({ section: `method:${method.methodId}`, originalChars: 0, keptChars: 0, reason: `content read failed: ${(error as Error).message}` });
    }
    pushContent(
      `method:${method.methodId}`,
      `## 方法 ${method.methodId} @ ${method.versionId} (checksum ${method.contentChecksum}, ${method.versionPolicy}${method.origin === "task-dependency-pinned" ? ", task-pinned" : ""})`,
      content,
    );
  }
  for (const skill of basis.resolution.skills) {
    let content: string | null = null;
    try {
      content = (await readSkillVersionContentBytes(getSkillVersionRow(skill.versionId))).toString("utf8");
    } catch (error) {
      sections.push({ section: `skill:${skill.skillId}`, originalChars: 0, keptChars: 0, reason: `content read failed: ${(error as Error).message}` });
    }
    pushContent(
      `skill:${skill.skillId}`,
      `## 技能 ${skill.skillId} @ ${skill.versionId} (checksum ${skill.contentChecksum}, source ${skill.source}${skill.origin === "task-dependency-pinned" ? ", task-pinned" : ""})`,
      content,
    );
  }
  for (const asset of basis.resolution.assets) {
    // 资产注入引用（role+version+checksum）；字节读取走 scoped user-assets 工具。
    lines.push(`- 资产(${asset.role}) ${asset.assetId} @ ${asset.versionId} (checksum ${asset.contentChecksum})`);
    sections.push({ section: `asset:${asset.assetId}:${asset.role}`, originalChars: 0, keptChars: 0, reason: "reference-only" });
  }
  if (basis.resolution.methods.length === 0 && basis.resolution.skills.length === 0 && basis.resolution.assets.length === 0) {
    lines.push("本轮装配为显式空集（见 skipped 原因）；不得虚构可用能力。");
  }
  lines.push(`状态包：${basis.resolution.statePacket.agentState.note}`);
  for (const item of basis.resolution.skipped) lines.push(`- skipped: ${item.kind}:${item.ref} — ${item.reason}`);
  for (const item of basis.resolution.pruned) lines.push(`- pruned: ${item.kind}:${item.ref} — ${item.reason}`);
  lines.push("未装配的内容（含任何旧 Workspace/默认技能）不可用；不要引用不存在的工具或文件。");

  // 受限工具：授权即清单（数组即清单——空数组=零授权；null=无清单概念，
  // 以服务层授予集为准）。
  const allow = input.toolAllowlist ? new Set(input.toolAllowlist) : null;
  const tools: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(input.grantedTools)) {
    if (!allow || allow.has(name)) tools[name] = tool;
  }
  recordRunBasisInjection(input.scope, basisKey, {
    sections,
    tools: Object.keys(tools),
    workspace: null,
  });
  return { instructions: lines.join("\n"), tools, basisKey };
}

/** 测试/运维读取已记录注入与冻结 basis（幂等）。 */
export function getAssemblyRunBasis(scope: { userId: string; projectId: string; instanceId: string }, basisKey: string) {
  return getRunBasis(scope, basisKey);
}

/** 供入口显式标注（generic runner / scheduled tasks）：仅在启用时携带。 */
export function assemblyEntryAnnotation(entryKind: AssemblyEntryKind, userId: string): { _agentSpaceAssembly?: AssemblyEntryKind } {
  return isAgentSpaceAssemblyModeEnabled(userId) ? { _agentSpaceAssembly: entryKind } : {};
}
