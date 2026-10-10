/**
 * W6 隔离迁移演练导入器。
 *
 * 设计依据 docs/agent-space-execution/W6-isolated-migration-rehearsal.md：
 * - 只接收 W0 import-gate 的自动可导入项（backupCoverage=covered、非阻塞、
 *   有明确分类）；owner-review 项仅导出可发现性清单，绝不导入。
 * - 服务层不信任 gate 列表本身：逐项重验机器规则（分类/处置/备份覆盖/
 *   回读一致/无漂移/无采用约束），不满足者记入 skipped，不进入导入。
 * - 备份字节在 staging 阶段实读并重算 sha256，与 W0 manifest 双核对；
 *   漂移或缺失即拦截该项（REVIEW：导入前以备份实际字节为准）。
 * - 导入语义：
 *   data_asset → createUserAsset（source='restore'，幂等键 w6:<itemId>）；
 *   method     → createUserAsset 内容底座 + createMethod + addMethodVersion
 *                （origin='migration'）。版本一律停在 draft 归档态：不
 *                approve、不 adopt、不设 current——“撤回/历史策略只归档”，
 *                运行采用必须走既有授权路径（approve/readopt），约束
 *                （historical-not-default 等）仍由 methods.ts 强制。
 * - 本模块只写隔离 DB（调用方负责环境隔离）；真实用户迁移属 W7。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { sqlite } from "../../db/index.js";
import { AgentSpaceError, type UserScope } from "./core.js";
import { addMethodVersion, createMethod, getMethodVersion, listUserMethods } from "./methods.js";
import { createUserAsset, readUserAssetVersion } from "../user-assets.js";

/** W0 明确分类中允许自动导入的类别；unclassified/pending-review 不在列。 */
const IMPORTABLE_CLASSIFICATIONS = new Set(["data_asset", "method"]);

export interface W0ManifestItem {
  id: string;
  scope: { user: string; projectId: string; instanceId: string };
  source: string;
  path: string;
  classification: string;
  disposition: string;
  blockedReasons: string[];
  sha256: string;
  size: number;
  objectLinks: {
    reconciliationLinks?: Array<Record<string, unknown>>;
    adoptionConstraints?: unknown[];
  } | null;
  backup: {
    backupPath: string;
    coverage: string;
    readbackResult: string;
    readbackHash: string;
    driftSinceScan: string;
  };
}

export interface MigrationItem {
  itemId: string;
  scope: UserScope;
  /** 相对旧工作根的路径（人读与报告呈现用）。 */
  path: string;
  fileName: string;
  classification: "data_asset" | "method";
  sourceHash: string;
  size: number;
  backupPath: string;
  reconciliationLinks: Array<Record<string, unknown>>;
}

export interface GateSkipped {
  itemId: string;
  reason: string;
}

export interface OwnerReviewEntry {
  itemId: string;
  user: string;
  path: string;
  classification: string;
  blockedReasons: string[];
  adoptionConstraints: string[];
  reconciliationTargets: string[];
  backupPath: string | null;
  sha256: string | null;
}

export interface MigrationInputs {
  gateGeneratedAt: string;
  /** 通过机器门禁重验的自动导入项。 */
  autoItems: MigrationItem[];
  /** gate 列出但重验不通过的项（服务层拦截，非信任列表）。 */
  skipped: GateSkipped[];
  /** owner-review 可发现性清单（不导入）。 */
  ownerReviewQueue: OwnerReviewEntry[];
}

interface JsonRecord {
  [key: string]: unknown;
}

function readJson(filePath: string): JsonRecord {
  return JSON.parse(readFileSync(filePath, "utf8")) as JsonRecord;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") out.push(entry);
    // W0 真实形态：[{ ref, constraint }]，约束语义在 constraint 字符串上。
    else if (entry && typeof entry === "object" && typeof (entry as { constraint?: unknown }).constraint === "string") {
      out.push((entry as { constraint: string }).constraint);
    }
  }
  return out;
}

