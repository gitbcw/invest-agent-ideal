/**
 * W6 隔离迁移演练域测试。
 *
 * 覆盖 W6 执行稿验收面：
 * - 门禁消费：服务层逐项重验（不信 gate 列表），owner-review 不进自动导入；
 * - staging：备份字节实读 + sha256 双核对，缺失/漂移逐项拦截；
 * - 导入：data_asset 不 method 化、method 归档 draft（不 approve/不 adopt）、
 *   幂等重放零新增；逐项 scope/hash/可见性核对；
 * - 必测三场景：mg 四因子与 KP 独立（缺账本显式失败，不推断空仓）、
 *   111 一次性回测不变成长久方法（模板/策略双目标留在 owner-review）、
 *   dyk 撤回旧策略只归档（draft 不可 pin）且核心模型在队列中可发现；
 * - 旧 default-load 关闭后，导入对象经授权采用提供交互与任务 run-basis；
 * - 演练脚本两阶段（导入 + 回滚恢复）端到端通过。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-w6-migration-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "w6.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
process.env.SYSTEM_SKILLS_TEMPLATE_ROOT = path.join(root, "templates");
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const sc = {
  mg: { userId: "mg", projectId: "invest-agent", instanceId: "invest-agent-mg" },
  u111: { userId: "111", projectId: "invest-agent", instanceId: "invest-agent-111" },
  dyk: { userId: "dyk", projectId: "invest-agent", instanceId: "invest-agent-dyk" },
  outsider: { userId: "w6-outsider", projectId: "invest-agent", instanceId: "invest-agent-w6-outsider" },
};

/** 同步服务调用的拒绝断言（upsert/approve 等为同步 throw）。 */
function assertThrows(fn: () => unknown, pattern: RegExp, message?: string): void {
  try {
    fn();
  } catch (error) {
    assert.match((error as Error).message, pattern, message);
    return;
  }
  assert.fail(message ?? `expected throw matching ${pattern}`);
}

const OWNER_TOKEN = "w6-test-owner-token";
const sha256Of = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

// ---- mini W0 fixture：真实字节、真实 hash ----
const FF_BODY = Buffer.from("# 控盘度综合评分 V1.1\n四因子可计算实现；与 V1.0 控盘度（KP）两套口径。\n", "utf8");
const KP_BODY = Buffer.from("# 控盘度指标 V1.0（KP 观察版）\n历史定位，禁止默认采用。\n", "utf8");
const DYK_STRATEGY_BODY = Buffer.from("# Strategy Rules (dyk)\n撤回的旧策略，仅归档保全。\n", "utf8");
const DYK_CORE_BODY = Buffer.from("# 核心公司资质六维模型\n恢复可发现性候选。\n", "utf8");
const XLSX_PREFIX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03, 0x04]); // 仅用于漂移/缺失反例的非导入字节
const MG_LEDGER_BODY = Buffer.from("mg 四因子明细 2026-08-25（fixture 用 md，避免 xlsx 结构校验）\n", "utf8");
const U111_DAILY_BODY = Buffer.from("# 2026-09-17 日复盘\n模板输出。\n", "utf8");
const U111_T337_BODY = Buffer.from("T-337 一次性回测 staged output（fixture 用 md）\n", "utf8");
const U111_STRATEGY_BODY = Buffer.from("# 111 strategy rules\n策略与呈现拆分中。\n", "utf8");
const DRIFT_BODY = Buffer.from("备份实际字节与 manifest hash 不一致（漂移拦截反例）", "utf8");
const FAKE_AUTO_BODY = Buffer.from("# 伪装进 autoImportable 的受限项\n", "utf8");
const UNCLASSIFIED_BODY = Buffer.from("# 未分类文件\n", "utf8");

interface FixtureSpec {
  id: string;
  user: keyof typeof sc;
  itemPath: string;
  classification: string;
  disposition: string;
  blockedReasons: string[];
  body: Buffer | null; // null = 备份缺失
  sourceHashOverride?: string; // 制造漂移
  constraints?: unknown[];
  links?: Array<Record<string, unknown>>;
  gate: "auto" | "ownerReview";
}

