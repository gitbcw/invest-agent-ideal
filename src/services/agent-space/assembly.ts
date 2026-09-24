/**
 * W4（返工后）：Agent 空间控制面与运行时装配。
 *
 * 装配顺序（W4 执行稿）：认证 scope → 固定已安装 Skill/绑定 Method/asset grant
 * 版本 → 按任务 dependencies 收窄 → State Packet → 记录可解释 run-basis。
 * 返工要点（W4 验收 R1-R4）：
 * - 入口身份链必须真实：conversation/task/run 均核对存在、scope 与归属
 *   （run→task 链、依赖声明的执行 Agent）；非法输入不落 basis/审计。
 * - basis_key 按 scope 命名空间（存储键含 scope 限定），不同 scope 同 key
 *   互不冲突；同 scope 同请求重试读取**已冻结** basis（配置升级不拒绝合法
 *   重试），不同请求复用同 key 才冲突。
 * - 任务入口严格按依赖装配：无依赖=显式空集（旧任务标记未就绪）；依赖
 *   pin 的正式版本直接执行（Agent 已升级不迫使其跳版本）；资产解析
 *   version+checksum 并保留 input/output 角色；必需依赖不满足**阻断**
 *   （不把空装配当可运行成功）。
 * - State Packet 是真正的空桩：lesson/workflow 也为空，明确
 *   not-integrated-until-W5，不检索任何长期状态。
 * - run-basis 区分 resolution（解析）/ injection（实际注入与裁剪，由真实
 *   入口接线回写）/ execution（W5 待接）。
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
import { buildScopedStatePacket, readStateVersionContent, type StatePacketExclusion } from "./state.js";
import { getVersionRow as getSkillVersionRow } from "./skills.js";

export type AssemblyEntryKind = "conversation" | "generic_automation" | "scheduled";

export interface PruneSkipRecord {
  kind: string;
  ref: string;
  reason: string;
}

export interface ResolvedSkillEntry {
  skillId: string;
  versionId: string;
  source: "release" | "private";
  releaseId: string | null;
  contentRefType: string;
  contentChecksum: string;
  origin: "installed" | "task-dependency-pinned";
}

export interface ResolvedMethodEntry {
  methodId: string;
  versionId: string;
  versionPolicy: "pinned" | "current";
  contentChecksum: string;
  assetVersionId: string | null;
  origin: "binding" | "task-dependency-pinned";
}

export interface ResolvedAssetEntry {
  assetId: string;
  role: "input" | "output" | "grant";
  versionId: string;
  contentChecksum: string;
  origin: "grant" | "task-dependency-pinned" | "task-dependency-current";
}

export interface ResolvedRunBasisContent {
  entryKind: AssemblyEntryKind;
  agent: { agentId: string; name: string };
  skills: ResolvedSkillEntry[];
  methods: ResolvedMethodEntry[];
  assets: ResolvedAssetEntry[];
  statePacket: {
    entries: Array<{ objectType: "lesson" | "workflow"; objectId: string; versionId: string; title: string; contentChars: number }>;
    exclusions: StatePacketExclusion[];
    retrieval: { scanned: number; included: number; budgetChars: number; usedChars: number; scopeOwners: Array<{ ownerKind: string; ownerId: string }> };
    note: string;
  };
  pruned: PruneSkipRecord[];
  skipped: PruneSkipRecord[];
  context: { conversationId: string | null; taskId: string | null; runId: string | null };
}

export interface InjectionAttempt {
  attemptNo: number;
  sections: Array<{ section: string; originalChars: number; keptChars: number; reason?: string }>;
  tools: string[];
  workspace: null;
  injectedAt: string;
}

export interface RunBasisInjection {
  /** 最近一次真实注入（与该次实际发送的模型输入一致；R9 逐尝试记录）。 */
  sections: InjectionAttempt["sections"];
  tools: string[];
  workspace: null;
  injectedAt: string;
  attemptNo: number;
  /** 逐尝试历史：预算/工具授权变化的重试产生新尝试，关联同一冻结 resolution。 */
  attempts: InjectionAttempt[];
}

