import { randomBytes } from "node:crypto";
import { createAgent } from "../acp/agent.js";
import { clearAcpSessions } from "../acp/stdio-agent.js";
import { sanitizeCustomerText } from "../lib/customer-output.js";
import { logger } from "../lib/logger.js";
import { resolveOrCreateChannelUser } from "../lib/user-identity.js";
import { DEFAULT_USER_ID } from "../lib/user-context.js";
import { rememberWeixinTurn } from "../lib/weixin-conversation-memory.js";
import { config } from "../lib/config.js";
import { resolveWeixinAccount } from "./weixin-account-store.js";

const WEIXIN_MESSAGE_ITEM_TEXT = 1;
const WEIXIN_MESSAGE_TYPE_BOT = 2;
const WEIXIN_MESSAGE_STATE_FINISH = 2;
const WEIXIN_TEXT_CHUNK_LIMIT = Number(process.env.WEIXIN_TEXT_CHUNK_LIMIT) || 1000;
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

export interface WeixinProjectBinding {
  projectId: string;
  instanceId: string;
  ownerUserId?: string;
  ownerDisplayName?: string;
  sharedUsers?: boolean;
}

function buildBaseInfo() {
  return { channel_version: process.env.WEIXIN_CHANNEL_VERSION || "web-1.0.0" };
}

function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function generateWeixinClientId() {
  return `invest-agent:${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function splitWeixinText(text: string, limit = WEIXIN_TEXT_CHUNK_LIMIT): string[] {
  const clean = String(text || "").trim();
  if (!clean) return ["处理完成"];
  if (clean.length <= limit) return [clean];

  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > limit) {
    let cut = findWeixinChunkCut(rest, limit);
    if (cut <= 0) cut = limit;
    const chunk = rest.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}

function findWeixinChunkCut(text: string, limit: number) {
  const slice = text.slice(0, limit);
  const boundaries = [
    slice.lastIndexOf("\n\n"),
    slice.lastIndexOf("\n"),
    slice.lastIndexOf("。"),
    slice.lastIndexOf("！"),
    slice.lastIndexOf("？"),
    slice.lastIndexOf("；"),
    slice.lastIndexOf(";"),
    slice.lastIndexOf(". "),
    slice.lastIndexOf(" "),
  ].filter((index) => index > Math.floor(limit * 0.55));
  const best = boundaries.length > 0 ? Math.max(...boundaries) : -1;
  if (best < 0) return limit;
  return best + (slice[best] === "\n" || slice[best] === " " ? 0 : 1);
}

export async function sendWeixinTextMessage(params: {
  baseUrl: string;
  token: string;
  to: string;
  text: string;
  contextToken?: string;
}) {
  const base = params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`;
  const url = new URL("ilink/bot/sendmessage", base);
  const body = JSON.stringify({
    msg: {
      from_user_id: "",
      to_user_id: params.to,
      client_id: generateWeixinClientId(),
      message_type: WEIXIN_MESSAGE_TYPE_BOT,
      message_state: WEIXIN_MESSAGE_STATE_FINISH,
      item_list: [
        {
          type: WEIXIN_MESSAGE_ITEM_TEXT,
          text_item: { text: params.text },
        },
      ],
      context_token: params.contextToken || undefined,
    },
    base_info: buildBaseInfo(),
  });

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${params.token.trim()}`,
      "Content-Length": String(Buffer.byteLength(body, "utf-8")),
      "X-WECHAT-UIN": randomWechatUin(),
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(unreadable)");
    throw new Error(`微信主动推送失败: ${response.status} ${text.slice(0, 300)}`);
  }

  const responseText = await response.text().catch(() => "");
  logger.info(
    `微信主动推送已提交 to=${params.to} contextToken=${params.contextToken ? "yes" : "no"} status=${response.status} body=${responseText.slice(0, 300)}`
  );
}

export class InvestAgentMobileBridge {
  private readonly agent = createAgent();

  constructor(
    private readonly accountId: string,
    private readonly stateDir = config.weixin.stateDir,
    private readonly projectBinding?: WeixinProjectBinding
  ) {}

  async chat(request: {
    conversationId: string;
    text: string;
    media?: { type: string };
    contextToken?: string;
  }): Promise<{ text?: string }> {
    const conversationId = request.conversationId || `weixin-mobile-${this.accountId}`;
    const userContext = await resolveOrCreateChannelUser({
      channel: "weixin-mobile",
      backend: config.acp.backend,
      externalUserId: conversationId,
      externalAccountId: this.accountId,
      conversationId,
      contextToken: request.contextToken,
      projectBinding: this.projectBinding,
    });

    if (request.media && !request.text) {
      return {
        text: "实验版暂只支持文本消息。图片、语音、文件会在后续多模态阶段支持。",
      };
    }

    const response = await this.agent.handleMessage({
      id: `wx-${Date.now()}`,
      from: request.conversationId || "weixin-mobile",
      timestamp: Date.now(),
      content: { type: "text", text: request.text || "" },
      context: {
        channel: "weixin-mobile",
        conversationId: request.conversationId,
        userId: userContext.userId,
        projectId: userContext.projectId,
        instanceId: userContext.instanceId,
        instanceExpansionPath: userContext.instanceExpansionPath,
        workspacePath: userContext.workspacePath,
      },
    });

    const text = response.content.text ?? "处理完成，但没有生成文本回复。";
    await rememberWeixinTurn(userContext, request.text || "", text);
    const chunks = splitWeixinText(text);
    if (chunks.length > 1) {
      setTimeout(() => {
        this.pushToConversation(conversationId, chunks.slice(1), request.contextToken).catch((error) => {
          logger.warn(`微信分片补发失败: ${(error as Error).message}`);
        });
      }, 1200);
    }
    return { text: chunks[0] };
  }

  async pushToConversation(conversationId: string, text: string | string[], contextToken?: string, baseUrl?: string, token?: string) {
    const chunks = Array.isArray(text) ? text : splitWeixinText(text);
    const account = !token || !baseUrl || !contextToken ? resolveWeixinAccount(this.accountId, this.stateDir) : undefined;
    const resolvedToken = token || account?.token;
    const resolvedBaseUrl = baseUrl || account?.baseUrl || DEFAULT_BASE_URL;
    const resolvedContextToken = contextToken || account?.lastContextToken;
    if (!resolvedToken) {
      throw new Error("缺少微信 token，无法发送消息");
    }
    for (const chunk of chunks) {
      await sendWeixinTextMessage({
        baseUrl: resolvedBaseUrl,
        token: resolvedToken,
        to: conversationId,
        text: chunk,
        contextToken: resolvedContextToken,
      });
    }
  }

  clearSession(conversationId?: string): void {
    if (conversationId) {
      clearAcpSessions(conversationId);
    }
  }
}
