#!/usr/bin/env node
/**
 * T-537 P0: 111 隔离环境自检。走真实链路（Portal 登录 → relay → connector →
 * runtime → 隔离 DB → 容器字节），不做 mock。
 *
 * 前置：start-isolated.mjs 已在运行。
 *
 * 检查项（对应 T-537 验收标准）：
 *   1. runtime /health 可达且带隔离 token 鉴权生效；
 *   2. 111 真实对象形态可读（conversations / assets / automations / agent_space 装配态）；
 *   3. 跨 scope 不可见（primary scope 查询返回 0 行）；
 *   4. 假投递：offline mode 生效（push 出口被挡）；
 *   5. Portal 全链路：登录 → 会话列表 → 资产列表（经 connector）。
 *
 * 用法: node scripts/agent-space/p0/verify-isolated.mjs
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash as hash } from "node:crypto";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const P0_ROOT = path.join(REPO_ROOT, ".state", "agent-space-p0");

const RUNTIME = "http://127.0.0.1:23660";
const PORTAL = "http://127.0.0.1:3110";
const API_TOKEN = "p0-isolated-api-token";
const SCOPE = {
  userId: process.env.P0_USER_ID ?? "111",
  projectId: process.env.P0_PROJECT_ID ?? "invest-agent",
  instanceId: process.env.P0_INSTANCE_ID ?? `invest-agent-${process.env.P0_USER_ID ?? "111"}`,
};
const SCOPE_DIGEST = hash("sha256").update(`${SCOPE.userId}\0${SCOPE.projectId}\0${SCOPE.instanceId}`).digest("hex").slice(0, 24);

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function itemCount(payload) {
  // runtime HTTP: {ok, items:[]}; Portal API: {ok, data:{items:[]}}
  const items = payload?.items ?? payload?.data?.items;
  return Array.isArray(items) ? items.length : -1;
}

async function main() {
  console.log("== 1. runtime 健康 ==");
  const health = await fetch(`${RUNTIME}/health`).then((r) => r.json()).catch((e) => ({ error: e.message }));
  record("runtime /health 可达", !health.error, health.error || "");

  const scopedConversations = await fetch(
    `${RUNTIME}/api/portal/conversations?userId=${encodeURIComponent(SCOPE.userId)}&instanceId=${encodeURIComponent(SCOPE.instanceId)}`,
    { headers: { Authorization: `Bearer ${API_TOKEN}` } },
  ).then((r) => r.json()).catch((e) => ({ error: e.message }));
  const scopedConversationCount = itemCount(scopedConversations);
  record(`runtime 鉴权数据面可读（${SCOPE.userId} 会话）`, scopedConversationCount > 0, scopedConversations?.error || `${scopedConversationCount} 条`);

  console.log(`== 2. ${SCOPE.userId} 真实对象形态（隔离 DB 直查）==`);
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3");
  const db = new Database(path.join(P0_ROOT, "runtime.db"), { readonly: true });
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const counts = {
    conversations: one("SELECT COUNT(*) c FROM conversation_sessions WHERE user_id=?", SCOPE.userId).c,
    messages: one("SELECT COUNT(*) c FROM conversation_messages WHERE user_id=?", SCOPE.userId).c,
    assets: one("SELECT COUNT(*) c FROM user_assets WHERE user_id=?", SCOPE.userId).c,
    assetVersions: one("SELECT COUNT(*) c FROM user_asset_versions WHERE user_id=?", SCOPE.userId).c,
    automationTasks: one("SELECT COUNT(*) c FROM automation_tasks WHERE user_id=?", SCOPE.userId).c,
    automationRuns: one("SELECT COUNT(*) c FROM automation_task_runs WHERE user_id=?", SCOPE.userId).c,
    agents: one("SELECT COUNT(*) c FROM agent_space_agents WHERE user_id=?", SCOPE.userId).c,
    runBasis: one("SELECT COUNT(*) c FROM agent_space_run_basis WHERE user_id=?", SCOPE.userId).c,
    runOutcomes: one("SELECT COUNT(*) c FROM agent_space_run_outcomes WHERE user_id=?", SCOPE.userId).c,
    methods: one("SELECT COUNT(*) c FROM agent_space_methods WHERE user_id=?", SCOPE.userId).c,
    skills: one("SELECT COUNT(*) c FROM agent_space_skills WHERE user_id=? AND domain='user'", SCOPE.userId).c,
  };
  record(`${SCOPE.userId} 会话/消息形态可读`, counts.conversations > 0 && counts.messages > 0, JSON.stringify(counts));
  record(`${SCOPE.userId} 资产与版本形态可读`, counts.assets > 0 && counts.assetVersions > 0);
  record(`${SCOPE.userId} 定时任务与运行历史可读`, counts.automationTasks > 0 && counts.automationRuns > 0);
  record(`${SCOPE.userId} agent_space 装配态存在（agents/run_basis/outcomes）`, counts.agents > 0 && counts.runBasis > 0 && counts.runOutcomes > 0);
  record("工作空间对象可读（方法/Skills 数量按源备份保留）", counts.methods + counts.skills > 0, `methods=${counts.methods} skills=${counts.skills}`);
  const portalUser = one("SELECT id FROM portal_users WHERE username=? AND instance_id=?", SCOPE.userId, SCOPE.instanceId);
  const presentation = portalUser
    ? {
        labels: one("SELECT COUNT(*) c FROM conversation_labels WHERE user_id=?", portalUser.id).c,
        meta: one("SELECT COUNT(*) c FROM portal_conversation_meta WHERE user_id=?", portalUser.id).c,
      }
    : { labels: 0, meta: 0 };
  record(
    `${SCOPE.userId} Portal 展示态保留（标签与会话元数据）`,
    Boolean(portalUser) && presentation.labels > 0 && presentation.meta > 0,
    JSON.stringify(presentation),
  );

  // 容器字节抽查：最新资产版本 sha256 与 DB checksum 一致
  const latest = one("SELECT version_id, asset_id, file_name, checksum, size_bytes FROM user_asset_versions WHERE user_id=? ORDER BY created_at DESC LIMIT 1", SCOPE.userId);
  const file = path.join(P0_ROOT, "projects", SCOPE_DIGEST, "assets", latest.asset_id, "versions", latest.version_id, latest.file_name);
  const bytes = fs.readFileSync(file);
  const sha = createHash("sha256").update(bytes).digest("hex");
  record("容器资产字节 sha256 与 DB 一致", sha === latest.checksum && bytes.length === latest.size_bytes, latest.file_name);
  db.close();

  console.log("== 3. 跨 scope 不可见 ==");
  const convOther = await fetch(
    `${RUNTIME}/api/portal/conversations?userId=primary&instanceId=invest-agent-primary`,
    { headers: { Authorization: `Bearer ${API_TOKEN}` } },
  ).then((r) => r.json()).catch((e) => ({ error: e.message }));
  record("primary scope 查询返回 0 行（跨 scope 不可见）", itemCount(convOther) === 0, `${itemCount(convOther)} 条`);

  console.log("== 4. 假投递（offline mode）==");
  // offline 挡出口：夹具构造的 push job 停留 pending/failed（无真实外发）；
  // 真正的微信零触碰证据是 weixin_delivery_attempts 相对拉取快照无新增。
  const db2 = new Database(path.join(P0_ROOT, "runtime.db"), { readonly: true });
  const attemptsNow = db2.prepare("SELECT COUNT(*) c FROM weixin_delivery_attempts WHERE user_id=?").get(SCOPE.userId).c;
  const pendingPush = db2.prepare("SELECT COUNT(*) c FROM push_jobs WHERE status='pending' AND user_id=?").get(SCOPE.userId).c;
  db2.close();
  const manifest = JSON.parse(fs.readFileSync(path.join(P0_ROOT, "pull-manifest.json"), "utf8"));
  const attemptsAtPull = manifest.countCheck.find((c) => c.table === "weixin_delivery_attempts")?.source111
    ?? manifest.countCheck.find((c) => c.table === "weixin_delivery_attempts")?.source
    ?? 0;
  record("微信通道零触碰（delivery attempts 无新增）", attemptsNow === attemptsAtPull, `pull=${attemptsAtPull} now=${attemptsNow} pending_push=${pendingPush}（夹具构造的离线待发）`);

  console.log("== 5. Portal 全链路（登录 → connector → 隔离数据）==");
  const login = await fetch(`${PORTAL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "primary", password: "User@2026" }),
  });
  const setCookie = login.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0];
  record("Portal 登录成功（primary 测试身份）", login.ok && cookie.startsWith("portal_session="));

  const pConv = await fetch(`${PORTAL}/api/conversations?limit=50`, { headers: { cookie } }).then((r) => r.json()).catch((e) => ({ error: e.message }));
  record(`Portal 会话列表经 connector 读到 ${SCOPE.userId} 数据`, itemCount(pConv) > 0, `${itemCount(pConv)} 条`);

  const db3 = new Database(path.join(P0_ROOT, "runtime.db"), { readonly: true });
  const expectedPresentation = db3
    .prepare(
      `SELECT COALESCE(pcm.label_id, '') AS label_id, COUNT(*) AS count
       FROM conversation_sessions cs
       LEFT JOIN portal_conversation_meta pcm ON pcm.conversation_id=cs.conversation_id AND pcm.user_id=?
       WHERE cs.user_id=? AND cs.instance_id=? AND cs.assistant_id=?
         AND COALESCE(pcm.deleted_at, '')='' AND COALESCE(pcm.archived_at, '')=''
       GROUP BY COALESCE(pcm.label_id, '') ORDER BY label_id`,
    )
    .all(portalUser.id, SCOPE.userId, SCOPE.instanceId, SCOPE.instanceId);
  db3.close();
  const actualPresentation = new Map();
  for (const item of pConv?.data?.items ?? []) {
    const labelId = item.labelId ?? "";
    actualPresentation.set(labelId, (actualPresentation.get(labelId) ?? 0) + 1);
  }
  const expectedPresentationJson = JSON.stringify(expectedPresentation);
  const actualPresentationJson = JSON.stringify(
    [...actualPresentation.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label_id, count]) => ({ label_id, count })),
  );
  record(
    `Portal 侧栏会话/标签分布与 ${SCOPE.userId} 展示态一致`,
    expectedPresentationJson === actualPresentationJson,
    `expected=${expectedPresentationJson} actual=${actualPresentationJson}`,
  );

  const pAssets = await fetch(`${PORTAL}/api/assets`, { headers: { cookie } }).then((r) => r.json()).catch((e) => ({ error: e.message }));
  record(`Portal 资产列表读到 ${SCOPE.userId} 资产`, itemCount(pAssets) > 0, `${itemCount(pAssets)} 条`);

  const pAuto = await fetch(`${PORTAL}/api/automations`, { headers: { cookie } }).then((r) => r.json()).catch((e) => ({ error: e.message }));
  record(`Portal 自动化列表读到 ${SCOPE.userId} 任务`, itemCount(pAuto) > 0, `${itemCount(pAuto)} 条`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.error("失败项：", failed.map((f) => f.name).join("; "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