export interface RunBasisRecord {
  basisId: string;
  basisKey: string;
  resolution: ResolvedRunBasisContent;
  injection: RunBasisInjection | null;
  execution: { status: "pending-w5" };
  createdAt: string;
}

interface BasisRequestIdentity {
  agentId: string;
  entryKind: AssemblyEntryKind;
  conversationId: string | null;
  taskId: string | null;
  runId: string | null;
}

const DEFAULT_STATE_BUDGET_CHARS = 20_000;
const STATE_PACKET_NOTE = "state is read-only: it cannot create tasks, write assets, or send notifications";

/** 存储键按 scope 命名空间：不同 scope 的同名 basisKey 永不冲突。 */
function scopedBasisKey(scope: UserScope, basisKey: string): string {
  return `${scope.userId}|${scope.projectId}|${scope.instanceId}|${basisKey}`;
}

/**
 * 解析并记录一次运行依据（run-basis）。
 * 幂等（冻结语义）：同 scope 同 key 且请求身份一致 → 直接返回已冻结 basis
 * （配置随后升级不影响合法重试）；请求身份不同 → 冲突。非法入口身份在
 * 记录前拒绝（不落 basis/审计）。
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
  actor: string;
}): RunBasisRecord {
  assertScopeValid(input.scope);
  if (!input.basisKey?.trim()) throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "basisKey is required");
  const identity: BasisRequestIdentity = {
    agentId: input.agentId,
    entryKind: input.entryKind,
    conversationId: input.conversationId ?? null,
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
  };
  // 冻结回放先于一切解析：同请求重试读已冻结 basis，不重算、不因配置漂移拒绝。
  const storedKey = scopedBasisKey(input.scope, input.basisKey);
  const existing = readBasisRow(storedKey);
  if (existing) {
    const storedIdentity = JSON.parse(existing.request_json) as BasisRequestIdentity;
    if (
      storedIdentity.agentId !== identity.agentId || storedIdentity.entryKind !== identity.entryKind
      || storedIdentity.conversationId !== identity.conversationId || storedIdentity.taskId !== identity.taskId
      || storedIdentity.runId !== identity.runId
    ) {
      throw new AgentSpaceError(
        "AGENT_SPACE_IDEMPOTENCY_CONFLICT",
        `run basis ${input.basisKey} already exists for a different request in this scope`,
      );
    }
    return rowToRecord(existing, input.basisKey);
  }
  // 入口身份链核验 + 解析（任何失败都在写入之前抛出）。
  verifyEntryIdentity(input.scope, identity);
  const resolution = resolveRunBasisContent(input.scope, identity, input.stateBudgetChars);
  const payload = JSON.stringify(resolution);
  const basisId = newId("rbasis");
  const now = nowIso();
  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO agent_space_run_basis (
           basis_id, basis_key, domain, user_id, project_id, instance_id,
           agent_id, entry_kind, conversation_id, task_id, run_id,
           request_json, basis_json, injection_json, created_at
         ) VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(basisId, storedKey, input.scope.userId, input.scope.projectId, input.scope.instanceId,
           input.agentId, input.entryKind, identity.conversationId, identity.taskId, identity.runId,
           JSON.stringify(identity), payload, now);
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
        skills: resolution.skills.length,
        methods: resolution.methods.length,
        assets: resolution.assets.length,
        pruned: resolution.pruned.length,
        skipped: resolution.skipped.length,
      },
    });
  });
  tx();
  const stored = readBasisRow(storedKey)!;
  return rowToRecord(stored, input.basisKey);
}

/**
 * 注入记录归一化（返工 R9 续）：956f9bd 产生的合法旧结构没有 attempts
 * 数组——读取时**无损归一化**为第一条历史尝试（保留原时间戳/sections/
 * tools），不清库、不重写；重复升级不重复历史。
 */
function parseInjectionAttempts(raw: string): InjectionAttempt[] {
  const parsed = JSON.parse(raw) as Partial<InjectionAttempt> & { attempts?: unknown };
  if (Array.isArray(parsed.attempts) && parsed.attempts.length > 0) return parsed.attempts as InjectionAttempt[];
  if (Array.isArray(parsed.attempts) && parsed.attempts.length === 0) {
    // 空尝试数组视为未注入。
    return [];
  }
  return [{
    attemptNo: 1,
    sections: parsed.sections ?? [],
    tools: parsed.tools ?? [],
    workspace: null,
    injectedAt: parsed.injectedAt ?? nowIso(),
  }];
}