const SPECS: FixtureSpec[] = [
  {
    id: "mg:liveProjectRoot:methods/控盘度综合评分.md", user: "mg", itemPath: "methods/控盘度综合评分.md",
    classification: "method", disposition: "migrate-candidate", blockedReasons: [], body: FF_BODY,
    links: [{ id: "mg-four-factor", targetPath: "methods/four-factor-score-v1.1.md", role: "direct-content-source", consumers: ["at_ff_consumer"] }],
    gate: "auto",
  },
  {
    id: "mg:liveProjectRoot:deliveries/2026-08-25_持仓与关注股日复盘_控盘度V1.1_四因子版.md", user: "mg",
    itemPath: "deliveries/2026-08-25_持仓与关注股日复盘_控盘度V1.1_四因子版.md",
    classification: "data_asset", disposition: "migrate-candidate", blockedReasons: [], body: MG_LEDGER_BODY, gate: "auto",
  },
  {
    id: "mg:liveProjectRoot:methods/控盘度指标V1.0.md", user: "mg", itemPath: "methods/控盘度指标V1.0.md",
    classification: "method", disposition: "candidate-owner-review",
    blockedReasons: ["owner-review-required", "historical-not-default(历史定位，禁止默认采用)"],
    body: KP_BODY,
    constraints: [{ ref: "mg-kp-old", constraint: "historical-not-default(历史定位，禁止默认采用)" }],
    links: [{ id: "mg-kp-old", targetPath: "history/kp-observation-v1.0.md", role: "direct-content-source" }],
    gate: "ownerReview",
  },
  {
    // 门禁放行（hash 存在且 W0 记录回读一致），staging 时备份文件已不在 → 拦截。
    id: "mg:liveProjectRoot:deliveries/缺失备份反例.txt", user: "mg", itemPath: "deliveries/缺失备份反例.txt",
    classification: "data_asset", disposition: "migrate-candidate", blockedReasons: [],
    body: null, sourceHashOverride: sha256Of(Buffer.from("缺失备份反例的 manifest 记录字节")), gate: "auto",
  },
  {
    id: "mg:liveProjectRoot:deliveries/漂移反例.txt", user: "mg", itemPath: "deliveries/漂移反例.txt",
    classification: "data_asset", disposition: "migrate-candidate", blockedReasons: [], body: DRIFT_BODY,
    sourceHashOverride: "0".repeat(64), gate: "auto",
  },
  {
    id: "mg:liveProjectRoot:methods/伪装AUTO受限项.md", user: "mg", itemPath: "methods/伪装AUTO受限项.md",
    classification: "method", disposition: "migrate-candidate", blockedReasons: [], body: FAKE_AUTO_BODY,
    constraints: [{ ref: "x", constraint: "hold-ambiguity" }], gate: "auto",
  },
  {
    id: "111:liveProjectRoot:reports/daily/2026-09-17.md", user: "u111", itemPath: "reports/daily/2026-09-17.md",
    classification: "data_asset", disposition: "migrate-candidate", blockedReasons: [], body: U111_DAILY_BODY, gate: "auto",
  },
  {
    id: "111:liveProjectRoot:deliveries/T-337-stagedOutput-验收.md", user: "u111", itemPath: "deliveries/T-337-stagedOutput-验收.md",
    classification: "data_asset", disposition: "migrate-candidate", blockedReasons: [], body: U111_T337_BODY, gate: "auto",
  },
  {
    id: "111:liveProjectRoot:methods/strategy-rules.md", user: "u111", itemPath: "methods/strategy-rules.md",
    classification: "method", disposition: "candidate-owner-review",
    blockedReasons: ["owner-review-required", "split-in-progress(拆分未验证，不得自动作为完整 Method 采用)"],
    body: U111_STRATEGY_BODY,
    constraints: [{ ref: "111-strategy", constraint: "split-in-progress(拆分未验证，不得自动作为完整 Method 采用)" }],
    links: [
      { id: "111-strategy", targetPath: "methods/strategy-rules.md", role: "identity" },
      { id: "111-daily-review", targetPath: "workflows/daily-review.md", role: "split-source", consumers: ["migrated_scheduled-daily-review_fa57baa2"] },
    ],
    gate: "ownerReview",
  },
  {
    id: "dyk:liveProjectRoot:methods/strategy-rules.md", user: "dyk", itemPath: "methods/strategy-rules.md",
    classification: "method", disposition: "migrate-candidate", blockedReasons: [], body: DYK_STRATEGY_BODY,
    links: [{ id: "dyk-strategy", targetPath: "methods/strategy-rules.md", role: "identity", disposition: "preserve-current" }],
    gate: "auto",
  },
  {
    id: "dyk:liveProjectRoot:assets/migrated/knowledge/methods/fundamental.md", user: "dyk",
    itemPath: "assets/migrated/knowledge/methods/fundamental.md",
    classification: "method", disposition: "candidate-owner-review",
    blockedReasons: ["owner-review-required", "restore-candidate(恢复可发现性候选，未接入运行)"],
    body: DYK_CORE_BODY,
    constraints: [{ ref: "dyk-core-qualification", constraint: "restore-candidate(恢复可发现性候选，未接入运行)" }],
    links: [{ id: "dyk-core-qualification", targetPath: "methods/core-company-qualification.md", role: "direct-content-source" }],
    gate: "ownerReview",
  },
  {
    id: "dyk:liveProjectRoot:reports/daily/未分类反例.md", user: "dyk", itemPath: "reports/daily/未分类反例.md",
    classification: "unclassified", disposition: "migrate-candidate", blockedReasons: [], body: UNCLASSIFIED_BODY, gate: "auto",
  },
];

const userInstanceId: Record<keyof typeof sc, string> = { mg: "invest-agent-mg", u111: "invest-agent-111", dyk: "invest-agent-dyk", outsider: "invest-agent-w6-outsider" };

function manifestEntryOf(spec: FixtureSpec): Record<string, unknown> {
  const sourceHash = spec.sourceHashOverride ?? (spec.body ? sha256Of(spec.body) : "");
  return {
    id: spec.id,
    scope: { user: sc[spec.user].userId, projectId: "invest-agent", instanceId: userInstanceId[spec.user], scopeVerifiedBy: "fixture" },
    source: "liveProjectRoot",
    path: spec.itemPath,
    kind: "file",
    sha256: sourceHash,
    size: spec.body?.length ?? 0,
    mtime: "2026-09-20T00:00:00.000Z",
    classification: spec.classification,
    disposition: spec.disposition,
    confidence: "high",
    blockedReasons: spec.blockedReasons,
    contextEntry: { readable: true, defaultInject: "none", entryClass: "on-demand" },
    evidenceRefs: ["FIXTURE"],
    consumers: [],
    objectLinks: { reconciliationLinks: spec.links ?? [], adoptionConstraints: spec.constraints ?? [] },
    backup: {
      backupPath: `runtime-data/projects/fixture-${sc[spec.user].userId}/${spec.itemPath}`,
      coverage: "covered",
      readbackResult: "readback-match-manifest",
      readbackHash: sourceHash,
      driftSinceScan: "unchanged",
    },
  };
}

const w0Root = path.join(root, "w0");
const backupRoot = path.join(root, "backup");
const copyRoot = path.join(root, "isolated-copy");

const fixture = (async () => {
  mkdirSync(w0Root, { recursive: true });
  const users: Record<string, { items: unknown[] }> = {};
  for (const spec of SPECS) {
    const userId = sc[spec.user].userId;
    (users[userId] ??= { items: [] }).items.push(manifestEntryOf(spec));
    if (spec.body) {
      const abs = path.join(backupRoot, `runtime-data/projects/fixture-${userId}`, spec.itemPath);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, spec.body);
    }
  }
  writeFileSync(path.join(w0Root, "manifest.json"), JSON.stringify({ schemaVersion: 2, users }));
  writeFileSync(
    path.join(w0Root, "import-gate.json"),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-09-20T16:10:00+08:00",
      rules: { autoImportable: "fixture" },
      autoImportable: SPECS.filter((s) => s.gate === "auto").map((s) => s.id),
      ownerReview: SPECS.filter((s) => s.gate === "ownerReview").map((s) => s.id),
      blocked: {},
    }),
  );

  const db = await import("../src/db/index.js");
  db.initDb();
  db.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('agent_space.owner_admin_token', ?)").run(OWNER_TOKEN);
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  for (const key of ["mg", "u111", "dyk"] as const) await registerTestProject(sc[key]);
  return { db, space: await import("../src/services/agent-space/index.js") };
})();

