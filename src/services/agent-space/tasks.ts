/**
 * TaskDependency 与不可变 TaskRunSnapshot（W1/W5 底座）。
 *
 * 语义（v3 §3）：运行开始后技能、方法、输入资产与状态版本固定；执行中补查
 * 不得静默替换已加载版本。快照只保存装配引用（对象 id + version + checksum
 * + 来源），不保存内容正文——正文读取必须回到各 scoped 服务，对象文本不
 * 能绕过授权。
 */
import { sqlite } from "../../db/index.js";
import {
  AgentSpaceError,
  assertRowScope,
  assertScopeValid,
  newId,
  nowIso,
  recordAgentSpaceAudit,
  sha256Of,
  type UserScope,
} from "./core.js";

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

/** 校验 pinned 引用是同 scope 的正式版本（skill/method 才有版本链约束）。 */
function assertPinnedVersion(scope: UserScope, kind: DependencyKind, refId: string, pinnedVersionId: string): void {
  if (kind === "method") {
    const row = sqlite
      .prepare("SELECT method_id, status, user_id, project_id, instance_id FROM agent_space_method_versions WHERE version_id=?")
      .get(pinnedVersionId) as { method_id: string; status: string; user_id: string; project_id: string; instance_id: string } | undefined;
    if (!row || row.method_id !== refId) throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "pinned method version mismatch");
    assertRowScope(row, scope);
    if (row.status !== "approved" && row.status !== "superseded") {
      throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `pinned method version is ${row.status}`);
    }
  } else if (kind === "skill") {
    const row = sqlite
      .prepare("SELECT skill_id, status, domain, user_id, project_id, instance_id FROM agent_space_skill_versions WHERE version_id=?")
      .get(pinnedVersionId) as { skill_id: string; status: string; domain: string; user_id: string | null; project_id: string | null; instance_id: string | null } | undefined;
    if (!row || row.skill_id !== refId) throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "pinned skill version mismatch");
    if (row.domain === "user") {
      assertRowScope(row, scope);
    }
    if (row.status !== "approved" && row.status !== "superseded") {
      throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `pinned skill version is ${row.status}`);
    }
  } else if (kind === "asset_input" || kind === "asset_output") {
    const row = sqlite
      .prepare("SELECT asset_id, user_id, project_id, instance_id FROM user_asset_versions WHERE version_id=?")
      .get(pinnedVersionId) as { asset_id: string; user_id: string; project_id: string; instance_id: string } | undefined;
    if (!row || row.asset_id !== refId) throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "pinned asset version mismatch");
    assertRowScope(row, scope);
  }
  // agent_state：T-524 状态对象 id 由 W5 注册后校验；W1 接受引用占位。
}

export function upsertTaskDependency(input: UpsertDependencyInput): DependencyRow {
  assertScopeValid(input.scope);
  if (!VALID_KINDS.includes(input.kind)) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `kind ${input.kind}`);
  }
  if (input.versionPolicy === "pinned") {
    if (!input.pinnedVersionId) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "pinned policy requires pinnedVersionId");
    }
    assertPinnedVersion(input.scope, input.kind, input.refId, input.pinnedVersionId);
  }
  const now = nowIso();
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
  objectType: "agent" | "skill" | "method" | "asset" | "agent_state";
  objectId: string;
  versionId: string | null;
  versionPolicy: "pinned" | "current" | "latest" | "none";
  contentChecksum?: string;
}

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

/**
 * 运行快照：append-only。同 run 重复记录幂等返回既有快照；任何改写尝试
 * （update/delete）都被服务拒绝——历史运行依据不可改写。
 */
export function recordTaskRunSnapshot(input: RecordRunSnapshotInput): { snapshotId: string; assemblyHash: string } {
  assertScopeValid(input.scope);
  const existing = sqlite
    .prepare("SELECT snapshot_id FROM agent_space_task_run_snapshots WHERE run_id=?")
    .get(input.runId) as { snapshot_id: string } | undefined;
  if (existing) return { snapshotId: existing.snapshot_id, assemblyHash: readAssemblyHash(input.scope, input.runId) };
  const assemblyJson = JSON.stringify(
    {
      agent: input.assembly.agent ?? null,
      skills: input.assembly.skills,
      methods: input.assembly.methods,
      assets: input.assembly.assets,
      agentState: input.assembly.agentState,
    },
    null,
    0,
  );
  const assemblyHash = sha256Of(assemblyJson);
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
  return { snapshotId, assemblyHash };
}

function readAssemblyHash(scope: UserScope, runId: string): string {
  const row = sqlite
    .prepare("SELECT assembly_hash FROM agent_space_task_run_snapshots WHERE run_id=? AND user_id=? AND project_id=? AND instance_id=?")
    .get(runId, scope.userId, scope.projectId, scope.instanceId) as { assembly_hash: string } | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `run snapshot ${runId}`);
  return row.assembly_hash;
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