/**
 * 读取 W0 产物并对自动导入桶逐项重验机器规则。
 * 规则与 import-gate.rules.autoImportable 同义，但以条目字段为准执行。
 */
export function loadW0MigrationInputs(w0Root: string): MigrationInputs {
  const gate = readJson(path.join(w0Root, "import-gate.json"));
  const manifest = readJson(path.join(w0Root, "manifest.json"));
  const manifestItems: W0ManifestItem[] = [];
  const users = (manifest.users ?? {}) as Record<string, { items?: W0ManifestItem[] }>;
  for (const user of Object.keys(users)) {
    for (const item of users[user]?.items ?? []) manifestItems.push(item);
  }
  const byId = new Map(manifestItems.map((item) => [item.id, item]));
  const gateAuto = asStringArray(gate.autoImportable);
  const gateOwnerReview = new Set(asStringArray(gate.ownerReview));

  const autoItems: MigrationItem[] = [];
  const skipped: GateSkipped[] = [];
  for (const itemId of gateAuto) {
    const item = byId.get(itemId);
    if (!item) {
      skipped.push({ itemId, reason: "not-in-manifest" });
      continue;
    }
    const reason = gateBlockReason(item);
    if (reason) {
      skipped.push({ itemId, reason });
      continue;
    }
    autoItems.push(toMigrationItem(item));
  }

  const ownerReviewQueue: OwnerReviewEntry[] = [];
  for (const itemId of gateOwnerReview) {
    const item = byId.get(itemId);
    if (!item) continue;
    ownerReviewQueue.push({
      itemId: item.id,
      user: item.scope.user,
      path: item.path,
      classification: item.classification,
      blockedReasons: item.blockedReasons ?? [],
      adoptionConstraints: asStringArray(item.objectLinks?.adoptionConstraints ?? null),
      reconciliationTargets: (item.objectLinks?.reconciliationLinks ?? []).map((link) => String(link.targetPath ?? "")),
      backupPath: item.backup?.backupPath ?? null,
      sha256: item.sha256 ?? null,
    });
  }

  return {
    gateGeneratedAt: String(gate.generatedAt ?? ""),
    autoItems,
    skipped,
    ownerReviewQueue,
  };
}

/** 机器门禁：与 gate 规则一致的逐项重验；返回拦截原因或 null。 */
function gateBlockReason(item: W0ManifestItem): string | null {
  if (!IMPORTABLE_CLASSIFICATIONS.has(item.classification)) return `classification=${item.classification}`;
  if (item.disposition !== "migrate-candidate") return `disposition=${item.disposition}`;
  if (!item.sha256) return "no-hash";
  const backup = item.backup;
  if (!backup?.backupPath) return "no-backup-path";
  if (backup.coverage !== "covered") return `coverage=${backup.coverage}`;
  if (backup.readbackResult !== "readback-match-manifest") return `readback=${backup.readbackResult}`;
  if (backup.driftSinceScan !== "unchanged") return `drift=${backup.driftSinceScan}`;
  if ((item.blockedReasons ?? []).length > 0) return `blockedReasons=${item.blockedReasons.join(",")}`;
  const constraints = item.objectLinks?.adoptionConstraints;
  if (Array.isArray(constraints) && constraints.length > 0) return "adoption-constraints-present";
  return null;
}

function toMigrationItem(item: W0ManifestItem): MigrationItem {
  return {
    itemId: item.id,
    scope: { userId: item.scope.user, projectId: item.scope.projectId, instanceId: item.scope.instanceId },
    path: item.path,
    fileName: path.posix.basename(item.path),
    classification: item.classification as "data_asset" | "method",
    sourceHash: item.sha256,
    size: item.size,
    backupPath: item.backup.backupPath,
    reconciliationLinks: item.objectLinks?.reconciliationLinks ?? [],
  };
}

