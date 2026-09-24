/**
 * 方法资产工作副本（未发布修改）服务端持久化。
 *
 * 语义边界（与「保存≠生效」版本纪律同构）：
 * - 工作副本只是编辑态：保存工作副本绝不写 user_asset_versions，也绝不改变
 *   user_assets.current_version_id——只有用户明确「保存为新版本」才进版本链。
 * - base_version_id 锚定工作副本基于哪个版本编辑；读取方据此提示「基于旧版本」
 *   的陈旧风险，服务层只存储不裁决。
 * - 版本提交成功后由调用方显式清除工作副本（本模块不监听版本写入）。
 */
import { sqlite } from "../../db/index.js";
import { AgentSpaceError, assertScopeValid, nowIso, recordAgentSpaceAudit, type UserScope } from "./core.js";

const MAX_WORKING_COPY_CHARS = 256 * 1024;

export interface MethodWorkingCopyDescriptor {
  assetId: string;
  category: string;
  draftText: string | null;
  baseVersionId: string | null;
  updatedAt: string;
}

interface WorkingCopyRow {
  asset_id: string;
  category: string;
  draft_text: string | null;
  base_version_id: string | null;
  updated_at: string;
}

interface AssetRow {
  asset_id: string;
  name: string;
  status: string;
}

function requireMethodAsset(scope: UserScope, assetId: string): AssetRow {
  const row = sqlite
    .prepare(
      `SELECT asset_id, name, status FROM user_assets
       WHERE asset_id=? AND user_id=? AND project_id=? AND instance_id=?`,
    )
    .get(assetId, scope.userId, scope.projectId, scope.instanceId) as AssetRow | undefined;
  if (!row) {
    throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `asset ${assetId} not found in scope`);
  }
  if (row.status !== "active") {
    throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `asset ${assetId} is ${row.status}; working copies require an active asset`);
  }
  return row;
}

function toDescriptor(row: WorkingCopyRow): MethodWorkingCopyDescriptor {
  return {
    assetId: row.asset_id,
    category: row.category,
    draftText: row.draft_text,
    baseVersionId: row.base_version_id,
    updatedAt: row.updated_at,
  };
}

/** 读取工作副本；不存在时返回 null（编辑器据此回落到当前版本正文）。 */
export function readMethodWorkingCopy(scope: UserScope, assetId: string): MethodWorkingCopyDescriptor | null {
  assertScopeValid(scope);
  requireMethodAsset(scope, assetId);
  const row = sqlite
    .prepare(
      `SELECT asset_id, category, draft_text, base_version_id, updated_at
       FROM method_asset_working_copies
       WHERE asset_id=? AND user_id=? AND project_id=? AND instance_id=?`,
    )
    .get(assetId, scope.userId, scope.projectId, scope.instanceId) as WorkingCopyRow | undefined;
  return row ? toDescriptor(row) : null;
}

export interface SaveMethodWorkingCopyInput {
  scope: UserScope;
  assetId: string;
  draftText: string;
  /** 工作副本基于的版本；省略时沿用已存的基线。 */
  baseVersionId?: string;
  category?: string;
  actor: string;
}

/**
 * 保存（覆盖）工作副本。同一资产只有一份工作副本；不产生版本、不影响采用态。
 */