test("W6 门禁：服务层逐项重验，owner-review 不进自动导入", async () => {
  const { space } = await fixture;
  const inputs = space.loadW0MigrationInputs(w0Root);
  const autoIds = inputs.autoItems.map((i) => i.itemId);
  // 9 个 gate auto 中：受限伪装项、未分类项被服务层拦截；漂移/缺失两项仍在
  // （staging 才拦字节），干净 auto 为 5 项。
  assert.deepEqual(new Set(autoIds), new Set([
    "mg:liveProjectRoot:methods/控盘度综合评分.md",
    "mg:liveProjectRoot:deliveries/2026-08-25_持仓与关注股日复盘_控盘度V1.1_四因子版.md",
    "mg:liveProjectRoot:deliveries/缺失备份反例.txt",
    "mg:liveProjectRoot:deliveries/漂移反例.txt",
    "111:liveProjectRoot:reports/daily/2026-09-17.md",
    "111:liveProjectRoot:deliveries/T-337-stagedOutput-验收.md",
    "dyk:liveProjectRoot:methods/strategy-rules.md",
  ]));
  const skippedIds = inputs.skipped.map((s) => s.itemId).sort();
  assert.deepEqual(skippedIds, ["dyk:liveProjectRoot:reports/daily/未分类反例.md", "mg:liveProjectRoot:methods/伪装AUTO受限项.md"]);
  assert.match(inputs.skipped.find((s) => s.itemId.includes("伪装"))!.reason, /adoption-constraints-present/);
  assert.match(inputs.skipped.find((s) => s.itemId.includes("未分类"))!.reason, /classification=unclassified/);
  // owner-review 可发现性清单：KP/111 策略/dyk 核心模型三关键项字段完整。
  const queue = inputs.ownerReviewQueue;
  assert.equal(queue.length, 3);
  const kp = queue.find((e) => e.itemId.includes("控盘度指标V1.0"))!;
  assert.ok(kp.adoptionConstraints.some((c) => c.startsWith("historical-not-default")), "KP 约束保留");
  assert.ok(kp.reconciliationTargets.includes("history/kp-observation-v1.0.md"));
  assert.ok(kp.backupPath && kp.sha256, "KP 备份位置与 hash 可发现");
  const core = queue.find((e) => e.itemId.includes("fundamental"))!;
  assert.ok(core.adoptionConstraints.some((c) => c.startsWith("restore-candidate")));
  assert.ok(core.reconciliationTargets.includes("methods/core-company-qualification.md"));
  const s111 = queue.find((e) => e.itemId === "111:liveProjectRoot:methods/strategy-rules.md")!;
  assert.deepEqual(s111.reconciliationTargets.sort(), ["methods/strategy-rules.md", "workflows/daily-review.md"]);
});

test("W6 staging：备份字节实读双核对，缺失/漂移逐项拦截", async () => {
  const { space } = await fixture;
  const inputs = space.loadW0MigrationInputs(w0Root);
  const staged = space.stageMigrationCopies(inputs.autoItems, backupRoot, copyRoot);
  const byId = new Map(staged.outcomes.map((o) => [o.itemId, o]));
  assert.equal(staged.outcomes.filter((o) => o.status === "staged").length, 5);
  assert.match(byId.get("mg:liveProjectRoot:deliveries/缺失备份反例.txt")!.reason!, /backup-unreadable/);
  assert.match(byId.get("mg:liveProjectRoot:deliveries/漂移反例.txt")!.reason!, /hash-drift/);
  const ff = byId.get("mg:liveProjectRoot:methods/控盘度综合评分.md")!;
  assert.equal(ff.copyHash, sha256Of(FF_BODY), "副本 hash 与源字节一致");
});

