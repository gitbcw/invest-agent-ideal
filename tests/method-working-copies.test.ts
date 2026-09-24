/**
 * 方法资产工作副本（未发布修改）服务层测试。
 *
 * 核心契约：
 * - 保存工作副本绝不写 user_asset_versions、绝不改变 current_version_id；
 * - 版本提交也不隐式清除工作副本（清除是调用方的显式收尾动作）；
 * - scope 强制（跨 scope 读写一律 NOT_FOUND）；
 * - 参数校验（空正文 / 越界 baseVersionId）；
 * - 列表读模型带出工作副本徽标信息。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-method-wc-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "wc.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const scopeA = { userId: "wc-user-a", projectId: "invest-agent", instanceId: "wc-agent-a" };
const scopeB = { userId: "wc-user-b", projectId: "invest-agent", instanceId: "wc-agent-b" };

type DbModule = typeof import("../src/db/index.js");
type Loaded = {
  userAssets: typeof import("../src/services/user-assets.js");
  wc: typeof import("../src/services/agent-space/method-working-copies.js");
  portalActions: typeof import("../src/services/agent-space/portal-actions.js");
  sqlite: DbModule["sqlite"];
};
let loaded: Loaded | null = null;
async function load(): Promise<Loaded> {
  if (!loaded) {
    const { initDb, sqlite } = await import("../src/db/index.js");
    initDb();
    const { registerTestProject } = await import("./helpers/mastra-project.js");
    await registerTestProject(scopeA);
    await registerTestProject(scopeB);
    loaded = {
      userAssets: await import("../src/services/user-assets.js"),
      wc: await import("../src/services/agent-space/method-working-copies.js"),
      portalActions: await import("../src/services/agent-space/portal-actions.js"),
      sqlite,
    };
  }
  return loaded;
}

const folderByScope = new Map<string, string>();
async function seedMethodAsset(scope: typeof scopeA, name: string) {
  const { userAssets } = await load();
  let folder = folderByScope.get(scope.userId);
  if (!folder) {
    folder = (await userAssets.createUserAssetFolder({ ...scope, name: "我的方法" })).folderId;
    folderByScope.set(scope.userId, folder);
  }
  const asset = await userAssets.createUserAsset({
    ...scope,
    name,
    fileName: `${name}.md`,
    bytes: new TextEncoder().encode(`# ${name}\n\nv1 正文。`),
    folderId: folder,
    source: "restore",
    idempotencyKey: `wc:seed:${scope.userId}:${name}`,
  });
  return { assetId: asset.assetId, versionId: asset.currentVersionId! };
}

test("save/read/clear roundtrip never touches the version chain", async () => {
  const { wc, sqlite } = await load();
  const { assetId, versionId } = await seedMethodAsset(scopeA, "策略规则");

  const saved = wc.saveMethodWorkingCopy({
    scope: scopeA,
    assetId,
    draftText: "# 策略规则\n\n未发布修改：试仓上限 5%。",
    baseVersionId: versionId,
    actor: "portal:wc-user-a",
  });
  assert.equal(saved.baseVersionId, versionId);

  const read = wc.readMethodWorkingCopy(scopeA, assetId);
  assert.ok(read);
  assert.equal(read!.draftText, "# 策略规则\n\n未发布修改：试仓上限 5%。");

  const versionCount = sqlite.prepare("SELECT COUNT(*) n FROM user_asset_versions WHERE asset_id=?").get(assetId) as { n: number };
  assert.equal(versionCount.n, 1, "保存工作副本不得创建版本");
  const assetRow = sqlite.prepare("SELECT current_version_id FROM user_assets WHERE asset_id=?").get(assetId) as { current_version_id: string };
  assert.equal(assetRow.current_version_id, versionId, "保存工作副本不得改变采用态");

  const auditRow = sqlite
    .prepare("SELECT action FROM agent_space_audit_logs WHERE object_id=? AND action='method_working_copy.saved'")
    .get(assetId) as { action: string } | undefined;
  assert.ok(auditRow, "保存工作副本要留审计");

  const cleared = wc.clearMethodWorkingCopy(scopeA, assetId, "portal:wc-user-a");
  assert.equal(cleared.cleared, true);
  assert.equal(wc.readMethodWorkingCopy(scopeA, assetId), null);
  assert.equal(wc.clearMethodWorkingCopy(scopeA, assetId, "portal:wc-user-a").cleared, false, "清除幂等");
});

test("version commit does not implicitly clear the working copy", async () => {
  const { wc, userAssets } = await load();
  const { assetId, versionId } = await seedMethodAsset(scopeA, "基本面分析方法");
  wc.saveMethodWorkingCopy({ scope: scopeA, assetId, draftText: "草稿正文", baseVersionId: versionId, actor: "portal:wc-user-a" });

  await userAssets.uploadUserAssetVersion({
    ...scopeA,
    assetId,
    fileName: "基本面分析方法.md",
    bytes: new TextEncoder().encode("# 基本面分析方法\n\nv2 正文。"),
    expectedVersionId: versionId,
    source: "upload",
    idempotencyKey: "wc:v2",
  });

  assert.ok(wc.readMethodWorkingCopy(scopeA, assetId), "版本提交不隐式清除工作副本；清除是调用方显式动作");
});

test("cross-scope reads and writes are rejected", async () => {
  const { wc } = await load();
  const { assetId, versionId } = await seedMethodAsset(scopeA, "技术面分析方法");
  wc.saveMethodWorkingCopy({ scope: scopeA, assetId, draftText: "A 的草稿", baseVersionId: versionId, actor: "portal:wc-user-a" });

  // readMethodWorkingCopy 同步抛错：用 throws 而不是 rejects（后者会透传同步异常）。
  assert.throws(() => wc.readMethodWorkingCopy(scopeB, assetId), /not found in scope/);
  assert.throws(
    () => wc.saveMethodWorkingCopy({ scope: scopeB, assetId, draftText: "B 试图覆盖", actor: "portal:wc-user-b" }),
    /not found in scope/,
  );
  assert.equal(wc.listMethodWorkingCopyInfo(scopeB).size, 0);
});

test("argument validation: empty draft and foreign baseVersionId", async () => {
  const { wc } = await load();
  const a = await seedMethodAsset(scopeA, "宏观分析方法");
  const b = await seedMethodAsset(scopeA, "风险控制方法");

  assert.throws(() => wc.saveMethodWorkingCopy({ scope: scopeA, assetId: a.assetId, draftText: "   ", actor: "portal:wc-user-a" }), /draftText is required/);
  assert.throws(
    () => wc.saveMethodWorkingCopy({ scope: scopeA, assetId: a.assetId, draftText: "正文", baseVersionId: b.versionId, actor: "portal:wc-user-a" }),
    /does not belong to asset/,
  );
});

test("archived assets reject working copy access", async () => {
  const { wc, userAssets } = await load();
  const { assetId, versionId } = await seedMethodAsset(scopeA, "海运数据跟踪表");
  wc.saveMethodWorkingCopy({ scope: scopeA, assetId, draftText: "草稿", baseVersionId: versionId, actor: "portal:wc-user-a" });
  await userAssets.archiveUserAsset({ ...scopeA, assetId });
  assert.throws(() => wc.readMethodWorkingCopy(scopeA, assetId), /is archived/);
});

test("portal list view exposes working copy badges", async () => {
  const { wc, portalActions } = await load();
  const { assetId, versionId } = await seedMethodAsset(scopeA, "策略资料徽标");
  wc.saveMethodWorkingCopy({ scope: scopeA, assetId, draftText: "带徽标的草稿", baseVersionId: versionId, actor: "portal:wc-user-a" });

  const items = await portalActions.listPortalMethodAssets(scopeA);
  const item = items.find((entry) => entry.assetId === assetId);
  assert.ok(item, "资产应出现在「我的方法」列表");
  assert.ok(item!.workingCopyUpdatedAt, "有工作副本时列表要带 updatedAt 徽标");
  assert.equal(item!.workingCopyBaseVersionId, versionId);

  wc.clearMethodWorkingCopy(scopeA, assetId, "portal:wc-user-a");
  const after = (await portalActions.listPortalMethodAssets(scopeA)).find((entry) => entry.assetId === assetId);
  assert.ok(after);
  assert.equal(after!.workingCopyUpdatedAt, null, "清除后徽标消失");
});
