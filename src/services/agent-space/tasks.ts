/**
 * TaskDependency 与不可变 TaskRunSnapshot（W1/W5 底座；返工 R1/R5）。
 *
 * 语义：运行开始后依赖版本固定。依赖登记必须验证真实归属——task/agent/
 * 引用对象全部同 scope 校验；agent_state 在 W1 无注册面，fail-closed 拒绝
 * 占位。快照校验 run→task→scope→agent 链与每个装配引用，同 run 不同载荷
 * 重放按幂等冲突拒绝。装配 JSON 走运行时白名单字段校验。全部同事务。
 */
import { sqlite } from "../../db/index.js";
import {
  AgentSpaceError,
  assertOnlyFields,
  assertRowScope,
  assertScopeValid,
  newId,
  nowIso,
  recordAgentSpaceAudit,
  sha256Of,
  type UserScope,
} from "./core.js";
import { parseAdoptionConstraints, resolveMethodVersion } from "./methods.js";

export type DependencyKind = "skill" | "method" | "asset_input" | "asset_output" | "agent_state";

export interface UpsertDependencyInput {
  scope: UserScope;
  taskId: string;
  agentId?: string;
  kind: DependencyKind;
  refId: string;
  versionPolicy: "pinned" | "latest";
  pinnedVersionId?: string;
  metadata?: Record<string, unknown>;
  actor: string;
}

type DependencyRow = {
  dependency_id: string;
  task_id: string;
  user_id: string;
  project_id: string;
  instance_id: string;
  agent_id: string | null;
  kind: DependencyKind;
  ref_id: string;
  version_policy: "pinned" | "latest";
  pinned_version_id: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

const VALID_KINDS: DependencyKind[] = ["skill", "method", "asset_input", "asset_output", "agent_state"];

/** 任务归属校验：task 必须是同 scope 的真实 automation task。 */
function verifyTaskScope(scope: UserScope, taskId: string): void {
  const row = sqlite
    .prepare("SELECT task_id, user_id, project_id, instance_id FROM automation_tasks WHERE task_id=?")
    .get(taskId) as { task_id: string; user_id: string; project_id: string; instance_id: string } | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `automation task ${taskId} not found`);
  assertRowScope(row, scope);
}

function verifyAgentScope(scope: UserScope, agentId: string): void {
  const row = sqlite
    .prepare("SELECT agent_id, user_id, project_id, instance_id FROM agent_space_agents WHERE agent_id=?")
    .get(agentId) as { agent_id: string; user_id: string; project_id: string; instance_id: string } | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `agent ${agentId} not found`);
  assertRowScope(row, scope);
}

/**
 * 引用对象校验：所有 version_policy 均验证（验收 R1：latest 不得跳过）。
 * skill/method 校验对象存在 + 同 scope；pinned 时再校验版本归属/状态。
 * agent_state 在 W1 没有注册面——fail-closed，不接受占位。
 */
function verifyDependencyRef(scope: UserScope, kind: DependencyKind, refId: string, pinnedVersionId?: string): void {
  if (kind === "agent_state") {
    throw new AgentSpaceError("AGENT_SPACE_UNSUPPORTED", "agent_state dependencies are not registered until W5; fail-closed");
  }
  if (kind === "method") {
    const method = sqlite
      .prepare("SELECT method_id, user_id, project_id, instance_id FROM agent_space_methods WHERE method_id=?")
      .get(refId) as { method_id: string; user_id: string; project_id: string; instance_id: string } | undefined;
    if (!method) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `method ${refId} not found`);
    assertRowScope(method, scope);
    if (pinnedVersionId) assertPinnedMethodVersion(scope, refId, pinnedVersionId);
    return;
  }
  if (kind === "skill") {
    const skill = sqlite
      .prepare("SELECT skill_id, domain, user_id, project_id, instance_id FROM agent_space_skills WHERE skill_id=?")
      .get(refId) as { skill_id: string; domain: string; user_id: string | null; project_id: string | null; instance_id: string | null } | undefined;
    if (!skill) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `skill ${refId} not found`);
    if (skill.domain === "user") assertRowScope(skill, scope);
    if (pinnedVersionId) assertPinnedSkillVersion(scope, refId, pinnedVersionId);
    return;
  }
  // asset_input / asset_output：资产必须存在且同 scope；pinned 时版本归属一致。
  const asset = sqlite
    .prepare("SELECT asset_id, user_id, project_id, instance_id FROM user_assets WHERE asset_id=?")
    .get(refId) as { asset_id: string; user_id: string; project_id: string; instance_id: string } | undefined;
  if (!asset) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `user asset ${refId} not found`);
  assertRowScope(asset, scope);
  if (pinnedVersionId) {
    const version = sqlite
      .prepare("SELECT asset_id, user_id, project_id, instance_id FROM user_asset_versions WHERE version_id=?")
      .get(pinnedVersionId) as { asset_id: string; user_id: string; project_id: string; instance_id: string } | undefined;
    if (!version) throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `pinned asset version ${pinnedVersionId} not found`);
    if (version.asset_id !== refId) throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "pinned asset version does not belong to asset");
    assertRowScope(version, scope);
  }
}