test("W6 导入：归档态 method、data_asset 不 method 化、幂等重放零新增", async () => {
  const { space, db } = await fixture;
  const inputs = space.loadW0MigrationInputs(w0Root);
  const staged = space.stageMigrationCopies(inputs.autoItems, backupRoot, copyRoot);
  const importable = inputs.autoItems.filter((i) => staged.staged.has(i.itemId));
  assert.equal(importable.length, 5);
  const first = await space.importStagedMigration(importable, staged.staged, copyRoot);
  assert.deepEqual(first.failures, []);

  const mgMethod = first.outcomes.find((o) => o.itemId.endsWith("控盘度综合评分.md"))!;
  assert.equal(mgMethod.objectType, "method");
  const dykMethod = first.outcomes.find((o) => o.itemId === "dyk:liveProjectRoot:methods/strategy-rules.md")!;
  assert.equal(dykMethod.objectType, "method");
  // data_asset 一律不建 method；111 无任何 method。
  for (const o of first.outcomes) {
    if (o.objectType === "asset") assert.ok(!o.methodId, `${o.itemId} 不得 method 化`);
  }
  assert.equal(first.outcomes.filter((o) => o.scope.userId === "111" && o.objectType === "method").length, 0);
  assert.equal(first.outcomes.filter((o) => o.scope.userId === "111").length, 2, "111 只导入两项资产");

  // 幂等重放：同 key 二跑零新增、对象 ID 不变。
  const before = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM user_assets").get() as { n: number }).n;
  const second = await space.importStagedMigration(importable, staged.staged, copyRoot);
  const after = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM user_assets").get() as { n: number }).n;
  assert.equal(after, before, "重放不新增资产行");
  assert.ok(second.outcomes.every((o) => o.idempotentReplay));
  for (let i = 0; i < first.outcomes.length; i++) {
    assert.equal(second.outcomes[i]!.assetId, first.outcomes[i]!.assetId);
  }

  // 逐项核对：scope/hash/同 scope 可读/跨 scope 拒绝/归档态。
  const verify = await space.verifyMigrationImport(first.outcomes, sc.outsider);
  for (const v of verify) {
    assert.ok(v.scopeOk && v.storedHashMatchesSource && v.sameScopeReadable && v.crossScopeRejected, v.itemId);
    if (v.itemId === "mg:liveProjectRoot:methods/控盘度综合评分.md" || v.itemId === "dyk:liveProjectRoot:methods/strategy-rules.md") {
      assert.equal(v.archivedMethodState, true, `${v.itemId} 必须归档态`);
    }
  }
  // 存储字节与源 hash 一致（受控副本内容未变形）。
  const stored = await import("../src/services/user-assets.js").then((m) =>
    m.readUserAssetVersion({ ...sc.mg, assetId: mgMethod.assetId, versionId: mgMethod.assetVersionId }));
  assert.equal(sha256Of(Buffer.from(stored.bytes)), sha256Of(FF_BODY));

  // dyk 归档版本行：draft + origin migration + 空约束。
  const dykVersion = space.getMigrationMethodVersion(sc.dyk, dykMethod.methodVersionId!);
  assert.equal(dykVersion.status, "draft");
  assert.equal(dykVersion.origin, "migration");
  assert.deepEqual(dykVersion.adoptionConstraints, []);

  // 内容级防重（2026-10-08 镜像定性）：同 scope 已有同 checksum 的 active
  // 资产（不同 idempotencyKey）时跳过登记，不再造出第二条重复资产记录。
  {
    const { createUserAsset } = await import("../src/services/user-assets.js");
    // 模拟"会话已先保存同一份复盘报告"的既有资产（不同 idempotencyKey）。
    await createUserAsset({
      ...sc.u111,
      name: "每日复盘 2026-09-17（会话已保存）",
      fileName: "2026-09-17.md",
      bytes: U111_DAILY_BODY,
      source: "conversation",
      idempotencyKey: "content-dedup-test:conversation-first",
    });
    const stagedDaily = staged.staged.get("111:liveProjectRoot:reports/daily/2026-09-17.md")!;
    const dailyItem = importable.find((i) => i.itemId === "111:liveProjectRoot:reports/daily/2026-09-17.md")!;
    // key 不同的重放路径已用尽：换新 key 触发内容级判定。
    const freshKeyItem = { ...dailyItem, itemId: `${dailyItem.itemId}:rekeyed` };
    const stagedMap = new Map(staged.staged);
    stagedMap.set(freshKeyItem.itemId, stagedDaily);
    const dedup = await space.importStagedMigration([freshKeyItem], stagedMap, copyRoot);
    assert.deepEqual(dedup.failures, []);
    assert.equal(dedup.outcomes.length, 0, "内容重复项不产生 outcome");
    assert.match(dedup.skipped[0]!.reason, /content-duplicate of active asset asset_/);
    // first 导入的 restore + 预创建的 conversation 共两条；fresh-key 重放不新增第三条。
    const rows = db.sqlite.prepare("SELECT COUNT(*) AS n FROM user_assets a JOIN user_asset_versions v ON v.version_id=a.current_version_id WHERE a.user_id='111' AND v.checksum=?").get(sha256Of(U111_DAILY_BODY)) as { n: number };
    assert.equal(rows.n, 2, "同内容仍只有两条既有记录，重放零新增");
  }
});

