/**
 * Mock connector 验收脚本。
 * 用于在没有浏览器的情况下,验证核心 API 路径:
 *  - 登录失败(错误密码)
 *  - 登录成功
 *  - 列出会话
 *  - 选会话查看消息
 *  - 发送消息
 *  - 离线时发送被拒绝
 *
 * 使用方法:
 *   PORTAL_BASE=http://127.0.0.1:3100 PORTAL_USER=primary PORTAL_PASS=User@2026 \
 *   npx tsx scripts/smoke.ts
 */
import "node:process";
import { nanoid } from "nanoid";

interface SmokeConfig {
  base: string;
  username: string;
  password: string;
  sendText: string;
  expectOffline: boolean;
}

function loadConfig(): SmokeConfig {
  const base = process.env.PORTAL_BASE ?? "http://127.0.0.1:3100";
  const username = process.env.PORTAL_USER ?? "primary";
  const password = process.env.PORTAL_PASS ?? "User@2026";
  const sendText = process.env.PORTAL_SMOKE_TEXT ?? "门户 smoke：请只回复收到。";
  const expectOffline = process.env.PORTAL_SMOKE_EXPECT_OFFLINE === "1";
  return { base, username, password, sendText, expectOffline };
}

async function callApi(path: string, init: RequestInit & { raw?: boolean } = {}): Promise<{ status: number; json: any; setCookie: string | null }> {
  const res = await fetch(`${loadConfig().base}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "content-type": "application/json"
    },
    redirect: "manual"
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, json, setCookie };
}

async function expectFailedLogin() {
  const cfg = loadConfig();
  const res = await callApi("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: cfg.username, password: "wrong-password" })
  });
  if (res.status !== 401 || res.json?.error?.code !== "INVALID_CREDENTIALS") {
    throw new Error(`expectFailedLogin: status=${res.status} body=${JSON.stringify(res.json)}`);
  }
  console.log("[smoke] failed login ok");
}

async function expectSuccessLogin(): Promise<string> {
  const cfg = loadConfig();
  const res = await callApi("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: cfg.username, password: cfg.password })
  });
  if (res.status !== 200 || !res.json?.ok) {
    throw new Error(`expectSuccessLogin: status=${res.status} body=${JSON.stringify(res.json)}`);
  }
  const cookie = res.setCookie;
  if (!cookie) throw new Error("expectSuccessLogin: missing set-cookie");
  console.log("[smoke] success login ok");
  return cookie.split(";")[0]!;
}

async function expectConversations(cookie: string) {
  const res = await callApi("/api/conversations", {
    method: "GET",
    headers: { cookie }
  });
  if (res.status !== 200 || !res.json?.ok) {
    throw new Error(`expectConversations: status=${res.status} body=${JSON.stringify(res.json)}`);
  }
  console.log(`[smoke] conversations count=${res.json.data.items.length}`);
  return res.json.data.items;
}

async function expectAssistantStatus(cookie: string) {
  const res = await callApi("/api/assistant/status", {
    method: "GET",
    headers: { cookie }
  });
  if (res.status !== 200 || !res.json?.ok) {
    throw new Error(`expectAssistantStatus: status=${res.status}`);
  }
  console.log(`[smoke] assistant online=${res.json.data.online} mode=${res.json.data.mode}`);
  return res.json.data;
}

async function expectSendMessage(cookie: string) {
  const cfg = loadConfig();
  const conversationId = `web_smoke_${Date.now()}_${nanoid(6)}`;
  const res = await callApi(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({
      text: cfg.sendText,
      idempotencyKey: `smoke_${conversationId}`
    })
  });
  if (res.status !== 200 || !res.json?.ok || !res.json?.data?.ok) {
    throw new Error(`expectSendMessage: status=${res.status} body=${JSON.stringify(res.json)}`);
  }
  const userMessage = res.json.data.userMessage;
  const assistantMessage = res.json.data.assistantMessage;
  if (userMessage?.status !== "sent" || assistantMessage?.status !== "sent") {
    throw new Error(`expectSendMessage: unexpected statuses ${JSON.stringify({ userMessage, assistantMessage })}`);
  }
  if (!assistantMessage?.content || typeof assistantMessage.content !== "string") {
    throw new Error("expectSendMessage: empty assistant message");
  }

  const detail = await callApi(`/api/conversations/${conversationId}`, { headers: { cookie } });
  const messages = detail.json?.data?.messages ?? [];
  if (detail.status !== 200 || !detail.json?.ok || messages.length < 2) {
    throw new Error(`expectSendMessage detail: status=${detail.status} body=${JSON.stringify(detail.json)}`);
  }
  console.log(`[smoke] send ok conversation=${conversationId} messages=${messages.length}`);
  return conversationId;
}

async function expectOfflineSendRejected(cookie: string) {
  const conversationId = `web_offline_smoke_${Date.now()}_${nanoid(6)}`;
  const res = await callApi(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ text: "离线 smoke：这条消息应被拒绝。" })
  });
  const data = res.json?.data;
  if (res.status !== 200 || !res.json?.ok || data?.ok !== false || data?.error?.code !== "CONNECTOR_OFFLINE") {
    throw new Error(`expectOfflineSendRejected: status=${res.status} body=${JSON.stringify(res.json)}`);
  }
  console.log("[smoke] offline send rejected ok");
}

async function main() {
  const cfg = loadConfig();
  await expectFailedLogin();
  const cookie = await expectSuccessLogin();
  const status = await expectAssistantStatus(cookie);
  const conversations = await expectConversations(cookie);
  if (conversations.length > 0) {
    const id = conversations[0].conversationId;
    const detail = await callApi(`/api/conversations/${id}`, { headers: { cookie } });
    console.log(`[smoke] conversation ${id} messages=${detail.json.data.messages.length}`);
  } else {
    console.log("[smoke] empty conversations, skip detail");
  }
  if (cfg.expectOffline) {
    await expectOfflineSendRejected(cookie);
  } else if (status.online) {
    await expectSendMessage(cookie);
  } else {
    console.log("[smoke] assistant offline, skip send smoke");
  }
  console.log("[smoke] all good");
}

void main().catch((err) => {
  console.error("[smoke] failed:", err.message);
  process.exit(1);
});
