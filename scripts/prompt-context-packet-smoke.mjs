/**
 * 烟测:ACP prompt 构建仍返回 ContextPacket,但普通微信入站 prompt 不再注入上下文包。
 *
 * 用法:npm run build && node scripts/prompt-context-packet-smoke.mjs
 */

import { buildAcpPromptContext } from "../dist/acp/prompt-context-builder.js";
import { clearPendingConfirmation, registerPendingConfirmation } from "../dist/acp/pending-state.js";
import { dailyPlanBackend } from "../dist/lib/daily-plan-backend.js";
import { rememberWeixinTurn } from "../dist/lib/weixin-conversation-memory.js";
import { ensureWorkspace } from "../dist/lib/workspace.js";
import { existsSync } from "node:fs";
import path from "node:path";

const userId = "test-prompt-context-packet";
const instanceId = "test-instance";
const userContext = {
  userId,
  instanceId,
  projectId: "invest-agent",
  conversationId: "conv-prompt-context",
  channel: "weixin-mobile",
};

let pass = 0;
let fail = 0;

function assert(cond, label, value) {
  if (cond) {
    pass++;
    console.log(`✓ ${label}`);
  } else {
    fail++;
    console.error(`✗ ${label}`);
    if (value !== undefined) console.error(value);
  }
}

const workspace = await ensureWorkspace({ userId, projectId: "invest-agent" });
await rememberWeixinTurn(userContext, "生成日复盘", "【2026-06-24 复盘摘要】核心判断...");
await rememberWeixinTurn({ ...userContext, conversationId: "conv-other" }, "另一段对话的内容", "不应进入当前会话 packet");
await dailyPlanBackend.upsert(userId, instanceId, {
  planDate: "2026-06-24",
  generatedAt: new Date().toISOString(),
  summary: "今日复盘摘要",
  content: "# 2026-06-24 日复盘\n\n正文",
  data: { source: "prompt-context-packet-smoke" },
});
registerPendingConfirmation(userContext, {
  kind: "alert_draft",
  summary: "赛轮轮胎跌到 11.22 提醒",
  ttlMs: 60_000,
});

const built = await buildAcpPromptContext({
  userText: "展开一下刚才那份",
  userContext,
});

assert(built.contextPacket.user.userId === userId, "返回 ContextPacket", built.contextPacket.user);
assert(existsSync(path.join(workspace.path, ".codex", "skills", "conversation-recovery", "SKILL.md")), "现有 workspace 补齐 conversation-recovery skill");
assert(built.contextPacket.recentConversation.some((item) => item.content.includes("生成日复盘")), "ContextPacket 包含最近用户消息", built.contextPacket.recentConversation);
assert(built.contextPacket.latestArtifacts.some((item) => item.summary.includes("今日复盘摘要")), "ContextPacket 包含最新复盘摘要", built.contextPacket.latestArtifacts);
assert(built.contextPacket.pendingConfirmations.some((item) => item.summary.includes("赛轮轮胎跌到 11.22 提醒")), "ContextPacket 包含待确认事项", built.contextPacket.pendingConfirmations);
assert(!built.contextPacket.recentConversation.some((item) => item.content.includes("另一段对话的内容")), "ContextPacket 不读取其他 conversation", built.contextPacket.recentConversation);
assert(!built.promptText.includes("sandboxToken="), "普通 prompt 不暴露 sandboxToken 字段", built.promptText);
assert(!built.promptText.includes("sandboxTokenFile="), "普通 prompt 不暴露 sandboxTokenFile 字段", built.promptText);
assert(!built.promptText.includes("workspacePath="), "普通 prompt 不暴露 workspacePath 字段", built.promptText);
assert(!built.promptText.includes("curl 必须"), "普通 prompt 不包含 curl 执行细节", built.promptText);
assert(!built.promptText.includes("服务层工具使用要求"), "普通 prompt 不注入服务层固定指令", built.promptText);
assert(!built.promptText.includes("【最近对话】"), "普通 prompt 不注入最近对话", built.promptText);
assert(!built.promptText.includes("【最近产物】"), "普通 prompt 不注入最近产物", built.promptText);
assert(!built.promptText.includes("【待确认事项】"), "普通 prompt 不注入待确认事项", built.promptText);
assert(!built.promptText.includes("【状态摘要】"), "普通 prompt 不注入状态摘要", built.promptText);

const mcpFirst = await buildAcpPromptContext({
  userText: "继续",
  userContext,
  includeContextPacket: false,
});
assert(mcpFirst.contextPacket === undefined, "MCP-first 普通消息不构造 ContextPacket", mcpFirst.contextPacket);
assert(!mcpFirst.promptText.includes("生成日复盘"), "MCP-first prompt 不携带对话正文", mcpFirst.promptText);
assert(!mcpFirst.promptText.includes("赛轮轮胎跌到 11.22 提醒"), "MCP-first prompt 不携带待确认摘要", mcpFirst.promptText);

const { db } = await import("../dist/db/index.js");
const { chatHistory, dailyPlans } = await import("../dist/db/schema.js");
const { eq } = await import("drizzle-orm");
await db.delete(chatHistory).where(eq(chatHistory.userId, userId));
await db.delete(dailyPlans).where(eq(dailyPlans.userId, userId));
clearPendingConfirmation(userContext, "alert_draft");

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