test("W6 S1：mg 四因子与 KP 独立；缺账本显式失败，不推断空仓", async () => {
  const { space, db } = await fixture;
  const inputs = space.loadW0MigrationInputs(w0Root);
  const staged = space.stageMigrationCopies(inputs.autoItems, backupRoot, copyRoot);
  const importable = inputs.autoItems.filter((i) => staged.staged.has(i.itemId));
  const imported = await space.importStagedMigration(importable, staged.staged, copyRoot);

  // KP V1.0（owner-review）不在库：mg 的 method 恰为四因子一个。
  const mgMethods = space.listMigrationMethods(sc.mg);
  assert.equal(mgMethods.length, 1);
  assert.match(mgMethods[0]!.name, /控盘度综合评分/);
  const kpQueue = inputs.ownerReviewQueue.find((e) => e.itemId.includes("控盘度指标V1.0"))!;
  assert.ok(!imported.outcomes.some((o) => o.itemId === kpQueue.itemId), "KP 不得被导入");

  const now = new Date().toISOString();
  db.sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at)
                     VALUES ('w6_task_kp',?,?,?,'active',1,?,?)`).run(sc.mg.userId, sc.mg.projectId, sc.mg.instanceId, now, now);
  // 模拟账本资产不在迁移集（keep-authoritative 留旧库）：依赖注册必须显式失败。
  assertThrows(
    () => space.upsertTaskDependency({ scope: sc.mg, taskId: "w6_task_kp", kind: "asset_input", refId: "asset_w6_missing_paper_ledger", versionPolicy: "pinned", pinnedVersionId: "version_w6_missing", actor: "w6-test" }),
    /user asset asset_w6_missing_paper_ledger not found/,
    "缺失账本必须显式失败",
  );
  const basisRows = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_run_basis").get() as { n: number }).n;
  assert.equal(basisRows, 0, "缺账本任务不得产生任何 run basis（不推断空仓）");
});

test("W6 S3：dyk 撤回旧策略只归档；draft 不可 pin 为运行依赖；授权采用路径仍开放", async () => {
  const { space, db } = await fixture;
  const inputs = space.loadW0MigrationInputs(w0Root);
  const staged = space.stageMigrationCopies(inputs.autoItems, backupRoot, copyRoot);
  const importable = inputs.autoItems.filter((i) => staged.staged.has(i.itemId));
  const imported = await space.importStagedMigration(importable, staged.staged, copyRoot);
  const dykMethod = imported.outcomes.find((o) => o.itemId === "dyk:liveProjectRoot:methods/strategy-rules.md")!;

  const now = new Date().toISOString();
  db.sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at)
                     VALUES ('w6_task_dyk',?,?,?,'active',1,?,?)`).run(sc.dyk.userId, sc.dyk.projectId, sc.dyk.instanceId, now, now);
  assertThrows(
    () => space.upsertTaskDependency({ scope: sc.dyk, taskId: "w6_task_dyk", kind: "method", refId: dykMethod.methodId!, versionPolicy: "pinned", pinnedVersionId: dykMethod.methodVersionId!, actor: "w6-test" }),
    /only formal versions resolve/,
    "归档 draft 不得成为运行绑定",
  );

  // 对照：四因子（无约束）走 owner 授权 approve+adopt 后可绑定——归档不阻塞授权采用。
  const mgMethod = imported.outcomes.find((o) => o.itemId.endsWith("控盘度综合评分.md"))!;
  const { approveMethodVersion, createAgent, bindMethod, assembleAndRecordRunBasis } = space;
  approveMethodVersion({
    scope: sc.mg, methodId: mgMethod.methodId!, versionId: mgMethod.methodVersionId!,
    approvedBy: "w6-test-owner", approvalRef: "owner-decision:w6-four-factor",
    ownerToken: OWNER_TOKEN, adopt: true, actor: "w6-test",
  });
  const agent = createAgent({ scope: sc.mg, name: "W6 演练 Agent", actor: "w6-test" });
  space.setAgentStatus(sc.mg, agent.agent_id, "active", "w6-test");
  bindMethod({ scope: sc.mg, agentId: agent.agent_id, methodId: mgMethod.methodId!, versionPolicy: "pinned", pinnedVersionId: mgMethod.methodVersionId!, actor: "w6-test" });

  // run-basis：交互与任务入口都能从导入对象取得依赖；basis 不含旧 workspace 路径。
  db.sqlite.prepare(`INSERT INTO conversation_sessions (conversation_id,user_id,project_id,instance_id,assistant_id,channel,title,last_message_preview,message_count,status,created_at,updated_at)
                     VALUES ('w6_conv',?,?,?,'invest-agent-mg','weixin','W6','',1,'active',?,?)`)
    .run(sc.mg.userId, sc.mg.projectId, sc.mg.instanceId, now, now);
  const convBasis = assembleAndRecordRunBasis({ scope: sc.mg, agentId: agent.agent_id, entryKind: "conversation", basisKey: "conversation:w6_conv:message:w6_msg", conversationId: "w6_conv", actor: "w6-test" });
  assert.equal(convBasis.resolution.methods.length, 1);
  assert.equal(convBasis.resolution.methods[0]!.versionId, mgMethod.methodVersionId);
  const convBasisJson = JSON.stringify(convBasis);
  assert.ok(!convBasisJson.includes(backupRoot) && !convBasisJson.includes(w0Root), "basis 不得携带旧 workspace/备份路径");

  db.sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at)
                     VALUES ('w6_task_ff',?,?,?,'active',1,?,?)`).run(sc.mg.userId, sc.mg.projectId, sc.mg.instanceId, now, now);
  db.sqlite.prepare(`INSERT INTO automation_task_revisions (revision_id,task_id,user_id,project_id,instance_id,revision,name,schedule_json,inputs_json,output_json,delivery_json,created_at)
                     VALUES ('w6_rev_ff','w6_task_ff',?,?,?,1,'W6四因子任务','{}','[]','{"mode":"agent"}','{}',?)`)
    .run(sc.mg.userId, sc.mg.projectId, sc.mg.instanceId, now);
  db.sqlite.prepare(`INSERT INTO automation_task_runs (run_id,task_id,revision_id,user_id,project_id,instance_id,origin,idempotency_key,attempt,status,claimed_at,started_at,created_at,updated_at)
                     VALUES ('w6_run_ff','w6_task_ff','w6_rev_ff',?,?,?,'manual','w6-idem',1,'succeeded',?,?,?,?)`)
    .run(sc.mg.userId, sc.mg.projectId, sc.mg.instanceId, now, now, now, now);
  space.upsertTaskDependency({ scope: sc.mg, taskId: "w6_task_ff", kind: "method", refId: mgMethod.methodId!, versionPolicy: "pinned", pinnedVersionId: mgMethod.methodVersionId!, actor: "w6-test" });
  const taskBasis = assembleAndRecordRunBasis({ scope: sc.mg, agentId: agent.agent_id, entryKind: "scheduled", basisKey: "run:w6_run_ff:basis", taskId: "w6_task_ff", runId: "w6_run_ff", actor: "w6-test" });
  assert.equal(taskBasis.resolution.methods.length, 1, "任务装配封闭于声明依赖");
  assert.equal(taskBasis.resolution.methods[0]!.methodId, mgMethod.methodId);
});

test("W7 注册脚本：adopt 后可 pin 到 active 任务，未 adopt/非 active 拒绝", async (t) => {
  const { space, db } = await fixture;
  // 组自洽（组间可能并发）：不依赖其他组的前置状态，任务与采用都在本组内就绪。
  const ffItemId = "mg:liveProjectRoot:methods/控盘度综合评分.md";
  const now = new Date().toISOString();
  db.sqlite.prepare(`INSERT OR IGNORE INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at)
                     VALUES ('w7_task_ff',?,?,?,'active',1,?,?)`).run(sc.mg.userId, sc.mg.projectId, sc.mg.instanceId, now, now);
  const ffVersionRow = db.sqlite
    .prepare("SELECT asset_id AS assetId, version_id AS versionId FROM user_asset_versions WHERE idempotency_key=?")
    .get(`w6:${ffItemId}`) as { assetId: string; versionId: string } | undefined;
  assert.ok(ffVersionRow, "四因子内容底座应已由导入组/本组导入就绪（幂等键可查）");
  const ffMethodRow = db.sqlite
    .prepare("SELECT method_id AS methodId, current_version_id AS currentVersionId FROM agent_space_methods WHERE idempotency_key=?")
    .get(`w6:${ffItemId}:method`) as { methodId: string; currentVersionId: string | null };
  if (!ffMethodRow.currentVersionId) {
    // 本组先于 adopt 组执行时自行完成授权采用（owner 路径，幂等场景内只做一次）。
    const versionId = db.sqlite
      .prepare("SELECT version_id AS v FROM agent_space_method_versions WHERE method_id=? AND status='draft' ORDER BY rowid LIMIT 1")
      .get(ffMethodRow.methodId) as { v: string };
    space.approveMethodVersion({
      scope: sc.mg, methodId: ffMethodRow.methodId, versionId: versionId.v,
      approvedBy: "w6-test-owner", approvalRef: "owner-decision:w7-script-test",
      ownerToken: OWNER_TOKEN, adopt: true, actor: "w7-test",
    });
  }
  db.sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at)
                     VALUES ('w7_task_paused',?,?,?,'paused',1,?,?)`).run(sc.mg.userId, sc.mg.projectId, sc.mg.instanceId, now, now);
  const unadopted = space.createMethod({ scope: sc.mg, name: "W7未采用方法", actor: "w7-test" });
  space.addMethodVersion({
    scope: sc.mg, methodId: unadopted.method_id,
    contentRef: { assetId: ffVersionRow.assetId, assetVersionId: ffVersionRow.versionId, contentChecksum: sha256Of(FF_BODY) },
    actor: "w7-test",
  });

  const planPath = path.join(root, "w7-dep-plan.json");
  writeFileSync(planPath, JSON.stringify([
    { userId: "mg", methodItemId: ffItemId, taskIds: ["w7_task_ff"] },
    { userId: "mg", methodItemId: ffItemId, taskIds: ["w7_task_paused"] },
    { userId: "mg", methodItemId: "mg:liveProjectRoot:methods/不存在的方法.md", taskIds: ["w7_task_ff"] },
  ]));
  const script = path.join(import.meta.dirname, "..", "scripts", "agent-space", "w7-register-task-deps.mjs");
  const runScript = (extra: string[]) => spawnSync(process.execPath, ["--import", "tsx", script, ...extra], { encoding: "utf8" });
  t.after(() => { rmSync(planPath, { force: true }); });

  // dry-run：合法项标 dry-run，非法项带原因拒绝，退出码 1。
  const dry = runScript(["--plan", planPath]);
  // 脚本 stdout 可能混入 db 初始化 INFO 日志；报告是最后一个完整 JSON 对象。
  const jsonOf = (out: string) => JSON.parse(out.slice(out.indexOf("{")));
  const dryReport = jsonOf(dry.stdout) as { ok: boolean; results: Array<{ taskId?: string; status: string; reason?: string }> };
  assert.equal(dry.status, 1, "存在非法项时 dry-run 也应非零退出");
  assert.ok(dryReport.results.some((r) => r.taskId === "w7_task_ff" && r.status === "dry-run"));
  assert.match(dryReport.results.find((r) => r.taskId === "w7_task_paused")!.reason!, /task is paused/);
  assert.match(dryReport.results.find((r) => !r.taskId)!.reason!, /method not imported/);

  // confirm：合法项注册成功且幂等重跑零新增。
  const okPlanPath = path.join(root, "w7-dep-plan-ok.json");
  writeFileSync(okPlanPath, JSON.stringify([{ userId: "mg", methodItemId: ffItemId, taskIds: ["w7_task_ff"] }]));
  t.after(() => { rmSync(okPlanPath, { force: true }); });
  const { createHash } = await import("node:crypto");
  const gateSha = createHash("sha256").update(readFileSync(path.join(w0Root, "import-gate.json"))).digest("hex");
  const guarded = (planFile: string) => ["--plan", planFile, "--confirm", "--target", "isolated", "--w0-root", w0Root, "--manifest-sha256", gateSha, "--batch", "B1"];
  // R3 护栏反例：缺 target / production+test env / hash 不匹配 / 批次用户不符。
  assert.equal(runScript(["--plan", okPlanPath, "--confirm"]).status, 2, "confirm 缺 target 身份必须拒绝");
  assert.match(runScript(["--plan", okPlanPath, "--confirm", "--target", "production", "--w0-root", w0Root, "--manifest-sha256", gateSha, "--batch", "B1"]).stderr, /refusing production write under NODE_ENV=test/);
  assert.match(runScript(["--plan", okPlanPath, "--confirm", "--target", "isolated", "--w0-root", w0Root, "--manifest-sha256", "0".repeat(64), "--batch", "B1"]).stderr, /manifest fingerprint mismatch/);
  assert.match(runScript(["--plan", okPlanPath, "--confirm", "--target", "isolated", "--w0-root", w0Root, "--manifest-sha256", gateSha, "--batch", "B2"]).stderr, /do not belong to batch B2/);
  const first = runScript(guarded(okPlanPath));
  assert.equal(first.status, 0, first.stderr);
  const deps = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_task_dependencies WHERE task_id='w7_task_ff' AND kind='method'").get() as { n: number }).n;
  assert.equal(deps, 1);
  const second = runScript(guarded(okPlanPath));
  assert.equal(second.status, 0);
  const depsAfter = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_task_dependencies WHERE task_id='w7_task_ff' AND kind='method'").get() as { n: number }).n;
  assert.equal(depsAfter, 1, "重跑幂等零新增");
});