function assertPinnedMethodVersion(scope: UserScope, methodId: string, pinnedVersionId: string): void {
  // 与 resolveMethodVersion 同一运行可用性口径（含约束/归属/状态），避免双路径漂移。
  resolveMethodVersion(scope, methodId, pinnedVersionId);
}

function assertPinnedSkillVersion(scope: UserScope, skillId: string, pinnedVersionId: string): void {
  const row = sqlite
    .prepare("SELECT skill_id, status, domain, user_id, project_id, instance_id FROM agent_space_skill_versions WHERE version_id=?")
    .get(pinnedVersionId) as
    | { skill_id: string; status: string; domain: string; user_id: string | null; project_id: string | null; instance_id: string | null }
    | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `skill version ${pinnedVersionId} not found`);
  if (row.skill_id !== skillId) throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "pinned skill version mismatch");
  if (row.domain === "user") assertRowScope(row, scope);
  if (row.status !== "approved" && row.status !== "superseded") {
    throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `pinned skill version is ${row.status}`);
  }
}

export function upsertTaskDependency(input: UpsertDependencyInput): DependencyRow {
  assertScopeValid(input.scope);
  if (!VALID_KINDS.includes(input.kind)) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `kind ${input.kind}`);
  }
  verifyTaskScope(input.scope, input.taskId);
  if (input.agentId) verifyAgentScope(input.scope, input.agentId);
  if (input.versionPolicy === "pinned" && !input.pinnedVersionId) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "pinned policy requires pinnedVersionId");
  }
  verifyDependencyRef(input.scope, input.kind, input.refId, input.pinnedVersionId);

  const existing = sqlite
    .prepare("SELECT * FROM agent_space_task_dependencies WHERE task_id=? AND kind=? AND ref_id=?")
    .get(input.taskId, input.kind, input.refId) as DependencyRow | undefined;
  if (existing) {
    // 验收 R1：唯一键冲突更新前必须核对已有行 scope，跨域改写拒绝。
    assertRowScope(existing, input.scope);
  }

  const now = nowIso();
  const tx = sqlite.transaction(() => {
    const dependencyId = newId("tdep");
    sqlite
      .prepare(
        `INSERT INTO agent_space_task_dependencies (
           dependency_id, task_id, user_id, project_id, instance_id, agent_id,
           kind, ref_id, version_policy, pinned_version_id, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, kind, ref_id) DO UPDATE SET
           agent_id=excluded.agent_id, version_policy=excluded.version_policy,
           pinned_version_id=excluded.pinned_version_id, metadata_json=excluded.metadata_json,
           updated_at=excluded.updated_at`,
      )
      .run(dependencyId, input.taskId, input.scope.userId, input.scope.projectId, input.scope.instanceId,
           input.agentId ?? null, input.kind, input.refId, input.versionPolicy, input.pinnedVersionId ?? null,
           input.metadata ? JSON.stringify(input.metadata) : null, now, now);
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: "task.dependency.upserted",
      objectType: "agent_space_task_dependency",
      objectId: `${input.taskId}:${input.kind}:${input.refId}`,
      toStatus: input.versionPolicy,
      detail: { taskId: input.taskId, kind: input.kind, refId: input.refId, pinnedVersionId: input.pinnedVersionId ?? null },
    });
    return sqlite
      .prepare("SELECT * FROM agent_space_task_dependencies WHERE task_id=? AND kind=? AND ref_id=?")
      .get(input.taskId, input.kind, input.refId) as DependencyRow;
  });
  return tx();
}