/**
 * 真实入口接线回写**本次尝试**的实际注入记录（返工 R9）：预算或工具授权
 * 变化的重试产生新尝试（关联同一冻结 resolution）；与最近一次完全一致的
 * 尝试不重复记录。记录与该次实际发送的模型输入一致。
 */
export function recordRunBasisInjection(
  scope: UserScope,
  basisKey: string,
  injection: { sections: InjectionAttempt["sections"]; tools: string[]; workspace: null },
): RunBasisRecord {
  assertScopeValid(scope);
  const storedKey = scopedBasisKey(scope, basisKey);
  const existing = readBasisRow(storedKey);
  if (!existing) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `run basis ${basisKey}`);
  if (existing.user_id !== scope.userId || existing.project_id !== scope.projectId || existing.instance_id !== scope.instanceId) {
    throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", "run basis belongs to another scope");
  }
  const previousAttempts = existing.injection_json ? parseInjectionAttempts(existing.injection_json) : [];
  const last = previousAttempts[previousAttempts.length - 1];
  const sameAsLast = last
    && JSON.stringify({ sections: last.sections, tools: last.tools }) === JSON.stringify({ sections: injection.sections, tools: injection.tools });
  if (!sameAsLast) {
    const attempt: InjectionAttempt = {
      attemptNo: previousAttempts.length + 1,
      sections: injection.sections,
      tools: injection.tools,
      workspace: null,
      injectedAt: nowIso(),
    };
    const attempts = [...previousAttempts, attempt];
    const stored = { ...attempt, attempts };
    sqlite
      .prepare("UPDATE agent_space_run_basis SET injection_json=? WHERE basis_key=?")
      .run(JSON.stringify(stored), storedKey);
  }
  return rowToRecord(readBasisRow(storedKey)!, basisKey);
}

/**
 * 状态包续页（返工 R2）：**绑定冻结 basis** 的 continuation——总预算在首次
 * 检索时冻结（调用方无法换更大预算拿回被排除项），去重/冲突/预算排除集
 * 合共享同一冻结集合；hasMore 在仍有下一页时为 true；伪 cursor（越界页）
 * 返回空页。条目正文按冻结 versionId 重读，与 run-basis 证据一致。
 */
export function getRunBasisStateContinuation(input: {
  scope: UserScope;
  basisKey: string;
  page: number;
  pageSize: number;
}): {
  entries: Array<{ objectType: "lesson" | "workflow"; objectId: string; versionId: string; title: string; content: Record<string, unknown>; contentChars: number }>;
  hasMore: boolean;
  totalIncluded: number;
  budgetChars: number;
  note: string;
} {
  assertScopeValid(input.scope);
  const basis = getRunBasis(input.scope, input.basisKey);
  const frozen = basis.resolution.statePacket;
  const page = Math.max(0, Math.floor(input.page));
  const pageSize = Math.max(1, Math.floor(input.pageSize));
  const slice = frozen.entries.slice(page * pageSize, page * pageSize + pageSize);
  return {
    entries: slice.map((e) => {
      const content = readStateVersionContent(input.scope, e.objectType, e.versionId);
      return { ...e, content, contentChars: JSON.stringify(content).length };
    }),
    hasMore: page * pageSize + slice.length < frozen.entries.length,
    totalIncluded: frozen.entries.length,
    budgetChars: frozen.retrieval.budgetChars,
    note: frozen.note,
  };
}

/** 按（scope, basisKey）查找已冻结 basis；不存在返回 null（稳定身份解析用）。 */
export function findRunBasis(scope: UserScope, basisKey: string): RunBasisRecord | null {
  assertScopeValid(scope);
  const row = readBasisRow(scopedBasisKey(scope, basisKey));
  if (!row) return null;
  if (row.user_id !== scope.userId || row.project_id !== scope.projectId || row.instance_id !== scope.instanceId) {
    throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", "run basis belongs to another scope");
  }
  return rowToRecord(row, basisKey);
}

