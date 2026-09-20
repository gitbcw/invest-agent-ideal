/**
 * W4：Agent 空间控制面与运行时装配。
 *
 * 装配顺序（W4 执行稿）：认证 scope → 固定已安装 Skill / 绑定 Method /
 * asset grant 版本 → 按任务 dependencies 收窄 → 取得预算 State Packet →
 * 记录可解释 run-basis（Agent、版本、资产、状态、裁剪/跳过原因）。
 *
 * 边界：
 * - 只读 DB 读模型 + 域服务解析；不触碰旧 Workspace（无任何 fs/list/grep/
 *   discover 路径）；兼容读取必须显式、按需、可观察（未来入口）并写入
 *   run-basis——本模块不提供隐式兼容读取。
 * - 版本在装配时固定为具体 versionId + checksum：并发更新（升级/换绑）不
 *   替换本轮 basis；正文按 versionId 随后经 W2/W3 校验读取路径取回。
 * - agent_state 注册面在 W5 落地：依赖与状态包中以明确标注的桩呈现，
 *   fail-closed，不猜测内容。
 */
import { sqlite } from "../../db/index.js";
import {
  AgentSpaceError,
  assertScopeValid,
  newId,
  nowIso,
  recordAgentSpaceAudit,
  type UserScope,
} from "./core.js";
import { resolveMethodVersion } from "./methods.js";
import { getInstalledSkillManifest } from "./agents.js";
import { listTaskDependencies } from "./tasks.js";
import { listEffectiveState } from "./state.js";

export type AssemblyEntryKind = "conversation" | "generic_automation" | "scheduled";

export interface PruneSkipRecord {
  kind: string;
  ref: string;
  reason: string;
}

export interface TruncationRecord {
  section: string;
  originalChars: number;
  keptChars: number;
  reason: string;
}

export interface StatePacketEntry {
  objectType: "lesson" | "workflow";
  objectId: string;
  versionId: string;
  title: string;
  contentChars: number;
}

export interface ResolvedRunBasisContent {
  entryKind: AssemblyEntryKind;
  agent: { agentId: string; name: string };
  skills: Array<{ skillId: string; versionId: string; source: "release" | "private"; releaseId: string | null; contentRefType: string; contentChecksum: string }>;
  methods: Array<{ methodId: string; versionId: string; versionPolicy: "pinned" | "current"; contentChecksum: string; assetVersionId: string | null }>;
  assets: Array<{ assetId: string }>;
  statePacket: {
    lessons: StatePacketEntry[];
    workflows: StatePacketEntry[];
    agentState: { status: "stub"; note: string };
    budgetChars: number;
    usedChars: number;
    offset: number;
    totalEntries: number;
    hasMore: boolean;
  };
  pruned: PruneSkipRecord[];
  skipped: PruneSkipRecord[];
  truncations: TruncationRecord[];
  context: { conversationId: string | null; taskId: string | null; runId: string | null };
}

export interface RunBasisRecord extends ResolvedRunBasisContent {
  basisId: string;
  basisKey: string;
  createdAt: string;
}

const DEFAULT_STATE_BUDGET_CHARS = 20000;

/**
 * 解析并记录一次运行依据（run-basis）。幂等：同 basisKey 且内容一致返回既有
 * 记录；内容不同为冲突（同一入口键的装配发生了不可解释的变化）。
 */