export function saveMethodWorkingCopy(input: SaveMethodWorkingCopyInput): MethodWorkingCopyDescriptor {
  assertScopeValid(input.scope);
  if (!input.draftText || !input.draftText.trim()) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "draftText is required");
  }
  if (input.draftText.length > MAX_WORKING_COPY_CHARS) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `draftText exceeds ${MAX_WORKING_COPY_CHARS} chars`);
  }
  if (input.category !== undefined && input.category.length > 40) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "category exceeds 40 chars");
  }
  requireMethodAsset(input.scope, input.assetId);

  let baseVersionId: string | null | undefined = input.baseVersionId ?? undefined;
  if (baseVersionId !== undefined) {
    if (baseVersionId === null || baseVersionId === "") {
      baseVersionId = null;
    } else {
      const version = sqlite
        .prepare(
          `SELECT version_id FROM user_asset_versions
           WHERE version_id=? AND asset_id=? AND user_id=? AND project_id=? AND instance_id=?`,
        )
        .get(baseVersionId, input.assetId, input.scope.userId, input.scope.projectId, input.scope.instanceId) as { version_id: string } | undefined;
      if (!version) {
        throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `baseVersionId ${baseVersionId} does not belong to asset ${input.assetId}`);
      }
    }
  }

  const existing = sqlite
    .prepare(
      `SELECT category, base_version_id FROM method_asset_working_copies
       WHERE asset_id=? AND user_id=? AND project_id=? AND instance_id=?`,
    )
    .get(input.assetId, input.scope.userId, input.scope.projectId, input.scope.instanceId) as { category: string; base_version_id: string | null } | undefined;

  const category = input.category ?? existing?.category ?? "other";
  const resolvedBaseVersionId = baseVersionId !== undefined ? baseVersionId : (existing?.base_version_id ?? null);
  const updatedAt = nowIso();
  sqlite
    .prepare(
      `INSERT INTO method_asset_working_copies (asset_id, user_id, project_id, instance_id, category, draft_text, base_version_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(asset_id) DO UPDATE SET
         user_id=excluded.user_id, project_id=excluded.project_id, instance_id=excluded.instance_id,
         category=excluded.category, draft_text=excluded.draft_text,
         base_version_id=excluded.base_version_id, updated_at=excluded.updated_at`,
    )
    .run(input.assetId, input.scope.userId, input.scope.projectId, input.scope.instanceId, category, input.draftText, resolvedBaseVersionId, updatedAt);

  recordAgentSpaceAudit({
    scope: input.scope,
    actor: input.actor,
    action: "method_working_copy.saved",
    objectType: "user_asset",
    objectId: input.assetId,
    toStatus: "draft",
    detail: {
      baseVersionId: resolvedBaseVersionId,
      draftChars: input.draftText.length,
      category,
    },
  });
  return { assetId: input.assetId, category, draftText: input.draftText, baseVersionId: resolvedBaseVersionId, updatedAt };
}

/** 清除工作副本（版本提交后的显式收尾）；幂等，返回是否真的删除了一行。 */
export function clearMethodWorkingCopy(scope: UserScope, assetId: string, actor: string): { assetId: string; cleared: boolean } {
  assertScopeValid(scope);
  requireMethodAsset(scope, assetId);
  const result = sqlite
    .prepare(
      `DELETE FROM method_asset_working_copies
       WHERE asset_id=? AND user_id=? AND project_id=? AND instance_id=?`,
    )
    .run(assetId, scope.userId, scope.projectId, scope.instanceId);
  const cleared = result.changes > 0;
  if (cleared) {
    recordAgentSpaceAudit({
      scope,
      actor,
      action: "method_working_copy.cleared",
      objectType: "user_asset",
      objectId: assetId,
      fromStatus: "draft",
      detail: { reason: "explicit" },
    });
  }
  return { assetId, cleared };
}

/** 批量读取 scope 内存在工作副本的资产（列表徽标用）。 */
export function listMethodWorkingCopyInfo(scope: UserScope): Map<string, { baseVersionId: string | null; updatedAt: string }> {
  assertScopeValid(scope);
  const rows = sqlite
    .prepare(
      `SELECT asset_id, base_version_id, updated_at FROM method_asset_working_copies
       WHERE user_id=? AND project_id=? AND instance_id=?`,
    )
    .all(scope.userId, scope.projectId, scope.instanceId) as Array<{ asset_id: string; base_version_id: string | null; updated_at: string }>;
  return new Map(rows.map((row) => [row.asset_id, { baseVersionId: row.base_version_id, updatedAt: row.updated_at }]));
}