export function listTaskDependencies(scope: UserScope, taskId: string): DependencyRow[] {
  assertScopeValid(scope);
  return sqlite
    .prepare(
      `SELECT * FROM agent_space_task_dependencies
       WHERE task_id=? AND user_id=? AND project_id=? AND instance_id=? ORDER BY kind, ref_id`,
    )
    .all(taskId, scope.userId, scope.projectId, scope.instanceId) as DependencyRow[];
}

export interface AssemblyEntry {
  objectType: "skill" | "method" | "asset" | "agent_state";
  objectId: string;
  /** 已解析的具体正式版本（latest/current 是解析策略，快照必须落具体版本）。 */
  versionId: string | null;
  versionPolicy: "pinned" | "current" | "latest" | "none";
  contentChecksum?: string;
}

const ASSEMBLY_ENTRY_FIELDS = ["objectType", "objectId", "versionId", "versionPolicy", "contentChecksum"] as const;
const ASSEMBLY_ROOT_FIELDS = ["agent", "skills", "methods", "assets", "agentState"] as const;
const ASSEMBLY_POLICIES = ["pinned", "current", "latest", "none"] as const;

export interface RecordRunSnapshotInput {
  scope: UserScope;
  runId: string;
  taskId: string;
  agentId?: string;
  assembly: {
    agent?: { agentId: string };
    skills: AssemblyEntry[];
    methods: AssemblyEntry[];
    assets: AssemblyEntry[];
    agentState: AssemblyEntry[];
  };
  actor: string;
}

interface StampedEntry {
  objectType: string;
  objectId: string;
  versionId: string;
  versionPolicy: string;
  contentChecksum: string;
}

/**
 * 装配条目校验 + 服务端盖章（验收 R8）：
 * - versionId 必填且必须是已解析的具体正式版本（draft/null 拒绝）；
 * - 条目类别必须与所在数组一致（skills 只放 skill，等）；
 * - checksum 由服务端从版本行读取盖章；调用方提供的值必须与实际一致；
 * - method 复用 resolveMethodVersion（归属+正式状态+运行约束），hold 等
 *   约束不能借快照 pin 绕过默认采用路径。
 */
function verifyAndStampAssemblyEntry(scope: UserScope, expectedObjectType: "skill" | "method" | "asset", entry: AssemblyEntry): StampedEntry {
  assertOnlyFields(entry as unknown as Record<string, unknown>, ASSEMBLY_ENTRY_FIELDS, "assembly entry");
  if (entry.objectType !== expectedObjectType) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `category mismatch: ${expectedObjectType} list carries objectType ${entry.objectType}`);
  }
  if (!ASSEMBLY_POLICIES.includes(entry.versionPolicy)) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `versionPolicy ${entry.versionPolicy}`);
  }
  if (!entry.versionId) {
    throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "snapshot entries require the resolved concrete versionId; latest/current are resolution policies, not deferrals");
  }
  let actualChecksum: string;
  if (expectedObjectType === "method") {
    const { version } = resolveMethodVersion(scope, entry.objectId, entry.versionId);
    actualChecksum = version.content_checksum;
  } else if (expectedObjectType === "skill") {
    const row = sqlite
      .prepare("SELECT skill_id, status, domain, user_id, project_id, instance_id, content_checksum FROM agent_space_skill_versions WHERE version_id=?")
      .get(entry.versionId) as
      | { skill_id: string; status: string; domain: string; user_id: string | null; project_id: string | null; instance_id: string | null; content_checksum: string }
      | undefined;
    if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `skill version ${entry.versionId}`);
    if (row.skill_id !== entry.objectId) throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "skill version does not belong to the entry object");
    if (row.domain === "user") assertRowScope(row, scope);
    if (row.status !== "approved" && row.status !== "superseded") {
      throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `skill version is ${row.status}; only formal versions can enter snapshots`);
    }
    actualChecksum = row.content_checksum;
  } else {
    const row = sqlite
      .prepare("SELECT asset_id, checksum, user_id, project_id, instance_id FROM user_asset_versions WHERE version_id=?")
      .get(entry.versionId) as
      | { asset_id: string; checksum: string; user_id: string; project_id: string; instance_id: string }
      | undefined;
    if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `asset version ${entry.versionId}`);
    if (row.asset_id !== entry.objectId) throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "asset version does not belong to the entry object");
    assertRowScope(row, scope);
    actualChecksum = row.checksum;
  }
  if (entry.contentChecksum !== undefined && entry.contentChecksum !== actualChecksum) {
    throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `entry checksum does not match the actual version (actual ${actualChecksum})`);
  }
  return { objectType: entry.objectType, objectId: entry.objectId, versionId: entry.versionId, versionPolicy: entry.versionPolicy, contentChecksum: actualChecksum };
}

