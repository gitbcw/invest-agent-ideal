#!/usr/bin/env node
/**
 * T-541 P4 端到端验收（111 隔离环境，API 级全链路）。
 *
 * 前置：start-isolated.mjs 运行中；seed-workspace-objects / seed-failure-fixtures
 * 已执行。覆盖契约验收五组：
 *   1. 侧栏五入口数据面可达（待处理/自动化/我的文件/工作空间双 Tab/设置）；
 *   2. 完整失败处理链：任务失败 → 待处理卡片 → 问题会话 → 候选提出 → 批准生效 → 对象状态可查；
 *   3. 版本/生效分离：编辑方法成新草稿不改已绑定任务与当前采用；
 *   4. 跨 scope：新 API 未授权 scope 一律 0 行或拒绝；
 *   5. 假投递：全程 OFFLINE，微信通道零新增。
 * 用法: node scripts/agent-space/p0/e2e-acceptance.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const P0_ROOT = path.join(REPO_ROOT, ".state", "agent-space-p0");
const PORTAL = "http://127.0.0.1:3110";

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  // 登录
  const login = await fetch(`${PORTAL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "primary", password: "User@2026" }),
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  record("登录（primary 绑定 111 scope）", login.ok && cookie.startsWith("portal_session="));

  const api = async (input, init) => {
    const response = await fetch(input.startsWith("http") ? input : `${PORTAL}${input}`, { ...init, headers: { cookie, ...(init?.headers || {}) } });
    return { status: response.status, payload: await response.json().catch(() => null) };
  };

  console.log("== 1. 侧栏五入口数据面 ==");
  const attention = await api("/api/attention");
  record("待处理入口", attention.payload?.ok === true, `open=${attention.payload?.data?.openCount}`);
  const automations = await api("/api/automations");
  record("自动化任务入口", automations.payload?.ok === true);
  const assets = await api("/api/assets");
  record("我的文件入口", assets.payload?.ok === true);
  const methods = await api("/api/methods");
  record("工作空间·我的方法", methods.payload?.ok === true && methods.payload.data.items.length >= 1, `${methods.payload?.data?.items?.length ?? 0} 个方法`);
  const skillsPrivate = await api("/api/skills?view=private");
  const skillsInstalled = await api("/api/skills?view=installed");
  record("工作空间·我的 Skills（两区块）", skillsPrivate.payload?.ok === true && skillsInstalled.payload?.ok === true, `私有 ${skillsPrivate.payload?.data?.items?.length} / 已安装 ${skillsInstalled.payload?.data?.items?.length}`);
  const preferences = await api("/api/preferences");
  record("设置·通知偏好", preferences.payload?.ok === true);

  console.log("== 2. 完整失败处理链 ==");
  const openItems = attention.payload?.data?.items ?? [];
  record("失败事项存在（卡片数据）", openItems.length >= 2, `${openItems.length} 个 open`);
  const first = openItems[0];
  const taskDetail = await api(`/api/automations/${encodeURIComponent(first.taskId)}/detail`);
  record("任务详情四块（关联失败事项）", taskDetail.payload?.ok === true && taskDetail.payload.data.attention.length >= 1);
  const conv = await api(`/api/attention/${encodeURIComponent(first.itemId)}/conversation`, { method: "POST" });
  const conversationId = conv.payload?.data?.conversationId;
  record("问题处理会话创建", Boolean(conversationId), conversationId?.slice(0, 22));
  {
    // Portal 会话 API 只回 user/assistant 轮；system 注入事实直查隔离库断言
    const Database0 = (await import("better-sqlite3")).default;
    const db0 = new Database0(path.join(P0_ROOT, "runtime.db"), { readonly: true });
    const systemRow = db0
      .prepare("SELECT content FROM conversation_messages WHERE conversation_id=? AND role='system' LIMIT 1")
      .get(conversationId);
    const binding = db0
      .prepare("SELECT metadata FROM conversation_sessions WHERE conversation_id=?")
      .get(conversationId);
    db0.close();
    record(
      "会话含脱敏 system 注入 + 事项绑定",
      Boolean(systemRow?.content.includes("直接影响")) && Boolean(systemRow?.content.includes("不要展示错误码")) && Boolean(binding?.metadata.includes('"attentionItemId"')),
    );
  }

  // 候选链（经真实工具路径已在隔离库构造一条 pending；此处批准）
  let candidates = await api("/api/state-candidates");
  let pending = candidates.payload?.data?.items ?? [];
  if (pending.length === 0) {
    // e2e 前置夹具可运行 seed-issue-candidate.mjs 预置 pending 候选；此处仅提示
    console.log("  （提示：待确认候选为空，可运行 node --import tsx scripts/agent-space/p0/seed-issue-candidate.mjs 预置后再跑）");
  }
  record("候选提出（问题会话附着）", pending.length >= 1, `${pending.length} 条待确认`);
  if (pending.length > 0) {
    const approve = await api("/api/state-candidates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve", objectId: pending[0].objectId, kind: pending[0].kind, versionId: pending[0].versionId }),
    });
    record("候选批准生效", approve.payload?.ok === true);
    const after = await api("/api/state-candidates");
    record("批准后离开待确认", (after.payload?.data?.items ?? []).every((c) => c.objectId !== pending[0].objectId));
  }

  console.log("== 3. 版本与生效分离 ==");
  const method = methods.payload.data.items[0];
  const before = await api(`/api/methods/${encodeURIComponent(method.methodId)}`);
  const beforeVersion = before.payload.data.method.currentVersionId;
  const put = await api(`/api/methods/${encodeURIComponent(method.methodId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: before.payload.data.content?.text ? `${before.payload.data.content.text}\n\n## e2e 验证草稿（不采用）\n` : "# e2e" }),
  });
  record("编辑形成新草稿版本", put.payload?.ok === true);
  const afterEdit = await api(`/api/methods/${encodeURIComponent(method.methodId)}`);
  record("当前采用版本未变（保存≠生效）", afterEdit.payload.data.method.currentVersionId === beforeVersion);
  record("任务绑定版本未变（固定绑定）", afterEdit.payload.data.taskUsage.every((u) => u.pinnedVersionId !== put.payload?.data?.version?.versionId));

  console.log("== 4. 跨 scope 不可见 ==");
  const runtime = "http://127.0.0.1:23660";
  const other = await fetch(`${runtime}/api/portal/conversations?userId=primary&instanceId=invest-agent-primary`, { headers: { Authorization: "Bearer p0-isolated-api-token" } }).then((r) => r.json());
  const otherItems = other?.items ?? [];
  record("未授权 scope 会话 0 行", otherItems.length === 0);
  const scopeInjected = await api("/api/methods", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x", text: "# t", userId: "mg" }) });
  record("浏览器 scope 注入被拒", scopeInjected.payload?.ok === false);

  console.log("== 5. 假投递（OFFLINE）==");
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path.join(P0_ROOT, "runtime.db"), { readonly: true });
  const attemptsNow = db.prepare("SELECT COUNT(*) c FROM weixin_delivery_attempts WHERE user_id='111'").get().c;
  db.close();
  const manifest = JSON.parse(fs.readFileSync(path.join(P0_ROOT, "pull-manifest.json"), "utf8"));
  const attemptsAtPull = manifest.countCheck.find((c) => c.table === "weixin_delivery_attempts")?.source111 ?? 0;
  record("微信通道零触碰（相对拉取快照）", attemptsNow === attemptsAtPull, `pull=${attemptsAtPull} now=${attemptsNow}`);

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