/** 最小查询面（scoped；冻结回放/审计用）。 */
export function getRunBasis(scope: UserScope, basisKey: string): RunBasisRecord {
  assertScopeValid(scope);
  const row = readBasisRow(scopedBasisKey(scope, basisKey));
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `run basis ${basisKey}`);
  if (row.user_id !== scope.userId || row.project_id !== scope.projectId || row.instance_id !== scope.instanceId) {
    throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", "run basis belongs to another scope");
  }
  return rowToRecord(row, basisKey);
}

interface BasisRow {
  basis_id: string; basis_key: string; user_id: string; project_id: string; instance_id: string;
  request_json: string; basis_json: string; injection_json: string | null; created_at: string;
}

function readBasisRow(storedKey: string): BasisRow | undefined {
  return sqlite
    .prepare("SELECT basis_id, basis_key, user_id, project_id, instance_id, request_json, basis_json, injection_json, created_at FROM agent_space_run_basis WHERE basis_key=?")
    .get(storedKey) as BasisRow | undefined;
}

function rowToRecord(row: BasisRow, callerKey: string): RunBasisRecord {
  let injection: RunBasisInjection | null = null;
  if (row.injection_json) {
    const attempts = parseInjectionAttempts(row.injection_json);
    const latest = attempts[attempts.length - 1];
    injection = latest ? { ...latest, attempts } : null;
  }
  return {
    basisId: row.basis_id,
    basisKey: callerKey,
    resolution: JSON.parse(row.basis_json) as ResolvedRunBasisContent,
    injection,
    execution: { status: "pending-w5" },
    createdAt: row.created_at,
  };
}

// ---------- 入口身份链（返工 R2） ----------

function verifyEntryIdentity(scope: UserScope, identity: BasisRequestIdentity): void {
  // Agent：真实存在、同 scope、active。
  const agent = sqlite
    .prepare("SELECT status, user_id, project_id, instance_id FROM agent_space_agents WHERE agent_id=?")
    .get(identity.agentId) as { status: string; user_id: string; project_id: string; instance_id: string } | undefined;
  if (!agent) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `agent ${identity.agentId}`);
  if (agent.user_id !== scope.userId || agent.project_id !== scope.projectId || agent.instance_id !== scope.instanceId) {
    throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", "agent belongs to another scope");
  }
  if (agent.status !== "active") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `agent is ${agent.status}; only active agents assemble a run basis`);
  }
  if (identity.entryKind === "conversation") {
    if (!identity.conversationId) throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "conversation entries require conversationId");
    const conversation = sqlite
      .prepare("SELECT user_id, project_id, instance_id FROM conversation_sessions WHERE conversation_id=?")
      .get(identity.conversationId) as { user_id: string; project_id: string; instance_id: string } | undefined;
    if (!conversation) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `conversation ${identity.conversationId}`);
    if (conversation.user_id !== scope.userId || conversation.project_id !== scope.projectId || conversation.instance_id !== scope.instanceId) {
      throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", "conversation belongs to another scope");
    }
    return;
  }
  // 任务类入口：task 真实存在且同 scope；run（如提供）必须属于该 task 且同 scope。
  if (!identity.taskId) throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `${identity.entryKind} entries require taskId`);
  const task = sqlite
    .prepare("SELECT user_id, project_id, instance_id FROM automation_tasks WHERE task_id=?")
    .get(identity.taskId) as { user_id: string; project_id: string; instance_id: string } | undefined;
  if (!task) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `automation task ${identity.taskId}`);
  if (task.user_id !== scope.userId || task.project_id !== scope.projectId || task.instance_id !== scope.instanceId) {
    throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", "task belongs to another scope");
  }
  if (identity.runId) {
    const run = sqlite
      .prepare("SELECT task_id, revision_id, user_id, project_id, instance_id FROM automation_task_runs WHERE run_id=?")
      .get(identity.runId) as { task_id: string; revision_id: string; user_id: string; project_id: string; instance_id: string } | undefined;
    if (!run) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `automation run ${identity.runId}`);
    if (run.task_id !== identity.taskId) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `run ${identity.runId} belongs to task ${run.task_id}, not ${identity.taskId}`);
    }
    if (run.user_id !== scope.userId || run.project_id !== scope.projectId || run.instance_id !== scope.instanceId) {
      throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", "run belongs to another scope");
    }
    // 返工 R8：run→revision→task 链——修订必须真实存在、同 scope、属于该 task
    // （对齐 W1 快照校验），不存在/错配/跨 scope 一律拒绝且不落 basis。
    const revision = sqlite
      .prepare("SELECT task_id, user_id, project_id, instance_id FROM automation_task_revisions WHERE revision_id=?")
      .get(run.revision_id) as { task_id: string; user_id: string; project_id: string; instance_id: string } | undefined;
    if (!revision) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `automation revision ${run.revision_id} for run ${identity.runId}`);
    if (revision.task_id !== run.task_id) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `revision ${run.revision_id} belongs to task ${revision.task_id}, not ${run.task_id}`);
    }
    if (revision.user_id !== scope.userId || revision.project_id !== scope.projectId || revision.instance_id !== scope.instanceId) {
      throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", "revision belongs to another scope");
    }
  }
  // 依赖声明的执行 Agent 与本次 Agent 不一致 → 归属错配拒绝。
  const depAgents = sqlite
    .prepare(`SELECT DISTINCT agent_id FROM agent_space_task_dependencies WHERE task_id=? AND agent_id IS NOT NULL`)
    .all(identity.taskId) as Array<{ agent_id: string }>;
  for (const dep of depAgents) {
    if (dep.agent_id !== identity.agentId) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `task dependencies are bound to another agent (${dep.agent_id})`);
    }
  }
}

