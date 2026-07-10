/**
 * 工作包 4.x chat_history 烟测:验证 weixin-conversation-memory 在 sqlite / workspace 两种模式下行为等价。
 *
 * 覆盖:
 *   1. rememberWeixinTurn 写入
 *   2. loadRecentWeixinMemory 读取
 *   3. 多轮对话顺序正确(最近 N 条)
 *   4. 默认按 user/instance 连续读取,显式 conversation scope 才只读当前会话
 *
 *   WORKSPACE_BACKEND=sqlite node scripts/weixin-memory-smoke.mjs
 *   WORKSPACE_BACKEND=workspace node scripts/weixin-memory-smoke.mjs
 */

import {
  rememberConversationTurn,
  rememberWeixinTurn,
  loadRecentConversationMemory,
  loadRecentWeixinMemory,
  formatRecentMemoryForPrompt,
} from "../dist/lib/weixin-conversation-memory.js";
import { ensureWorkspace, resolveWorkspacePath } from "../dist/lib/workspace.js";
import { rmSync, existsSync } from "node:fs";

const MODE = process.env.WORKSPACE_BACKEND === "sqlite" ? "sqlite" : "workspace";
const TEST_USER = MODE === "workspace" ? "test-weixin-mem-ws" : "test-weixin-mem-sqlite";
const INSTANCE = "test-instance";
const CONVERSATION = "conv-test-1";

let pass = 0;
let fail = 0;

function assert(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}

const userContext = {
  userId: TEST_USER,
  instanceId: INSTANCE,
  conversationId: CONVERSATION,
};

console.log(`[mode=${MODE}] 初始化`);
if (MODE === "workspace") {
  await ensureWorkspace({ userId: TEST_USER, tenantId: TEST_USER, projectId: "invest-agent" });
}

console.log(`\n[mode=${MODE}] 写入 3 轮对话`);
await rememberWeixinTurn(userContext, "阳光电源现在多少", "现价 25.5");
await rememberWeixinTurn(userContext, "赣锋锂业呢", "现价 35");
await rememberWeixinTurn(userContext, "茅台", "现价 1500");

console.log(`\n[mode=${MODE}] 读最近 6 条消息(= 3 轮)`);
const recent3 = await loadRecentWeixinMemory(userContext, 6);
assert(recent3.length === 6, `${MODE}: 读到 6 条消息`);
assert(recent3[0].role === "user" && recent3[0].content === "阳光电源现在多少", `${MODE}: 首条是 user(阳光电源)`);
assert(recent3[1].role === "assistant" && recent3[1].content === "现价 25.5", `${MODE}: 第2条是 assistant(25.5)`);
assert(recent3[5].content === "现价 1500", `${MODE}: 末条是最后写入(1500)`);

console.log(`\n[mode=${MODE}] 读最近 2 条消息(= 1 轮)`);
const recent1 = await loadRecentWeixinMemory(userContext, 2);
assert(recent1.length === 2, `${MODE}: 读到 2 条消息`);
assert(recent1[0].content === "茅台", `${MODE}: 最新 user 是茅台`);

console.log(`\n[mode=${MODE}] conversationId 过滤`);
const otherCtx = { userId: TEST_USER, instanceId: INSTANCE, conversationId: "conv-other" };
const other = await loadRecentWeixinMemory(otherCtx, 10);
assert(other.length === 6, `${MODE}: 默认跨 conversation 读取 user/instance 最近上下文`);
const otherScoped = await loadRecentWeixinMemory(otherCtx, 10, { scope: "conversation" });
assert(otherScoped.length === 0, `${MODE}: 显式 conversation scope 时其他 conversation 读取为空`);

console.log(`\n[mode=${MODE}] 跨渠道共享记忆`);
const webCtx = { userId: TEST_USER, instanceId: INSTANCE, conversationId: "web-conv", channel: "web" };
await rememberConversationTurn(webCtx, "网页端问东方财富", "网页端回答东方财富");
const readFromWeixin = await loadRecentConversationMemory(userContext, 2);
assert(readFromWeixin[0]?.content === "网页端问东方财富", `${MODE}: 微信上下文可读到 Web 最新 user 消息`);
assert(readFromWeixin[1]?.content === "网页端回答东方财富", `${MODE}: 微信上下文可读到 Web 最新 assistant 消息`);

const wxCtx = { ...userContext, conversationId: "wx-conv", channel: "weixin-mobile" };
await rememberWeixinTurn(wxCtx, "微信端问宁德时代", "微信端回答宁德时代");
const readFromWeb = await loadRecentConversationMemory(webCtx, 2);
assert(readFromWeb[0]?.content === "微信端问宁德时代", `${MODE}: Web 上下文可读到微信最新 user 消息`);
assert(readFromWeb[1]?.content === "微信端回答宁德时代", `${MODE}: Web 上下文可读到微信最新 assistant 消息`);

console.log(`\n[mode=${MODE}] formatRecentMemoryForPrompt`);
const formatted = formatRecentMemoryForPrompt(recent1);
assert(formatted.includes("用户：茅台"), `${MODE}: 格式化包含 "用户:茅台"`);
assert(formatted.includes("助手：现价 1500"), `${MODE}: 格式化包含 "助手:1500"`);

console.log(`\n[cleanup] 清理测试数据`);
if (MODE === "workspace") {
  rmSync(resolveWorkspacePath(TEST_USER), { recursive: true, force: true });
  assert(!existsSync(resolveWorkspacePath(TEST_USER)), "workspace 测试目录已清理");
} else {
  const { db } = await import("../dist/db/index.js");
  const { chatHistory } = await import("../dist/db/schema.js");
  const { eq } = await import("drizzle-orm");
  await db.delete(chatHistory).where(eq(chatHistory.userId, TEST_USER));
  assert(true, "SQLite 测试数据已清理");
}

console.log(`\n=== 结果 [mode=${MODE}]: ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