export function assembleAndRecordRunBasis(input: {
  scope: UserScope;
  agentId: string;
  entryKind: AssemblyEntryKind;
  basisKey: string;
  conversationId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  stateBudgetChars?: number;
  stateOffset?: number;
  actor: string;
}): RunBasisRecord {
  assertScopeValid(input.scope);
  if (!input.basisKey?.trim()) throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "basisKey is required");
  const content = resolveRunBasisContent(input);
  const payload = JSON.stringify(content);
  const existing = sqlite
    .prepare("SELECT basis_id, basis_json, created_at FROM agent_space_run_basis WHERE basis_key=?")
    .get(input.basisKey) as { basis_id: string; basis_json: string; created_at: string } | undefined;
  if (existing) {
    if (existing.basis_json !== payload) {
      throw new AgentSpaceError(
        "AGENT_SPACE_IDEMPOTENCY_CONFLICT",
        `run basis ${input.basisKey} already exists with different content; assembly for one key must be recorded once`,
      );
    }
    return { basisId: existing.basis_id, basisKey: input.basisKey, createdAt: existing.created_at, ...content };
  }
  const basisId = newId("rbasis");
  const now = nowIso();
  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO agent_space_run_basis (
           basis_id, basis_key, domain, user_id, project_id, instance_id,
           agent_id, entry_kind, conversation_id, task_id, run_id, basis_json, created_at
         ) VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(basisId, input.basisKey, input.scope.userId, input.scope.projectId, input.scope.instanceId,
           input.agentId, input.entryKind, input.conversationId ?? null, input.taskId ?? null,
           input.runId ?? null, payload, now);
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: "run_basis.recorded",
      objectType: "agent_space_run_basis",
      objectId: basisId,
      toStatus: "recorded",
      detail: {
        basisKey: input.basisKey,
        entryKind: input.entryKind,
        agentId: input.agentId,
        skills: content.skills.length,
        methods: content.methods.length,
        assets: content.assets.length,
        pruned: content.pruned.length,
        skipped: content.skipped.length,
      },
    });
  });
  tx();
  return { basisId, basisKey: input.basisKey, createdAt: now, ...content };
}

/** 最小查询面：按 scope 读取 run-basis（幂等回放/审计用）。 */
export function getRunBasis(scope: UserScope, basisKey: string): RunBasisRecord {
  assertScopeValid(scope);
  const row = sqlite
    .prepare("SELECT * FROM agent_space_run_basis WHERE basis_key=?")
    .get(basisKey) as
    | {
        basis_id: string; basis_key: string; user_id: string; project_id: string; instance_id: string;
        basis_json: string; created_at: string;
      }
    | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `run basis ${basisKey}`);
  if (row.user_id !== scope.userId || row.project_id !== scope.projectId || row.instance_id !== scope.instanceId) {
    throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", "run basis belongs to another scope");
  }
  return { basisId: row.basis_id, basisKey: row.basis_key, createdAt: row.created_at, ...(JSON.parse(row.basis_json) as ResolvedRunBasisContent) };
}