// ---------- 装配解析（返工 R3/R4） ----------

function resolveRunBasisContent(scope: UserScope, identity: BasisRequestIdentity, stateBudgetChars?: number): ResolvedRunBasisContent {
  const agentRow = sqlite
    .prepare("SELECT agent_id, name FROM agent_space_agents WHERE agent_id=?")
    .get(identity.agentId) as { agent_id: string; name: string };
  const skipped: PruneSkipRecord[] = [];
  const pruned: PruneSkipRecord[] = [];

  if (identity.entryKind === "conversation") {
    // 交互入口：Agent 自有装配（安装/绑定/授权），无任务收窄。
    const manifest = getInstalledSkillManifest(scope, identity.agentId);
    const skills: ResolvedSkillEntry[] = manifest.map((s) => ({
      skillId: s.skillId, versionId: s.versionId, source: s.source, releaseId: s.releaseId,
      contentRefType: s.contentRefType, contentChecksum: s.contentChecksum, origin: "installed",
    }));
    const methods = resolveBoundMethods(scope, identity.agentId, skipped);
    const grants = sqlite
      .prepare(
        `SELECT asset_id, expires_at FROM agent_space_agent_asset_grants
         WHERE agent_id=? AND user_id=? AND project_id=? AND instance_id=? AND status='active'`,
      )
      .all(identity.agentId, scope.userId, scope.projectId, scope.instanceId) as Array<{ asset_id: string; expires_at: string | null }>;
    const now = nowIso();
    const assets: ResolvedAssetEntry[] = [];
    for (const grant of grants) {
      if (grant.expires_at && grant.expires_at <= now) {
        pruned.push({ kind: "asset", ref: grant.asset_id, reason: "grant-expired" });
        continue;
      }
      assets.push({ ...resolveAssetVersion(scope, grant.asset_id, null), role: "grant", origin: "grant" });
    }
    return {
      entryKind: identity.entryKind,
      agent: { agentId: agentRow.agent_id, name: agentRow.name },
      skills, methods, assets,
      statePacket: resolveStatePacket(scope, identity, stateBudgetChars ?? DEFAULT_STATE_BUDGET_CHARS),
      pruned, skipped,
      context: { conversationId: identity.conversationId, taskId: null, runId: null },
    };
  }

  // 任务入口：严格按依赖装配。无依赖 = 显式空集（旧任务未迁移即未就绪）。
  const deps = listTaskDependencies(scope, identity.taskId!);
  if (deps.length === 0) {
    skipped.push({
      kind: "task",
      ref: identity.taskId!,
      reason: "task-declares-no-dependencies: explicit empty assembly (legacy tasks must declare dependencies before agent-space execution)",
    });
    return {
      entryKind: identity.entryKind,
      agent: { agentId: agentRow.agent_id, name: agentRow.name },
      skills: [], methods: [], assets: [],
      statePacket: resolveStatePacket(scope, identity, stateBudgetChars ?? DEFAULT_STATE_BUDGET_CHARS),
      pruned, skipped,
      context: { conversationId: null, taskId: identity.taskId, runId: identity.runId },
    };
  }
  const installed = new Map(getInstalledSkillManifest(scope, identity.agentId).map((s) => [s.skillId, s]));
  const boundSkipped: PruneSkipRecord[] = [];
  const bound = new Map(resolveBoundMethods(scope, identity.agentId, boundSkipped).map((m) => [m.methodId, m]));
  const skills: ResolvedSkillEntry[] = [];
  const methods: ResolvedMethodEntry[] = [];
  const assets: ResolvedAssetEntry[] = [];
  const stateDeps: PruneSkipRecord[] = [];
  for (const dep of deps) {
    if (dep.kind === "agent_state") {
      stateDeps.push({ kind: "agent_state", ref: dep.ref_id, reason: "agent_state registry lands in W5 (explicit stub; not blocking)" });
      continue;
    }
    if (dep.kind === "skill") {
      if (dep.pinned_version_id) {
        // Pin preserves the chosen version, but cannot bypass an uninstall or pause.
        if (!installed.has(dep.ref_id)) {
          throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `required skill dependency ${dep.ref_id} is not enabled for the agent; blocked`);
        }
        const version = getSkillVersionRow(dep.pinned_version_id);
        if (version.skill_id !== dep.ref_id) throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `pinned skill version does not belong to ${dep.ref_id}`);
        if (version.status !== "approved" && version.status !== "superseded") {
          throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `required skill dependency ${dep.ref_id} pins a ${version.status} version; blocked`);
        }
        skills.push({
          skillId: dep.ref_id, versionId: version.version_id, source: "private", releaseId: null,
          contentRefType: version.content_ref_type, contentChecksum: version.content_checksum, origin: "task-dependency-pinned",
        });
        continue;
      }
      const installedEntry = installed.get(dep.ref_id);
      if (!installedEntry) {
        throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `required skill dependency ${dep.ref_id} is not installed for the agent; blocked`);
      }
      skills.push({
        skillId: installedEntry.skillId, versionId: installedEntry.versionId, source: installedEntry.source,
        releaseId: installedEntry.releaseId, contentRefType: installedEntry.contentRefType,
        contentChecksum: installedEntry.contentChecksum, origin: "installed",
      });
      continue;
    }
    if (dep.kind === "method") {
      // resolveMethodVersion 统一强制采用约束与版本归属（pin 或 current）。
      const resolved = resolveMethodVersion(scope, dep.ref_id, dep.pinned_version_id ?? undefined);
      methods.push({
        methodId: dep.ref_id, versionId: resolved.version.version_id,
        versionPolicy: dep.pinned_version_id ? "pinned" : "current",
        contentChecksum: resolved.version.content_checksum, assetVersionId: resolved.version.asset_version_id,
        origin: dep.pinned_version_id ? "task-dependency-pinned" : "binding",
      });
      continue;
    }
    // asset_input / asset_output：保留角色，解析 version+checksum。
    const resolvedAsset = resolveAssetVersion(scope, dep.ref_id, dep.pinned_version_id);
    assets.push({
      ...resolvedAsset,
      role: dep.kind === "asset_input" ? "input" : "output",
      origin: dep.pinned_version_id ? "task-dependency-pinned" : "task-dependency-current",
    });
  }
  skipped.push(...stateDeps);
  return {
    entryKind: identity.entryKind,
    agent: { agentId: agentRow.agent_id, name: agentRow.name },
    skills, methods, assets,
    statePacket: resolveStatePacket(scope, identity, stateBudgetChars ?? DEFAULT_STATE_BUDGET_CHARS),
    pruned, skipped,
    context: { conversationId: null, taskId: identity.taskId, runId: identity.runId },
  };
}