test("W7 逐用户补偿回滚：deactivate 只停用目标 scope，他人零影响", async () => {
  await fixture;
  const runRoot = path.join(root, "w7-rollback-run");
  mkdirSync(path.join(runRoot, "workspaces"), { recursive: true });
  const scriptEnv = {
    ...process.env,
    DB_PATH: path.join(runRoot, "w6.db"),
    WORKSPACE_ROOT: path.join(runRoot, "workspaces"),
    RUNTIME_DATA_ROOT: path.join(runRoot, "runtime"),
    MASTRA_PROJECTS_ROOT: path.join(runRoot, "projects"),
    SYSTEM_SKILLS_TEMPLATE_ROOT: path.join(runRoot, "templates"),
    NODE_ENV: "test",
    WORKSPACE_BACKEND: "mastra",
  };
  // 阶段一：演练脚本建立完整状态（导入 + approve/adopt + agent + 依赖）。
  const rehearsal = path.join(import.meta.dirname, "..", "scripts", "agent-space", "w6-rehearsal.mjs");
  const phase1 = spawnSync(process.execPath, ["--import", "tsx", rehearsal, "--w0-root", w0Root, "--backup-root", backupRoot, "--out-root", runRoot, "--phase", "import", "--selftest"], { env: scriptEnv, encoding: "utf8" });
  assert.equal(phase1.status, 0, `rehearsal failed:\n${phase1.stdout}\n${phase1.stderr}`);

  // R2 返工夹具：在隔离库预置三个"非批次对象"——手工 Agent（无批次幂等键）、
  // 非 w6 方法 + 指向它的 method 依赖、一条 asset_input 依赖。deactivate 后
  // 必须原封不动（误伤面收敛的机器断言）。
  {
    const { default: Database } = await import("better-sqlite3");
    const iso = new Database(scriptEnv.DB_PATH);
    const nowIso = new Date().toISOString();
    iso.prepare(`INSERT INTO agent_space_agents (agent_id,user_id,project_id,instance_id,name,status,created_at,updated_at)
                 VALUES ('agent_manual_mg','mg','invest-agent','invest-agent-mg','手工既有Agent','active',?,?)`).run(nowIso, nowIso);
    iso.prepare(`INSERT INTO agent_space_methods (method_id,user_id,project_id,instance_id,name,status,current_version_id,created_at,updated_at)
                 VALUES ('method_manual_mg','mg','invest-agent','invest-agent-mg','手工既有方法','active',NULL,?,?)`).run(nowIso, nowIso);
    iso.prepare(`INSERT INTO agent_space_task_dependencies (dependency_id,task_id,user_id,project_id,instance_id,agent_id,kind,ref_id,version_policy,pinned_version_id,metadata_json,created_at,updated_at)
                 VALUES ('dep_manual_method','w6_task_ff','mg','invest-agent','invest-agent-mg',NULL,'method','method_manual_mg','current',NULL,NULL,?,?),
                        ('dep_manual_asset','w6_task_ff','mg','invest-agent','invest-agent-mg',NULL,'asset_input','asset_whatever_existing','pinned','version_whatever',NULL,?,?)`).run(nowIso, nowIso, nowIso, nowIso);
    iso.close();
  }

  const rollbackScript = path.join(import.meta.dirname, "..", "scripts", "agent-space", "w7-rollback-scope.mjs");
  const runRollback = (extra: string[]) => spawnSync(process.execPath, ["--import", "tsx", rollbackScript, ...extra], { env: scriptEnv, encoding: "utf8" });
  // 反例：deactivate 缺 --confirm / 缺 --target 拒绝；switch-only 零操作。
  assert.equal(runRollback(["--scope", "mg", "--level", "deactivate"]).status, 2);
  assert.equal(runRollback(["--scope", "mg", "--level", "deactivate", "--confirm"]).status, 2);
  const switchOnly = runRollback(["--scope", "mg"]);
  assert.equal(switchOnly.status, 0);
  const switchReport = JSON.parse(switchOnly.stdout.slice(switchOnly.stdout.indexOf("{")));
  assert.equal(switchReport.actions.length, 1);
  assert.match(switchReport.actions[0].note, /未做任何数据操作/);

  // 正例：deactivate 只停用 mg 的批次对象（w6 agent/方法/资产 + 指向 w6 方法的依赖）；
  // 手工 Agent、非 w6 方法依赖、asset 依赖、dyk 全部不动。
  const de = runRollback(["--scope", "mg", "--level", "deactivate", "--target", "isolated", "--confirm"]);
  assert.equal(de.status, 0, de.stderr);
  const deReport = JSON.parse(de.stdout.slice(de.stdout.indexOf("{")));
  const kinds = deReport.actions.map((a: { action: string }) => a.action).sort();
  assert.deepEqual(kinds, ["agent.disabled", "asset.archived", "asset.archived", "method.retired", "task-dependency.deleted"], JSON.stringify(kinds));
  assert.equal(deReport.inventory.untouched.nonBatchAgents, 1, "手工 Agent 计入 untouched");
  assert.equal(deReport.inventory.untouched.nonBatchDependencies, 2, "非 w6 依赖计入 untouched");

  const { default: Database } = await import("better-sqlite3");
  const iso = new Database(scriptEnv.DB_PATH, { readonly: true });
  const mgAgent = iso.prepare("SELECT status FROM agent_space_agents WHERE user_id='mg' AND agent_id != 'agent_manual_mg'").get() as { status: string };
  assert.equal(mgAgent.status, "disabled");
  const manualAgent = iso.prepare("SELECT status FROM agent_space_agents WHERE agent_id='agent_manual_mg'").get() as { status: string };
  assert.equal(manualAgent.status, "active", "手工 Agent 不得被停用");
  const manualDeps = iso.prepare("SELECT COUNT(*) AS n FROM agent_space_task_dependencies WHERE dependency_id IN ('dep_manual_method','dep_manual_asset')").get() as { n: number };
  assert.equal(manualDeps.n, 2, "非批次依赖不得被删除");
  const manualMethod = iso.prepare("SELECT status FROM agent_space_methods WHERE method_id='method_manual_mg'").get() as { status: string };
  assert.equal(manualMethod.status, "active", "非 w6 方法不得被停用");
  const mgMethod = iso.prepare("SELECT status FROM agent_space_methods WHERE user_id='mg' AND idempotency_key LIKE 'w6:%'").get() as { status: string };
  assert.equal(mgMethod.status, "retired");
  const mgAssets = iso.prepare("SELECT COUNT(*) AS n FROM user_assets WHERE user_id='mg' AND status='active'").get() as { n: number };
  assert.equal(mgAssets.n, 0, "mg 的 w6 资产应全部归档");
  // dyk 零影响：方法仍 draft（非 retired）、资产仍 active。
  const dykMethod = iso.prepare("SELECT status FROM agent_space_methods WHERE user_id='dyk'").get() as { status: string };
  assert.equal(dykMethod.status, "draft");
  const dykAssets = iso.prepare("SELECT COUNT(*) AS n FROM user_assets WHERE user_id='dyk' AND status='active'").get() as { n: number };
  assert.ok(dykAssets.n > 0, "dyk 资产不受 mg 回滚影响");
  iso.close();
});

