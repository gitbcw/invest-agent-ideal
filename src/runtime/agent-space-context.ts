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
  findRunBasis,
  getRunBasis,
  readMethodVersionContent,
  recordRunBasisInjection,
  type AssemblyEntryKind,
  type RunBasisInjection,
} from "../services/agent-space/index.js";
import { getVersionRow as getSkillVersionRow, readSkillVersionContentBytes } from "../services/agent-space/skills.js";
import { readStateVersionContent } from "../services/agent-space/state.js";
import { buildPlatformBaseInstructions } from "./agent-instructions.js";
import type { UserContext } from "../lib/user-context.js";

type UserContextChannel = UserContext["channel"];

export const AGENT_SPACE_ASSEMBLY_MODE_ENV = "AGENT_SPACE_ASSEMBLY_MODE";
export const AGENT_SPACE_CONTENT_BUDGET_ENV = "AGENT_SPACE_CONTENT_BUDGET_CHARS";
const DEFAULT_CONTENT_BUDGET_CHARS = 24_000;

const STARTER_SKILL_TRIGGERS: Record<string, RegExp> = {
  "automation-task-designer": /自动化|定时|周期任务|每日.*(?:提醒|更新|推送)|每周.*(?:提醒|更新|推送)|任务提示词|schedule|automation/i,
  "candidate-screening": /筛选|候选|选股|排雷|观察池|等待条件|跟踪清单/i,
  "fundamental-analysis": /基本面|财报|财务|估值|护城河|商业模式|现金流|盈利|同行/i,
  "macro-analysis": /宏观|政策|货币|财政|利率|汇率|流动性|地缘|大盘/i,
  "risk-control": /风控|风险控制|仓位|回撤|止损|止盈|加仓|减仓|资产配置|交易纪律/i,
  "technical-analysis": /技术面|技术分析|均线|趋势|量价|突破|回踩|K线|支撑|压力|买卖点|波段/i,
};

export function isStarterSkillApplicable(slug: string, request: string): boolean {
  return STARTER_SKILL_TRIGGERS[slug]?.test(request) ?? true;
}

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

/**
 * 稳定执行身份（返工 R7）：已有 basis 的请求沿用**冻结身份**（并保留当前
 * 停用校验）；新请求优先用任务依赖声明的显式 Agent 绑定；无绑定且同 scope
 * 存在多个 active Agent 时**明确拒绝歧义**——绝不按创建时间猜测。
 */