function resolveBoundMethods(scope: UserScope, agentId: string, skipped: PruneSkipRecord[]): ResolvedMethodEntry[] {
  const bindings = sqlite
    .prepare(
      `SELECT method_id, version_policy, pinned_version_id FROM agent_space_agent_method_bindings
       WHERE agent_id=? AND user_id=? AND project_id=? AND instance_id=? AND status='active'`,
    )
    .all(agentId, scope.userId, scope.projectId, scope.instanceId) as Array<{
      method_id: string; version_policy: "pinned" | "current"; pinned_version_id: string | null;
    }>;
  const methods: ResolvedMethodEntry[] = [];
  for (const binding of bindings) {
    // 绑定解析失败（retired/约束阻断等）跳过并留原因——装配是读模型，不因
    // 单个绑定失败而整体失败；任务入口的必需依赖则由依赖路径阻断。
    try {
      const resolved = resolveMethodVersion(scope, binding.method_id, binding.version_policy === "pinned" ? binding.pinned_version_id ?? undefined : undefined);
      methods.push({
        methodId: binding.method_id, versionId: resolved.version.version_id,
        versionPolicy: binding.version_policy, contentChecksum: resolved.version.content_checksum,
        assetVersionId: resolved.version.asset_version_id, origin: "binding",
      });
    } catch (error) {
      skipped.push({ kind: "method", ref: binding.method_id, reason: (error as Error).message });
    }
  }
  return methods;
}