function resolveRunBasisContent(input: {
  scope: UserScope;
  agentId: string;
  entryKind: AssemblyEntryKind;
  conversationId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  stateBudgetChars?: number;
  stateOffset?: number;
}): ResolvedRunBasisContent {
  const { scope } = input;
  // 1) 认证 scope → Agent 必须真实存在、同 scope 且处于 active（未启用/禁用
  //    的 Agent 不进入上下文）。
  const agent = sqlite
    .prepare("SELECT agent_id, name, status, user_id, project_id, instance_id FROM agent_space_agents WHERE agent_id=?")
    .get(input.agentId) as
    | { agent_id: string; name: string; status: string; user_id: string; project_id: string; instance_id: string }
    | undefined;
  if (!agent) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `agent ${input.agentId}`);
  if (agent.user_id !== scope.userId || agent.project_id !== scope.projectId || agent.instance_id !== scope.instanceId) {
    throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", "agent belongs to another scope");
  }
  if (agent.status !== "active") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `agent is ${agent.status}; only active agents assemble a run basis`);
  }
  if (input.entryKind === "conversation" && !input.conversationId) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "conversation entries require conversationId");
  }
  if (input.entryKind !== "conversation" && !input.taskId) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `${input.entryKind} entries require taskId`);
  }

  const pruned: PruneSkipRecord[] = [];
  const skipped: PruneSkipRecord[] = [];
  const truncations: TruncationRecord[] = [];

  // 2) 固定已安装 Skill / 绑定 Method / asset grant 版本。
  const installedSkills = getInstalledSkillManifest(scope, input.agentId);
  const skills: ResolvedRunBasisContent["skills"] = installedSkills.map((s) => ({
    skillId: s.skillId, versionId: s.versionId, source: s.source, releaseId: s.releaseId,
    contentRefType: s.contentRefType, contentChecksum: s.contentChecksum,
  }));
  const bindings = sqlite
    .prepare(
      `SELECT method_id, version_policy, pinned_version_id FROM agent_space_agent_method_bindings
       WHERE agent_id=? AND user_id=? AND project_id=? AND instance_id=? AND status='active'`,
    )
    .all(input.agentId, scope.userId, scope.projectId, scope.instanceId) as Array<{
      method_id: string; version_policy: "pinned" | "current"; pinned_version_id: string | null;
    }>;
  const methods: ResolvedRunBasisContent["methods"] = [];
  for (const binding of bindings) {
    try {
      const resolved = resolveMethodVersion(scope, binding.method_id, binding.version_policy === "pinned" ? binding.pinned_version_id ?? undefined : undefined);
      methods.push({
        methodId: binding.method_id,
        versionId: resolved.version.version_id,
        versionPolicy: binding.version_policy,
        contentChecksum: resolved.version.content_checksum,
        assetVersionId: resolved.version.asset_version_id,
      });
    } catch (error) {
      skipped.push({ kind: "method", ref: binding.method_id, reason: (error as Error).message });
    }
  }
  const grants = sqlite
    .prepare(
      `SELECT asset_id, expires_at FROM agent_space_agent_asset_grants
       WHERE agent_id=? AND user_id=? AND project_id=? AND instance_id=? AND status='active'`,
    )
    .all(input.agentId, scope.userId, scope.projectId, scope.instanceId) as Array<{ asset_id: string; expires_at: string | null }>;
  const now = nowIso();
  const assets: ResolvedRunBasisContent["assets"] = [];
  for (const grant of grants) {
    if (grant.expires_at && grant.expires_at <= now) {
      pruned.push({ kind: "asset", ref: grant.asset_id, reason: "grant-expired" });
      continue;
    }
    assets.push({ assetId: grant.asset_id });
  }

  // 3) 按任务 dependencies 收窄（automation/scheduled 入口）。无依赖记录的
  //    任务不收窄（basis 记录 no-dependencies-defined），有依赖则严格交集，
  //    未覆盖项一律 pruned/skipped 且写明原因。
  let narrowedSkills = skills;
  let narrowedMethods = methods;
  let narrowedAssets = assets;
  const deps = input.taskId ? listTaskDependencies(scope, input.taskId) : [];
  if (input.taskId && deps.length > 0) {
    const depSkills = new Map(deps.filter((d) => d.kind === "skill").map((d) => [d.ref_id, d]));
    const depMethods = new Map(deps.filter((d) => d.kind === "method").map((d) => [d.ref_id, d]));
    const depAssets = new Map(deps.filter((d) => d.kind === "asset_input" || d.kind === "asset_output").map((d) => [d.ref_id, d]));
    narrowedSkills = [];
    for (const s of skills) {
      const dep = depSkills.get(s.skillId);
      if (!dep) {
        pruned.push({ kind: "skill", ref: s.skillId, reason: "not-in-task-dependencies" });
        continue;
      }
      if (dep.pinned_version_id && dep.pinned_version_id !== s.versionId) {
        skipped.push({ kind: "skill", ref: s.skillId, reason: `dependency pins version ${dep.pinned_version_id} but ${s.versionId} is installed` });
        continue;
      }
      narrowedSkills.push(s);
    }
    narrowedMethods = [];
    for (const m of methods) {
      const dep = depMethods.get(m.methodId);
      if (!dep) {
        pruned.push({ kind: "method", ref: m.methodId, reason: "not-in-task-dependencies" });
        continue;
      }
      if (dep.pinned_version_id && dep.pinned_version_id !== m.versionId) {
        skipped.push({ kind: "method", ref: m.methodId, reason: `dependency pins version ${dep.pinned_version_id} but resolver returned ${m.versionId}` });
        continue;
      }
      narrowedMethods.push(m);
    }
    narrowedAssets = [];
    for (const a of assets) {
      if (!depAssets.has(a.assetId)) {
        pruned.push({ kind: "asset", ref: a.assetId, reason: "not-in-task-dependencies" });
        continue;
      }
      narrowedAssets.push(a);
    }
    for (const dep of deps) {
      if (dep.kind === "agent_state") {
        skipped.push({ kind: "agent_state", ref: dep.ref_id, reason: "agent_state registry lands in W5 (W1 fail-closed stub)" });
        continue;
      }
      const pool = dep.kind === "skill" ? narrowedSkills.map((x) => x.skillId) : dep.kind === "method" ? narrowedMethods.map((x) => x.methodId) : narrowedAssets.map((x) => x.assetId);
      if (!pool.includes(dep.ref_id)) {
        skipped.push({ kind: dep.kind, ref: dep.ref_id, reason: "declared dependency missing from the agent assembly (not installed/bound/granted or version mismatch)" });
      }
    }
  }

  // 4) 预算 State Packet：有效 lesson/workflow 按 offset 分页、按字符预算
  //    截断，超出部分写明原因；agent_state 为明确标注的 W5 桩。
  const budgetChars = input.stateBudgetChars ?? DEFAULT_STATE_BUDGET_CHARS;
  const offset = input.stateOffset ?? 0;
  if (offset < 0) throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "stateOffset must be >= 0");
  const effective = [
    ...listEffectiveState({ scope, kind: "lesson" }).map((e) => ({ objectType: "lesson" as const, ...e })),
    ...listEffectiveState({ scope, kind: "workflow" }).map((e) => ({ objectType: "workflow" as const, ...e })),
  ];
  const paged = effective.slice(offset);
  const lessons: StatePacketEntry[] = [];
  const workflows: StatePacketEntry[] = [];
  let usedChars = 0;
  let hasMore = false;
  for (let i = 0; i < paged.length; i += 1) {
    const entry = paged[i]!;
    const chars = JSON.stringify(entry.content ?? {}).length;
    if (usedChars + chars > budgetChars && (lessons.length > 0 || workflows.length > 0)) {
      hasMore = true;
      for (const rest of paged.slice(i)) {
        truncations.push({ section: `state.${rest.objectType}:${rest.objectId}`, originalChars: JSON.stringify(rest.content ?? {}).length, keptChars: 0, reason: "state-budget-exceeded" });
      }
      break;
    }
    if (chars > budgetChars) {
      truncations.push({ section: `state.${entry.objectType}:${entry.objectId}`, originalChars: chars, keptChars: budgetChars, reason: "entry-exceeds-state-budget; content truncated to a preview" });
    }
    usedChars += Math.min(chars, budgetChars);
    const record: StatePacketEntry = { objectType: entry.objectType, objectId: entry.objectId, versionId: entry.versionId, title: entry.title, contentChars: chars };
    if (entry.objectType === "lesson") lessons.push(record);
    else workflows.push(record);
  }

  return {
    entryKind: input.entryKind,
    agent: { agentId: agent.agent_id, name: agent.name },
    skills: narrowedSkills,
    methods: narrowedMethods,
    assets: narrowedAssets,
    statePacket: {
      lessons,
      workflows,
      agentState: { status: "stub", note: "agent_state registry lands in W5; the packet reserves a clearly-marked empty slot (fail-closed)" },
      budgetChars,
      usedChars,
      offset,
      totalEntries: effective.length,
      hasMore,
    },
    pruned,
    skipped,
    truncations,
    context: { conversationId: input.conversationId ?? null, taskId: input.taskId ?? null, runId: input.runId ?? null },
  };
}