// ---------- staging：受控隔离副本 ----------

export interface StagedCopy {
  itemId: string;
  copyPath: string;
  copyHash: string;
}

export interface StageOutcome {
  itemId: string;
  status: "staged" | "skipped";
  reason?: string;
  copyPath?: string;
  copyHash?: string;
}

/**
 * 从备份根实读字节、重算 sha256 并与 W0 manifest 双核对后落隔离副本。
 * 备份缺失、字节漂移（与 manifest hash 不一致）即拦截。
 */
export function stageMigrationCopies(
  items: MigrationItem[],
  backupRoot: string,
  copyRoot: string,
): { staged: Map<string, StagedCopy>; outcomes: StageOutcome[] } {
  const staged = new Map<string, StagedCopy>();
  const outcomes: StageOutcome[] = [];
  for (const item of items) {
    const absBackup = path.join(backupRoot, item.backupPath);
    let bytes: Buffer;
    try {
      bytes = readFileSync(absBackup);
    } catch {
      outcomes.push({ itemId: item.itemId, status: "skipped", reason: "backup-unreadable" });
      continue;
    }
    const copyHash = createHash("sha256").update(bytes).digest("hex");
    if (copyHash !== item.sourceHash) {
      outcomes.push({ itemId: item.itemId, status: "skipped", reason: `hash-drift(source=${item.sourceHash},backup=${copyHash})` });
      continue;
    }
    const relCopy = path.join(item.scope.userId, item.path);
    const absCopy = path.join(copyRoot, relCopy);
    mkdirSync(path.dirname(absCopy), { recursive: true });
    writeFileSync(absCopy, bytes);
    const record: StagedCopy = { itemId: item.itemId, copyPath: relCopy, copyHash };
    staged.set(item.itemId, record);
    outcomes.push({ itemId: item.itemId, status: "staged", copyPath: relCopy, copyHash });
  }
  return { staged, outcomes };
}

// ---------- 导入 ----------

export interface ImportOutcome {
  itemId: string;
  objectType: "asset" | "method";
  assetId: string;
  assetVersionId: string;
  methodId?: string;
  methodVersionId?: string;
  scope: UserScope;
  sourceHash: string;
  copyHash: string;
  storedHash: string;
  idempotentReplay: boolean;
}

export interface ImportResult {
  outcomes: ImportOutcome[];
  failures: Array<{ itemId: string; error: string }>;
  /** 服务边界拦截（如资产格式白名单），非导入器缺陷；如实上报，不静默。 */
  skipped: Array<{ itemId: string; reason: string }>;
}

function idemKey(itemId: string): string {
  return `w6:${itemId}`;
}

/** 幂等重放判定：导入前该 scope 已有同 idempotency_key 的版本行。 */
function isReplay(scope: UserScope, key: string): boolean {
  const row = sqlite
    .prepare("SELECT 1 AS hit FROM user_asset_versions WHERE user_id=? AND project_id=? AND instance_id=? AND idempotency_key=?")
    .get(scope.userId, scope.projectId, scope.instanceId, key);
  return Boolean(row);
}

/** 内容级防重（2026-10-08 镜像定性）：该 scope 已有同 checksum 的 active 资产
 * 时（如复盘报告先经会话保存、workspace 文件又被迁移登记），返回其 assetId。
 * idempotencyKey 只防同 key 重放，防不了"同内容两条资产记录"。 */
function existingAssetIdByChecksum(scope: UserScope, checksum: string): string | null {
  const row = sqlite
    .prepare(
      "SELECT a.asset_id AS assetId FROM user_assets a JOIN user_asset_versions v ON v.version_id=a.current_version_id " +
      "WHERE a.user_id=? AND a.project_id=? AND a.instance_id=? AND a.status='active' AND v.checksum=? LIMIT 1",
    )
    .get(scope.userId, scope.projectId, scope.instanceId, checksum) as { assetId?: string } | undefined;
  return row?.assetId ?? null;
}

