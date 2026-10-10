/**
 * 「我的策略」域动作（2026-10-08 owner 裁决）：策略 = 方法域对象，多策略并存、
 * 主策略唯一（agent 的方法绑定即主策略，常驻装配）；非主策略不常驻，可被点名
 * 使用（strategy.read 按需读取）。统一对用户呈现「策略」名称；服务层标识符
 * 沿用 method 域（对象、表、装配链均复用，不另起存储）。
 *
 * 供对话 Agent 的 strategy.* 服务工具与 Portal「我的策略」页共同使用；
 * 凭证走 registerPortalActionAuthorization（与技能/方法 portal 动作同机制）。
 */
import { sqlite } from "../../db/index.js";
import { AgentSpaceError } from "./core.js";
import {
  createMethod,
  addMethodVersion,
  approveMethodVersion,
  getMethod,
  readMethodVersionContent,
} from "./methods.js";
import { bindMethod } from "./agents.js";
import { commitWorkspaceContent, registerPortalActionAuthorization } from "./portal-actions.js";
// setPrimaryStrategy 可选指定 agent；缺省由调用方保证唯一交互身份。

export interface StrategyScope {
  userId: string;
  projectId: string;
  instanceId: string;
}

function strategyRow(scope: StrategyScope, methodId: string): ReturnType<typeof getMethod> {
  return getMethod(scope, methodId);
}

function primaryBinding(scope: StrategyScope): { agentId: string; methodId: string } | null {
  const row = sqlite
    .prepare(
      `SELECT b.agent_id AS agentId, b.method_id AS methodId
       FROM agent_space_agent_method_bindings b
       JOIN agent_space_agents a ON a.agent_id = b.agent_id
       WHERE b.user_id=? AND b.project_id=? AND b.instance_id=? AND b.status='active' AND a.status='active'
       LIMIT 1`,
    )
    .get(scope.userId, scope.projectId, scope.instanceId) as { agentId: string; methodId: string } | undefined;
  return row ?? null;
}

export interface StrategyCard {
  strategyId: string;
  name: string;
  status: string;
  /** framework=投资框架（整体常驻，不参与主策略）；strategy=策略（主策略唯一）。 */
  kind: "framework" | "strategy";
  isPrimary: boolean;
  currentVersionId: string | null;
  currentVersionStatus: string | null;
  updated_at: string;
  taskBindingCount: number;
}

export function listStrategies(scope: StrategyScope): StrategyCard[] {
  const primary = primaryBinding(scope);
  const rows = sqlite
    .prepare(
      `SELECT m.method_id, m.name, m.status, m.current_version_id, m.updated_at, m.kind,
              (SELECT v.status FROM agent_space_method_versions v WHERE v.version_id = m.current_version_id) AS version_status,
              (SELECT COUNT(*) FROM agent_space_task_dependencies d
                WHERE d.user_id=m.user_id AND d.project_id=m.project_id AND d.instance_id=m.instance_id
                  AND d.kind='method' AND d.ref_id=m.method_id) AS task_count
       FROM agent_space_methods m
       WHERE m.user_id=? AND m.project_id=? AND m.instance_id=? AND m.status != 'retired'
       ORDER BY (m.kind = 'framework') DESC, (m.method_id = ?) DESC, m.updated_at DESC`,
    )
    .all(scope.userId, scope.projectId, scope.instanceId, primary?.methodId ?? "") as Array<{
      method_id: string; name: string; status: string; current_version_id: string | null; updated_at: string;
      kind: string; version_status: string | null; task_count: number;
    }>;
  return rows.map((row) => ({
    strategyId: row.method_id,
    name: row.name,
    status: row.status,
    kind: row.kind === "framework" ? "framework" as const : "strategy" as const,
    isPrimary: primary?.methodId === row.method_id,
    currentVersionId: row.current_version_id,
    currentVersionStatus: row.version_status,
    updated_at: row.updated_at,
    taskBindingCount: row.task_count,
  }));
}