test("W7 smoke 采证脚本：basis/outcome/delivery 链/隔离抽查一次成证", async () => {
  await fixture;
  const runRoot = path.join(root, "w7-smoke-run");
  mkdirSync(path.join(runRoot, "workspaces"), { recursive: true });
  const scriptEnv = {
    ...process.env,
    DB_PATH: path.join(runRoot, "w6.db"),
    WORKSPACE_ROOT: path.join(runRoot, "workspaces"),
    RUNTIME_DATA_ROOT: path.join(runRoot, "runtime"),
    MASTRA_PROJECTS_ROOT: path.join(runRoot, "projects"),
    SYSTEM_SKILLS_TEMPLATE_ROOT: path.join(runRoot, "templates"),
    NODE_ENV: "test",
    WORKSPACE_BACKEND: "mastra",
  };
  const rehearsal = path.join(import.meta.dirname, "..", "scripts", "agent-space", "w6-rehearsal.mjs");
  const phase1 = spawnSync(process.execPath, ["--import", "tsx", rehearsal, "--w0-root", w0Root, "--backup-root", backupRoot, "--out-root", runRoot, "--phase", "import", "--selftest"], { env: scriptEnv, encoding: "utf8" });
  assert.equal(phase1.status, 0, `rehearsal failed:\n${phase1.stderr}`);

  const smokeScript = path.join(import.meta.dirname, "..", "scripts", "agent-space", "w7-smoke.mjs");
  const smoke = spawnSync(process.execPath, ["--import", "tsx", smokeScript, "--scope", "mg"], { env: scriptEnv, encoding: "utf8" });
  assert.equal(smoke.status, 0, smoke.stderr);
  const report = JSON.parse(smoke.stdout.slice(smoke.stdout.indexOf("{")));
  // basis：演练里 conversation/task 两条 basis 均可查。
  assert.ok(report.basisEvidence.length >= 2, JSON.stringify(report.basisEvidence.map((b: { basisKey: string }) => b.basisKey)));
  assert.ok(report.basisEvidence.some((b: { methods: unknown[] }) => b.methods.length === 1), "四因子装配 basis 可见");
  // outcome 链：采证如实呈现——演练脚本的 run 为 seed 行（不走 finish 咽喉点），
  // outcomes 为空是事实而非缺采证；真实自动 outcome 链由 generic e2e 文件证明
  // （execution_succeeded/failed + delivery_succeeded 自动落库）。
  assert.ok(Array.isArray(report.runOutcomeChain) && report.runOutcomeChain.length >= 1, "最近 run 进入采证链");
  // 隔离抽查：导入资产同 scope 可读、跨 scope 拒绝。
  assert.equal(report.isolationCheck.imported, true);
  assert.equal(report.isolationCheck.sameScopeReadable, true);
  assert.equal(report.isolationCheck.crossScopeRejected, true);
});