function resolveAssetVersion(scope: UserScope, assetId: string, pinnedVersionId: string | null): { assetId: string; versionId: string; contentChecksum: string } {
  const asset = sqlite
    .prepare("SELECT current_version_id, user_id, project_id, instance_id FROM user_assets WHERE asset_id=?")
    .get(assetId) as { current_version_id: string | null; user_id: string; project_id: string; instance_id: string } | undefined;
  if (!asset) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `user asset ${assetId}`);
  if (asset.user_id !== scope.userId || asset.project_id !== scope.projectId || asset.instance_id !== scope.instanceId) {
    throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", "asset belongs to another scope");
  }
  const versionId = pinnedVersionId ?? asset.current_version_id;
  if (!versionId) {
    throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `asset ${assetId} has no resolvable version; blocked`);
  }
  const version = sqlite
    .prepare("SELECT asset_id, checksum, user_id, project_id, instance_id FROM user_asset_versions WHERE version_id=?")
    .get(versionId) as { asset_id: string; checksum: string; user_id: string; project_id: string; instance_id: string } | undefined;
  if (!version) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `user asset version ${versionId}`);
  if (version.asset_id !== assetId) throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `asset version ${versionId} does not belong to ${assetId}`);
  if (version.user_id !== scope.userId || version.project_id !== scope.projectId || version.instance_id !== scope.instanceId) {
    throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", "asset version belongs to another scope");
  }
  return { assetId, versionId, contentChecksum: version.checksum };
}

/**
 * 作用域 State Packet（W5 集成）：按入口归属（conversation/task）+ 执行
 * Agent 归属检索，硬预算/去重/冲突排除/解释记录由 buildScopedStatePacket
 * 承担；basis 只落条目引用与解释（正文按冻结 versionId 可查证重读）。
 */
function resolveStatePacket(scope: UserScope, identity: BasisRequestIdentity, budgetChars: number): ResolvedRunBasisContent["statePacket"] {
  const ownerKind = identity.entryKind === "conversation" ? "conversation" : "task";
  const ownerId = identity.entryKind === "conversation" ? identity.conversationId! : identity.taskId!;
  const packet = buildScopedStatePacket({
    scope,
    ownerKind,
    ownerId,
    agentId: identity.agentId,
    budgetChars,
    offset: 0,
  });
  return {
    entries: packet.entries.map((e) => ({ objectType: e.objectType, objectId: e.objectId, versionId: e.versionId, title: e.title, contentChars: e.contentChars })),
    exclusions: packet.exclusions,
    retrieval: { ...packet.retrieval },
    note: STATE_PACKET_NOTE,
  };
}