/**
 * 创建策略：内容经 commitWorkspaceContent 落 method_content 资产（「我的文件」
 * 默认隐藏），创建对象 + 首版本（直接 approved，内容已经用户在会话中确认）。
 * 当前无主策略时自动绑定为主策略（保存即生效）；已有主策略则创建为非主策略。
 */
export async function createStrategy(input: {
  scope: StrategyScope;
  name: string;
  text: string;
  actor: string;
  idempotencyKey: string;
}): Promise<{ strategy: StrategyCard; becamePrimary: boolean }> {
  const name = input.name.trim();
  if (!name) throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "strategy name must be non-empty");
  if (!input.text.trim()) throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "strategy text must be non-empty");
  const content = await commitWorkspaceContent({
    scope: input.scope,
    fileName: `strategy-${Date.now()}.md`,
    bytes: Buffer.from(input.text, "utf8"),
    idempotencyKey: `${input.idempotencyKey}:content`,
    source: "method_content",
  });
  const method = createMethod({ scope: input.scope, name, kind: "strategy", actor: input.actor, idempotencyKey: `${input.idempotencyKey}:method` });
  const version = await addMethodVersion({
    scope: input.scope,
    methodId: method.method_id,
    contentRef: { assetId: content.assetId, assetVersionId: content.assetVersionId, contentChecksum: content.contentChecksum },
    origin: "user",
    actor: input.actor,
  });
  const approvalRef = registerPortalActionAuthorization({
    scope: input.scope,
    operation: "method.version.approve",
    objectType: "agent_space_method_version",
    objectId: version.version_id,
    versionId: version.version_id,
    extraBinding: { methodId: method.method_id, adopt: "true" },
    sourceRef: `${input.scope.userId}:${input.idempotencyKey}:approve`,
    actor: input.actor,
  });
  approveMethodVersion({
    scope: input.scope,
    methodId: method.method_id,
    versionId: version.version_id,
    approvedBy: input.actor,
    approvalRef,
    adopt: true,
    actor: input.actor,
  });
  let becamePrimary = false;
  if (!primaryBinding(input.scope)) {
    // 自动绑主只在该 scope 恰好一个 active agent 时进行；多个 active agent
    // 无法确定交互身份，策略照常保存、不自动绑定（用户经 set_primary 指定）。
    const soleAgent = soleActiveAgentId(input.scope);
    if (soleAgent) {
      bindMethod({ scope: input.scope, agentId: soleAgent, methodId: method.method_id, versionPolicy: "current", actor: input.actor });
      becamePrimary = true;
    }
  }
  return { strategy: cardOf(input.scope, method.method_id), becamePrimary };
}

/** 编辑策略：新 approved 版本（主策略的常驻内容随下轮装配更新）。 */
export async function editStrategy(input: {
  scope: StrategyScope;
  strategyId: string;
  text: string;
  actor: string;
  idempotencyKey: string;
}): Promise<StrategyCard> {
  const strategy = strategyRow(input.scope, input.strategyId);
  const versionRow = strategy.current_version_id
    ? sqlite.prepare("SELECT asset_id, asset_version_id FROM agent_space_method_versions WHERE version_id=?").get(strategy.current_version_id) as { asset_id: string | null; asset_version_id: string | null } | undefined
    : undefined;
  const content = await commitWorkspaceContent({
    scope: input.scope,
    ...(versionRow?.asset_id ? { assetId: versionRow.asset_id } : {}),
    fileName: `strategy-${Date.now()}.md`,
    bytes: Buffer.from(input.text, "utf8"),
    idempotencyKey: input.idempotencyKey,
    source: "method_content",
  });
  const version = await addMethodVersion({
    scope: input.scope,
    methodId: strategy.method_id,
    contentRef: { assetId: content.assetId, assetVersionId: content.assetVersionId, contentChecksum: content.contentChecksum },
    origin: "user",
    actor: input.actor,
  });
  const approvalRef = registerPortalActionAuthorization({
    scope: input.scope,
    operation: "method.version.approve",
    objectType: "agent_space_method_version",
    objectId: version.version_id,
    versionId: version.version_id,
    extraBinding: { methodId: strategy.method_id, adopt: "true" },
    sourceRef: `${input.scope.userId}:${input.idempotencyKey}:approve`,
    actor: input.actor,
  });
  approveMethodVersion({
    scope: input.scope,
    methodId: strategy.method_id,
    versionId: version.version_id,
    approvedBy: input.actor,
    approvalRef,
    adopt: true,
    actor: input.actor,
  });
  return cardOf(input.scope, strategy.method_id);
}