/**
 * 运行快照（验收 R1/R8）：append-only、同 run 幂等。校验 run→task→scope→
 * agent 链（含 run.revision 归属）与全部装配引用；checksum 服务端盖章；
 * 同 run 不同装配载荷的重放按幂等冲突拒绝。
 */
export function recordTaskRunSnapshot(input: RecordRunSnapshotInput): { snapshotId: string; assemblyHash: string } {
  assertScopeValid(input.scope);
  assertOnlyFields(input.assembly as unknown as Record<string, unknown>, ASSEMBLY_ROOT_FIELDS, "assembly");
  if (input.assembly.agent) {
    assertOnlyFields(input.assembly.agent as unknown as Record<string, unknown>, ["agentId"], "assembly.agent");
    verifyAgentScope(input.scope, input.assembly.agent.agentId);
  }
  if (input.agentId) verifyAgentScope(input.scope, input.agentId);
  if (input.agentId && input.assembly.agent && input.agentId !== input.assembly.agent.agentId) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "agentId and assembly.agent disagree");
  }
  const run = sqlite
    .prepare("SELECT run_id, task_id, revision_id, user_id, project_id, instance_id FROM automation_task_runs WHERE run_id=?")
    .get(input.runId) as
    | { run_id: string; task_id: string; revision_id: string; user_id: string; project_id: string; instance_id: string }
    | undefined;
  if (!run) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `automation run ${input.runId} not found`);
  assertRowScope(run, input.scope);
  if (run.task_id !== input.taskId) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "run does not belong to the given task");
  }
  verifyTaskScope(input.scope, input.taskId);
  if (run.revision_id) {
    const revision = sqlite
      .prepare("SELECT task_id, user_id, project_id, instance_id FROM automation_task_revisions WHERE revision_id=?")
      .get(run.revision_id) as { task_id: string; user_id: string; project_id: string; instance_id: string } | undefined;
    if (!revision || revision.task_id !== input.taskId) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "run revision does not belong to the given task");
    }
    assertRowScope(revision, input.scope);
  }
  if (input.assembly.agentState.length > 0) {
    throw new AgentSpaceError("AGENT_SPACE_UNSUPPORTED", "agent_state assembly entries are not registered until W5; fail-closed");
  }
  const skills = input.assembly.skills.map((e) => verifyAndStampAssemblyEntry(input.scope, "skill", e));
  const methods = input.assembly.methods.map((e) => verifyAndStampAssemblyEntry(input.scope, "method", e));
  const assets = input.assembly.assets.map((e) => verifyAndStampAssemblyEntry(input.scope, "asset", e));

  const assemblyJson = JSON.stringify(
    {
      agent: input.assembly.agent ?? null,
      skills,
      methods,
      assets,
      agentState: [],
    },
    null,
    0,
  );
  const assemblyHash = sha256Of(assemblyJson);

  const existing = sqlite
    .prepare("SELECT assembly_hash FROM agent_space_task_run_snapshots WHERE run_id=?")
    .get(input.runId) as { assembly_hash: string } | undefined;
  if (existing) {
    if (existing.assembly_hash !== assemblyHash) {
      throw new AgentSpaceError("AGENT_SPACE_IDEMPOTENCY_CONFLICT", `run ${input.runId} already has a different assembly snapshot`);
    }
    return { snapshotId: readSnapshotId(input.scope, input.runId), assemblyHash };
  }
  const tx = sqlite.transaction(() => {
    const snapshotId = newId("rsnap");
    sqlite
      .prepare(
        `INSERT INTO agent_space_task_run_snapshots (
           snapshot_id, run_id, task_id, user_id, project_id, instance_id, agent_id, assembly_json, assembly_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(snapshotId, input.runId, input.taskId, input.scope.userId, input.scope.projectId, input.scope.instanceId,
           input.agentId ?? null, assemblyJson, assemblyHash, nowIso());
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: "task.run_snapshot.recorded",
      objectType: "agent_space_task_run_snapshot",
      objectId: snapshotId,
      detail: { runId: input.runId, taskId: input.taskId, assemblyHash },
    });
    return snapshotId;
  });
  return { snapshotId: tx(), assemblyHash };
}

function readSnapshotId(scope: UserScope, runId: string): string {
  const row = sqlite
    .prepare("SELECT snapshot_id FROM agent_space_task_run_snapshots WHERE run_id=? AND user_id=? AND project_id=? AND instance_id=?")
    .get(runId, scope.userId, scope.projectId, scope.instanceId) as { snapshot_id: string } | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `run snapshot ${runId}`);
  return row.snapshot_id;
}

export function getTaskRunSnapshot(scope: UserScope, runId: string): {
  snapshotId: string;
  taskId: string;
  agentId: string | null;
  assembly: Record<string, unknown>;
  assemblyHash: string;
  createdAt: string;
} {
  assertScopeValid(scope);
  const row = sqlite
    .prepare("SELECT * FROM agent_space_task_run_snapshots WHERE run_id=?")
    .get(runId) as
    | { snapshot_id: string; task_id: string; agent_id: string | null; assembly_json: string; assembly_hash: string; created_at: string; user_id: string; project_id: string; instance_id: string }
    | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `run snapshot ${runId}`);
  assertRowScope(row, scope);
  return {
    snapshotId: row.snapshot_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    assembly: JSON.parse(row.assembly_json),
    assemblyHash: row.assembly_hash,
    createdAt: row.created_at,
  };
}

// ---------- W5：运行结果分层记录（执行/产物/投递/阅读） ----------

export type RunOutcomeKind =
  | "execution_succeeded"
  | "execution_failed"
  | "artifact_generated"
  | "delivery_succeeded"
  | "delivery_failed"
  | "user_read_claimed";

const RUN_OUTCOME_KINDS: readonly RunOutcomeKind[] = [
  "execution_succeeded", "execution_failed", "artifact_generated",
  "delivery_succeeded", "delivery_failed", "user_read_claimed",
];

/**
 * 返工 R3：outcome 是分层**事实**记录，不是自报声明——每类绑定可核对来源：
 * - execution_*：来源=run 本身（存在+同 scope 已核）；
 * - artifact_generated：detail.assetId 必须是同 scope 真实用户资产（可选
 *   versionId 须属于该资产）；
 * - delivery_succeeded：detail.pushJobId 必须是同 scope 真实 push_jobs 行
 *   且 status='sent'；
 * - delivery_failed：同上且 status ∈ {dead, expired}；
 * - user_read：当前无受信阅读事件源，只能以显式非事实名 user_read_claimed
 *   记录（声称，不冒充已读事实）。
 */

export interface RunOutcomeRecord {
  outcomeId: string;
  runId: string;
  kind: RunOutcomeKind;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

function verifyRunScope(scope: UserScope, runId: string): void {
  const row = sqlite
    .prepare("SELECT user_id, project_id, instance_id FROM automation_task_runs WHERE run_id=?")
    .get(runId) as { user_id: string; project_id: string; instance_id: string } | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `automation run ${runId}`);
  assertRowScope(row, scope);
}

/**
 * 运行结果分层记录（W5）：执行成功、产物生成、投递成功/失败、用户阅读
 * 分别落条，append-only、带审计；幂等键（可选）同键同内容回放返回既有条，
 * 异内容冲突。run 必须真实存在且同 scope。
 */
export function recordRunOutcome(input: {
  scope: UserScope;
  runId: string;
  kind: RunOutcomeKind;
  detail?: Record<string, unknown>;
  idempotencyKey?: string;
  actor: string;
}): RunOutcomeRecord {
  assertScopeValid(input.scope);
  if (!RUN_OUTCOME_KINDS.includes(input.kind)) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `unknown run outcome kind ${input.kind}`);
  }
  if ((input.kind as string) === "user_read") {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "user_read has no trusted fact source; record user_read_claimed instead");
  }
  verifyRunScope(input.scope, input.runId);
  verifyOutcomeFactSource(input.scope, input.kind, input.detail);
  const detailJson = input.detail ? JSON.stringify(input.detail) : null;
  if (input.idempotencyKey) {
    const existing = sqlite
      .prepare(
        `SELECT outcome_id, run_id, kind, detail_json, created_at FROM agent_space_run_outcomes
         WHERE user_id=? AND project_id=? AND instance_id=? AND idempotency_key=?`,
      )
      .get(input.scope.userId, input.scope.projectId, input.scope.instanceId, input.idempotencyKey) as
      | { outcome_id: string; run_id: string; kind: string; detail_json: string | null; created_at: string }
      | undefined;
    if (existing) {
      if (existing.run_id !== input.runId || existing.kind !== input.kind || (existing.detail_json ?? null) !== detailJson) {
        throw new AgentSpaceError(
          "AGENT_SPACE_IDEMPOTENCY_CONFLICT",
          `run outcome idempotency key ${input.idempotencyKey} replay with different content`,
        );
      }
      return { outcomeId: existing.outcome_id, runId: existing.run_id, kind: existing.kind as RunOutcomeKind, detail: existing.detail_json ? JSON.parse(existing.detail_json) : null, createdAt: existing.created_at };
    }
  }
  const outcomeId = newId("rout");
  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO agent_space_run_outcomes (
           outcome_id, run_id, user_id, project_id, instance_id, kind, detail_json, idempotency_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(outcomeId, input.runId, input.scope.userId, input.scope.projectId, input.scope.instanceId,
           input.kind, detailJson, input.idempotencyKey ?? null, nowIso());
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: "run.outcome_recorded",
      objectType: "agent_space_run_outcome",
      objectId: outcomeId,
      toStatus: input.kind,
      detail: { runId: input.runId, kind: input.kind },
    });
  });
  tx();
  return { outcomeId, runId: input.runId, kind: input.kind, detail: input.detail ?? null, createdAt: nowIso() };
}

function verifyOutcomeFactSource(scope: UserScope, kind: RunOutcomeKind, detail: Record<string, unknown> | undefined): void {
  if (kind === "artifact_generated") {
    const assetId = typeof detail?.assetId === "string" ? detail.assetId : "";
    if (!assetId) throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "artifact_generated requires detail.assetId referencing a real asset");
    const asset = sqlite
      .prepare("SELECT user_id, project_id, instance_id FROM user_assets WHERE asset_id=?")
      .get(assetId) as { user_id: string; project_id: string; instance_id: string } | undefined;
    if (!asset) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `user asset ${assetId} (artifact fact source)`);
    assertRowScope(asset, scope);
    if (typeof detail?.versionId === "string") {
      const version = sqlite
        .prepare("SELECT asset_id FROM user_asset_versions WHERE version_id=?")
        .get(detail.versionId) as { asset_id: string } | undefined;
      if (!version || version.asset_id !== assetId) {
        throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "artifact versionId does not belong to the referenced asset");
      }
    }
    return;
  }
  if (kind === "delivery_succeeded" || kind === "delivery_failed") {
    const pushJobId = typeof detail?.pushJobId === "string" ? detail.pushJobId : "";
    if (!pushJobId) throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `${kind} requires detail.pushJobId referencing a real push job`);
    const job = sqlite
      .prepare("SELECT user_id, project_id, instance_id, status FROM push_jobs WHERE id=?")
      .get(pushJobId) as { user_id: string; project_id: string; instance_id: string; status: string } | undefined;
    if (!job) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `push job ${pushJobId} (delivery fact source)`);
    assertRowScope(job, scope);
    if (kind === "delivery_succeeded" && job.status !== "sent") {
      throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `delivery_succeeded requires the push job to be sent (got ${job.status})`);
    }
    if (kind === "delivery_failed" && job.status !== "dead" && job.status !== "expired") {
      throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `delivery_failed requires the push job to be dead/expired (got ${job.status})`);
    }
  }
}

/** 运行结果时间线（按发生顺序）。 */
export function listRunOutcomes(scope: UserScope, runId: string): RunOutcomeRecord[] {
  assertScopeValid(scope);
  verifyRunScope(scope, runId);
  return (
    sqlite
      .prepare(
        `SELECT outcome_id, run_id, kind, detail_json, created_at FROM agent_space_run_outcomes
         WHERE run_id=? AND user_id=? AND project_id=? AND instance_id=? ORDER BY rowid`,
      )
      .all(runId, scope.userId, scope.projectId, scope.instanceId) as Array<{
      outcome_id: string; run_id: string; kind: string; detail_json: string | null; created_at: string;
    }>
  ).map((r) => ({
    outcomeId: r.outcome_id, runId: r.run_id, kind: r.kind as RunOutcomeKind,
    detail: r.detail_json ? JSON.parse(r.detail_json) : null, createdAt: r.created_at,
  }));
}