test("W6 演练脚本两阶段：fixture 导入全绿，回滚恢复到导入前快照", { timeout: 120_000 }, async () => {
  await fixture;
  const runRoot = path.join(root, "rehearsal-run");
  const scriptEnv = {
    ...process.env,
    DB_PATH: path.join(runRoot, "isolated.db"),
    WORKSPACE_ROOT: path.join(runRoot, "workspaces"),
    RUNTIME_DATA_ROOT: path.join(runRoot, "runtime"),
    MASTRA_PROJECTS_ROOT: path.join(runRoot, "projects"),
    SYSTEM_SKILLS_TEMPLATE_ROOT: path.join(runRoot, "templates"),
    NODE_ENV: "test",
    WORKSPACE_BACKEND: "mastra",
  };
  mkdirSync(path.join(runRoot, "workspaces"), { recursive: true });
  const script = path.join(import.meta.dirname, "..", "scripts", "agent-space", "w6-rehearsal.mjs");
  const run = (extra: string[]) => spawnSync(process.execPath, ["--import", "tsx", script, ...extra], { env: scriptEnv, encoding: "utf8" });
  const importRun = run(["--w0-root", w0Root, "--backup-root", backupRoot, "--out-root", runRoot, "--phase", "import", "--selftest"]);
  assert.equal(importRun.status, 0, `import phase failed:\n${importRun.stdout}\n${importRun.stderr}`);
  const report = JSON.parse(readFileSync(path.join(runRoot, "report.json"), "utf8")) as {
    pass: boolean; counts: { imported: number; ownerReviewQueue: number }; checks: Array<{ name: string; pass: boolean }>;
  };
  assert.equal(report.pass, true);
  assert.equal(report.counts.imported, 5, "fixture 干净项 5 个全部导入");
  assert.equal(report.counts.ownerReviewQueue, 3);
  for (const required of [
    "isolated-workspace-root-empty (旧 default-load 关闭)",
    "S1 old KP stays owner-review (not imported)",
    "S1 missing ledger fails loudly (no empty-position inference)",
    "S1 KP task leaves no run basis",
    "S2 111 imports no method (回测/日报保持资产)",
    "S2 one-off backtest imported as asset only",
    "S3 archived draft cannot pin as task dependency",
    "S3 dyk core model discoverable in owner-review queue",
    "run-basis conversation resolves four-factor",
    "run-basis task assembly closed to declared deps",
  ]) {
    const found = report.checks.find((c) => c.name === required);
    assert.ok(found?.pass, `演练脚本缺检查或未过：${required}`);
  }
  const snapshot = path.join(runRoot, "04-rollback", "pre-snapshot.db");
  const rollbackRun = run(["--w0-root", w0Root, "--phase", "rollback-verify", "--snapshot", snapshot, "--out-root", runRoot]);
  assert.equal(rollbackRun.status, 0, `rollback phase failed:\n${rollbackRun.stdout}\n${rollbackRun.stderr}`);
  const rollbackReport = JSON.parse(readFileSync(path.join(runRoot, "report-rollback.json"), "utf8")) as { pass: boolean };
  assert.equal(rollbackReport.pass, true, "回滚恢复后导入对象必须清零");
});