/** 切换主策略：换绑语义（bindMethod 内部将旧主策略置 superseded）。 */
export function setPrimaryStrategy(input: { scope: StrategyScope; strategyId: string; actor: string; agentId?: string }): StrategyCard {
  const strategy = strategyRow(input.scope, input.strategyId);
  if (strategy.kind === "framework") {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "投资框架整体常驻，不参与主策略切换");
  }
  const agentId = input.agentId ?? soleActiveAgentId(input.scope);
  if (!agentId) throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "切换主策略需要唯一的 active agent（或显式 agentId）");
  bindMethod({ scope: input.scope, agentId, methodId: strategy.method_id, versionPolicy: "current", actor: input.actor });
  return cardOf(input.scope, strategy.method_id);
}

/** 重命名策略：仅改显示名，内容版本与绑定关系不变；供 agent/Portal 纠正命名。 */
export function renameStrategy(input: { scope: StrategyScope; strategyId: string; name: string; actor: string }): StrategyCard {
  const name = input.name.trim();
  if (!name) throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "strategy name must be non-empty");
  const strategy = strategyRow(input.scope, input.strategyId);
  const dup = sqlite
    .prepare(
      `SELECT method_id FROM agent_space_methods
       WHERE user_id=? AND project_id=? AND instance_id=? AND name=? AND status != 'retired' AND method_id != ?`,
    )
    .get(input.scope.userId, input.scope.projectId, input.scope.instanceId, name, strategy.method_id);
  if (dup) throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "同名策略已存在，先重命名或退役旧条目");
  sqlite.prepare("UPDATE agent_space_methods SET name=?, updated_at=? WHERE method_id=?").run(
    name,
    new Date().toISOString(),
    strategy.method_id,
  );
  return cardOf(input.scope, strategy.method_id);
}

/** 读取策略当前采用版本正文（非主策略按需使用；主策略也可显式复核）。 */
export async function readStrategyContent(input: { scope: StrategyScope; strategyId: string }): Promise<{ strategyId: string; name: string; text: string; versionId: string }> {
  const strategy = strategyRow(input.scope, input.strategyId);
  if (!strategy.current_version_id) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `strategy ${input.strategyId} has no adopted version`);
  const read = await readMethodVersionContent(input.scope, strategy.current_version_id);
  return { strategyId: strategy.method_id, name: strategy.name, text: read.bytes.toString("utf8"), versionId: strategy.current_version_id };
}

function soleActiveAgentId(scope: StrategyScope): string | null {
  const rows = sqlite
    .prepare("SELECT agent_id AS agentId FROM agent_space_agents WHERE user_id=? AND project_id=? AND instance_id=? AND status='active' LIMIT 2")
    .all(scope.userId, scope.projectId, scope.instanceId) as Array<{ agentId: string }>;
  return rows.length === 1 ? rows[0]!.agentId : null;
}

function cardOf(scope: StrategyScope, methodId: string): StrategyCard {
  const card = listStrategies(scope).find((s) => s.strategyId === methodId);
  if (!card) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `strategy ${methodId}`);
  return card;
}