/**
 * 导入已 staged 的项到（隔离）库。幂等：同 idempotencyKey 重放返回原对象，
 * 零新增副作用（user-assets 与 agent-space 服务层既有幂等语义）。
 * method 只建 draft 归档态版本；任何 approve/adopt 都不在迁移路径上。
 */
export async function importStagedMigration(
  items: MigrationItem[],
  staged: Map<string, StagedCopy>,
  copyRoot: string,
): Promise<ImportResult> {
  const outcomes: ImportOutcome[] = [];
  const failures: Array<{ itemId: string; error: string }> = [];
  const skipped: Array<{ itemId: string; reason: string }> = [];
  for (const item of items) {
    const copy = staged.get(item.itemId);
    if (!copy) {
      failures.push({ itemId: item.itemId, error: "not-staged" });
      continue;
    }
    try {
      const bytes = readFileSync(path.join(copyRoot, copy.copyPath));
      // 先判同 key 重放（返回原对象），再判内容级重复：同内容不同 key 的
      // 登记才跳过（如复盘报告已由会话保存、workspace 文件又被迁移登记）。
      const replay = isReplay(item.scope, idemKey(item.itemId));
      if (!replay) {
        const existingAssetId = existingAssetIdByChecksum(item.scope, item.sourceHash);
        if (existingAssetId) {
          skipped.push({ itemId: item.itemId, reason: `content-duplicate of active asset ${existingAssetId}` });
          continue;
        }
      }
      const asset = await createUserAsset({
        ...item.scope,
        name: item.path,
        fileName: item.fileName,
        bytes,
        source: "restore",
        idempotencyKey: idemKey(item.itemId),
      });
      const versionId = currentVersionId(item.scope, asset.assetId);
      const stored = await readUserAssetVersion({ ...item.scope, assetId: asset.assetId, versionId });
      const storedHash = createHash("sha256").update(stored.bytes).digest("hex");
      const outcome: ImportOutcome = {
        itemId: item.itemId,
        objectType: "asset",
        assetId: asset.assetId,
        assetVersionId: versionId,
        scope: item.scope,
        sourceHash: item.sourceHash,
        copyHash: copy.copyHash,
        storedHash,
        idempotentReplay: replay,
      };
      if (item.classification === "method") {
        const method = createMethod({
          scope: item.scope,
          name: item.fileName.replace(/\.[^.]+$/, ""),
          description: `W6 迁移演练导入（源 ${item.path}，W0 条目 ${item.itemId}）`,
          idempotencyKey: idemKey(`${item.itemId}:method`),
          actor: "w6-migration",
        });
        const version = addMethodVersion({
          scope: item.scope,
          methodId: method.method_id,
          contentRef: { assetId: asset.assetId, assetVersionId: versionId, contentChecksum: storedHash },
          origin: "migration",
          adoptionNote: `W0 ${item.itemId}; reconciliation=${JSON.stringify(item.reconciliationLinks)}`,
          idempotencyKey: idemKey(`${item.itemId}:method-version`),
          actor: "w6-migration",
        });
        outcome.objectType = "method";
        outcome.methodId = method.method_id;
        outcome.methodVersionId = version.version_id;
      }
      outcomes.push(outcome);
    } catch (error) {
      const message = (error as Error).message;
      if (message.startsWith("ASSET_UNSUPPORTED_FORMAT:")) {
        skipped.push({ itemId: item.itemId, reason: `format-unsupported-by-asset-service (${message.split(":")[1] ?? ""})` });
      } else {
        failures.push({ itemId: item.itemId, error: message });
      }
    }
  }
  return { outcomes, failures, skipped };
}