function resolveAssemblyAgentId(input: {
  scope: { userId: string; projectId: string; instanceId: string };
  basisKey: string;
  taskId?: string | null;
}): string {
  // 1) 冻结身份回用：同请求重试不因新增 Agent 换身份。
  const frozen = findRunBasis(input.scope, input.basisKey);
  if (frozen) {
    const agentId = frozen.resolution.agent.agentId;
    const agent = sqlite
      .prepare("SELECT status FROM agent_space_agents WHERE agent_id=?")
      .get(agentId) as { status: string } | undefined;
    if (!agent || agent.status !== "active") {
      throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `frozen assembly agent ${agentId} is no longer active; refusing to swap identity silently`);
    }
    return agentId;
  }
  // 2) 任务入口：依赖声明的执行 Agent 绑定（唯一才可信）。
  if (input.taskId) {
    const depAgents = sqlite
      .prepare(`SELECT DISTINCT agent_id FROM agent_space_task_dependencies WHERE task_id=? AND agent_id IS NOT NULL`)
      .all(input.taskId) as Array<{ agent_id: string }>;
    if (depAgents.length === 1) {
      const agent = sqlite
        .prepare("SELECT status FROM agent_space_agents WHERE agent_id=?")
        .get(depAgents[0]!.agent_id) as { status: string } | undefined;
      if (!agent || agent.status !== "active") {
        throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `task-bound agent ${depAgents[0]!.agent_id} is not active`);
      }
      return depAgents[0]!.agent_id;
    }
    if (depAgents.length > 1) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `task dependencies declare ${depAgents.length} different agents; the execution agent must be explicit`);
    }
  }
  // 3) 无绑定：scope 内 active Agent 恰好一个才可解析，否则明确拒绝。
  const actives = sqlite
    .prepare(
      `SELECT agent_id FROM agent_space_agents
       WHERE user_id=? AND project_id=? AND instance_id=? AND status='active'`,
    )
    .all(input.scope.userId, input.scope.projectId, input.scope.instanceId) as Array<{ agent_id: string }>;
  if (actives.length === 1) return actives[0]!.agent_id;
  if (actives.length === 0) {
    throw new AgentSpaceError(
      "AGENT_SPACE_INVALID_TRANSITION",
      "agent-space assembly mode requires an active agent for the scope; refusing to fall back to the legacy workspace",
    );
  }
  throw new AgentSpaceError(
    "AGENT_SPACE_ARGUMENT_INVALID",
    `scope has ${actives.length} active agents and no explicit task binding; the execution agent must be explicit (refusing to guess by creation time)`,
  );
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
  /** Current request text selects relevant starter skills; no text keeps legacy callers compatible. */
  promptText?: string;
  /** 入口通道（平台 L1 通道呈现规则需要；缺省无通道段）。 */
  channel?: string | null;
  /** 入口显式标注优先（generic_automation/scheduled）；缺省按 taskType 识别。 */
  entryKind?: AssemblyEntryKind;
  taskType?: string | null;
  taskId?: string | null;
  runId?: string | null;
  grantedTools: Record<string, unknown>;
  toolAllowlist?: readonly string[] | null;
}): Promise<AssemblyTurnOptions> {
  const entryKind = input.entryKind ?? detectAssemblyEntryKind(input.taskType);
  const basisKey = entryKind === "conversation"
    ? `conversation:${input.conversationId}:message:${input.messageId}`
    : input.runId
      ? `run:${input.runId}:basis`
      : `task:${input.taskId}:message:${input.messageId}`;
  const agentId = resolveAssemblyAgentId({ scope: input.scope, basisKey, taskId: entryKind === "conversation" ? null : input.taskId });
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
  // 返工 R6：已解析且需注入的方法/技能正文读取/校验失败 → **阻断本轮模型
  // 调用**（不标成 reference-only 成功注入）；解析 basis 保留为失败证据。
  // 恢复正确字节后同请求可重试成功（resolution 冻结，注入重算）。
  for (const method of basis.resolution.methods) {
    let content: string;
    try {
      content = (await readMethodVersionContent(input.scope, method.versionId)).bytes.toString("utf8");
    } catch (error) {
      throw new AgentSpaceError(
        "AGENT_SPACE_VERSION_INVALID",
        `required method content ${method.methodId}@${method.versionId} failed verification (${(error as Error).message}); blocking the model call`,
      );
    }
    pushContent(
      `method:${method.methodId}`,
      `## 方法 ${method.methodId} @ ${method.versionId} (checksum ${method.contentChecksum}, ${method.versionPolicy}${method.origin === "task-dependency-pinned" ? ", task-pinned" : ""})`,
      content,
    );
  }
  for (const skill of basis.resolution.skills) {
    const meta = sqlite.prepare("SELECT slug, name, is_core FROM agent_space_skills WHERE skill_id=?")
      .get(skill.skillId) as { slug: string; name: string; is_core: number } | undefined;
    if (entryKind === "conversation" && input.promptText !== undefined && meta && !isStarterSkillApplicable(meta.slug, input.promptText)) {
      sections.push({ section: `skill:${skill.skillId}`, originalChars: 0, keptChars: 0, reason: "not-applicable-to-request" });
      continue;
    }
    let content: string;
    try {
      content = (await readSkillVersionContentBytes(getSkillVersionRow(skill.versionId))).toString("utf8");
    } catch (error) {
      throw new AgentSpaceError(
        "AGENT_SPACE_VERSION_INVALID",
        `required skill content ${skill.skillId}@${skill.versionId} failed verification (${(error as Error).message}); blocking the model call`,
      );
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
  // W5：状态包真实注入——按冻结 versionId 读内容，共享内容预算，逐段记录。
  for (const entry of basis.resolution.statePacket.entries) {
    const content = await readStateVersionContent(input.scope, entry.objectType, entry.versionId);
    pushContent(
      `state.${entry.objectType}:${entry.objectId}`,
      `## 状态(${entry.objectType}) ${entry.title} @ ${entry.versionId}`,
      JSON.stringify(content),
    );
  }
  lines.push(`状态包说明：${basis.resolution.statePacket.note}（检索 ${basis.resolution.statePacket.retrieval.scanned} 条，纳入 ${basis.resolution.statePacket.retrieval.included} 条，预算 ${basis.resolution.statePacket.retrieval.usedChars}/${basis.resolution.statePacket.retrieval.budgetChars}）`);
  for (const ex of basis.resolution.statePacket.exclusions) lines.push(`- state-excluded: ${ex.objectType}:${ex.objectId} — ${ex.reason}`);
  for (const item of basis.resolution.skipped) lines.push(`- skipped: ${item.kind}:${item.ref} — ${item.reason}`);
  for (const item of basis.resolution.pruned) lines.push(`- pruned: ${item.kind}:${item.ref} — ${item.reason}`);
  lines.push("未装配的内容（含任何旧 Workspace/默认技能）不可用；不要引用不存在的工具或文件。");

  // 返工 R5：平台 L1 基础段（身份/能力边界/事实纪律/工具原则/通道规则 +
  // 新对象契约方法论）与装配段组合——退出旧 Workspace 不等于删除平台纪律。
  const platformBase = buildPlatformBaseInstructions({
    ...(input.channel ? { channel: input.channel as UserContextChannel } : {}),
    agentSpaceAssembly: true,
  });
  const instructions = `${platformBase}\n\n${lines.join("\n")}`;

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
  return { instructions, tools, basisKey };
}

/** 测试/运维读取已记录注入与冻结 basis（幂等）。 */
export function getAssemblyRunBasis(scope: { userId: string; projectId: string; instanceId: string }, basisKey: string) {
  return getRunBasis(scope, basisKey);
}

/** 供入口显式标注（generic runner / scheduled tasks）：仅在启用时携带。 */
export function assemblyEntryAnnotation(entryKind: AssemblyEntryKind, userId: string): { _agentSpaceAssembly?: AssemblyEntryKind } {
  return isAgentSpaceAssemblyModeEnabled(userId) ? { _agentSpaceAssembly: entryKind } : {};
}