function currentVersionId(scope: UserScope, assetId: string): string {
  const row = sqlite
    .prepare("SELECT current_version_id AS v FROM user_assets WHERE asset_id=? AND user_id=? AND project_id=? AND instance_id=?")
    .get(assetId, scope.userId, scope.projectId, scope.instanceId) as { v: string | null };
  if (!row?.v) throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `asset ${assetId} has no current version`);
  return row.v;
}

// ---------- 导入核对 ----------

export interface VerifyOutcome {
  itemId: string;
  scopeOk: boolean;
  storedHashMatchesSource: boolean;
  sameScopeReadable: boolean;
  crossScopeRejected: boolean;
  archivedMethodState: boolean | null;
  detail?: string;
}

/**
 * 导入后逐项核对：scope 行归属、存储字节 hash 与源一致、同 scope 可读、
 * 跨 scope 不可读；method 项额外核对归档态（draft、无 current、无 approved）。
 */
export async function verifyMigrationImport(
  outcomes: ImportOutcome[],
  crossScope: UserScope,
): Promise<VerifyOutcome[]> {
  const results: VerifyOutcome[] = [];
  for (const outcome of outcomes) {
    const scope = outcome.scope;
    let sameScopeReadable = false;
    let storedHashMatchesSource = false;
    let detail: string | undefined;
    try {
      const stored = await readUserAssetVersion({ ...scope, assetId: outcome.assetId, versionId: outcome.assetVersionId });
      sameScopeReadable = true;
      storedHashMatchesSource = createHash("sha256").update(stored.bytes).digest("hex") === outcome.sourceHash;
    } catch (error) {
      detail = (error as Error).message;
    }
    let crossScopeRejected = false;
    try {
      await readUserAssetVersion({ ...crossScope, assetId: outcome.assetId, versionId: outcome.assetVersionId });
    } catch {
      crossScopeRejected = true;
    }
    let archivedMethodState: boolean | null = null;
    if (outcome.methodId && outcome.methodVersionId) {
      const methodRow = sqlite
        .prepare("SELECT status, current_version_id FROM agent_space_methods WHERE method_id=?")
        .get(outcome.methodId) as { status: string; current_version_id: string | null } | undefined;
      const versionRow = sqlite
        .prepare("SELECT status FROM agent_space_method_versions WHERE version_id=?")
        .get(outcome.methodVersionId) as { status: string } | undefined;
      archivedMethodState =
        methodRow?.status === "draft" &&
        methodRow?.current_version_id === null &&
        versionRow?.status === "draft";
    }
    const assetRow = sqlite
      .prepare("SELECT user_id, project_id, instance_id FROM user_assets WHERE asset_id=?")
      .get(outcome.assetId) as { user_id: string; project_id: string; instance_id: string } | undefined;
    const scopeOk =
      assetRow?.user_id === scope.userId &&
      assetRow?.project_id === scope.projectId &&
      assetRow?.instance_id === scope.instanceId;
    results.push({
      itemId: outcome.itemId,
      scopeOk,
      storedHashMatchesSource,
      sameScopeReadable,
      crossScopeRejected,
      archivedMethodState,
      detail,
    });
  }
  return results;
}

/** 供报告核对：某 scope 导入后的方法清单（应全部为 migration 归档态）。 */
export function listMigrationMethods(scope: UserScope): Array<{ methodId: string; name: string; status: string; currentVersionId: string | null }> {
  return listUserMethods(scope).map((m) => ({
    methodId: m.methodId,
    name: m.name,
    status: m.status,
    currentVersionId: m.currentVersionId ?? null,
  }));
}

/** 供报告核对：确认归档 method 的版本行（draft、origin=migration）。 */
export function getMigrationMethodVersion(scope: UserScope, versionId: string): { status: string; origin: string; adoptionConstraints: string[] } {
  const version = getMethodVersion(scope, versionId);
  return {
    status: version.status,
    origin: version.origin,
    adoptionConstraints: parseConstraints(version.adoption_constraints),
  };
}

function parseConstraints(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
