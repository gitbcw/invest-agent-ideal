import { randomBytes } from "node:crypto";
import { createAgent, type AcpAgent } from "../acp/agent.js";
import { clearAcpSessions } from "../acp/stdio-agent.js";
import { sanitizeCustomerText } from "../lib/customer-output.js";
import { logger } from "../lib/logger.js";
import { resolveOrCreateChannelUser } from "../lib/user-identity.js";
import { DEFAULT_USER_ID, defaultInstanceIdForUser } from "../lib/user-context.js";
import { rememberWeixinTurn } from "../lib/weixin-conversation-memory.js";
import {
  appendConversationMessage,
  getAssistantMessageByRequestId,
  getConversationMessageByIdempotencyKey,
  type ConversationScope,
} from "../services/conversation-log.js";
import { config } from "../lib/config.js";
import { resolveWeixinAccount } from "./weixin-account-store.js";
import { storeWeixinAttachment, type IncomingMediaAttachment, type StoredAttachment } from "../lib/attachment-store.js";
import { registerAttachment } from "../services/file-retention.js";
import { resumeAwaitingWeixinDeliveries } from "../services/weixin-delivery.js";
import { classifyTaskError, executeWithRetryPolicy, executionResponseError, terminalTaskError } from "../services/task-execution.js";

const WEIXIN_MESSAGE_ITEM_TEXT = 1;
const WEIXIN_MESSAGE_TYPE_BOT = 2;
const WEIXIN_MESSAGE_STATE_FINISH = 2;
const WEIXIN_TEXT_CHUNK_LIMIT = Number(process.env.WEIXIN_TEXT_CHUNK_LIMIT) || 2000;
const WEIXIN_INBOUND_BATCH_WINDOW_MS = Number(process.env.WEIXIN_INBOUND_BATCH_WINDOW_MS) || 1200;
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

export interface WeixinProjectBinding {
  projectId: string;
  instanceId: string;
  ownerUserId?: string;
  ownerDisplayName?: string;
  sharedUsers?: boolean;
}

type WeixinChatRequest = {
  conversationId: string;
  text: string;
  messageId?: string;
  media?: IncomingMediaAttachment;
  contextToken?: string;
};

type WeixinBatchItem = WeixinChatRequest & {
  resolve: (response: { text?: string }) => void;
  reject: (error: unknown) => void;
  receivedAt: number;
};

type WeixinConversationBatch = {
  items: WeixinBatchItem[];
  timer?: NodeJS.Timeout;
  processing: boolean;
};

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
  const responseBody = parseWeixinResponseBody(responseText);
  const errcode = responseBody ? Number(responseBody.errcode ?? responseBody.errorCode ?? 0) : 0;
  if (Number.isFinite(errcode) && errcode !== 0) {
    const errmsg = String(responseBody?.errmsg ?? responseBody?.message ?? responseText.slice(0, 300) ?? "unknown");
    throw new Error(`微信主动推送失败: errcode=${errcode} ${errmsg.slice(0, 300)}`);
  }
  const ret = responseBody && responseBody.ret !== undefined ? Number(responseBody.ret) : 0;
  if (Number.isFinite(ret) && ret !== 0) {
    const errmsg = String(responseBody?.errmsg ?? responseBody?.message ?? responseText.slice(0, 300) ?? "unknown");
    throw new Error(`微信主动推送失败: ret=${ret} ${errmsg.slice(0, 300)}`);
  }
  logger.info(
    `微信主动推送已提交 to=${params.to} contextToken=${params.contextToken ? "yes" : "no"} status=${response.status} body=${responseText.slice(0, 300)}`
  );
}

function parseWeixinResponseBody(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export class InvestAgentMobileBridge {
  private readonly inboundBatches = new Map<string, WeixinConversationBatch>();
  private readonly inFlightInboundMessageIds = new Set<string>();

  constructor(
    private readonly accountId: string,
    private readonly stateDir = config.weixin.stateDir,
    private readonly projectBinding?: WeixinProjectBinding,
    private readonly agent: AcpAgent = createAgent(),
  ) {}

  async chat(request: WeixinChatRequest): Promise<{ text?: string }> {
    return this.enqueueInboundMessage(request);
  }

  private async enqueueInboundMessage(request: WeixinChatRequest): Promise<{ text?: string }> {
    const conversationId = request.conversationId || `weixin-mobile-${this.accountId}`;
    const inboundMessageKey = weixinInboundMessageKey(this.accountId, request.messageId);
    if (inboundMessageKey && this.inFlightInboundMessageIds.has(inboundMessageKey)) {
      logger.info(`微信重复入站消息已忽略 account=${this.accountId} conversation=${conversationId}`);
      return {};
    }
    if (inboundMessageKey) this.inFlightInboundMessageIds.add(inboundMessageKey);
    return new Promise((resolve, reject) => {
      const batch = this.inboundBatches.get(conversationId) || {
        items: [],
        processing: false,
      };
      batch.items.push({
        ...request,
        conversationId,
        resolve,
        reject,
        receivedAt: Date.now(),
      });
      this.inboundBatches.set(conversationId, batch);
      this.scheduleInboundBatch(conversationId, batch);
    });
  }

  private scheduleInboundBatch(conversationId: string, batch: WeixinConversationBatch) {
    if (batch.processing || batch.timer) return;
    batch.timer = setTimeout(() => {
      batch.timer = undefined;
      this.flushInboundBatch(conversationId).catch((error) => {
        logger.error("微信消息合并处理失败:", error);
      });
    }, WEIXIN_INBOUND_BATCH_WINDOW_MS);
  }

  private async flushInboundBatch(conversationId: string) {
    const batch = this.inboundBatches.get(conversationId);
    if (!batch || batch.processing || batch.items.length === 0) return;
    const items = batch.items.splice(0, batch.items.length);
    batch.processing = true;

    try {
      const response = await this.processInboundBatch(conversationId, items);
      items.forEach((item, index) => item.resolve(index === 0 ? response : {}));
    } catch (error) {
      items.forEach((item, index) => {
        if (index === 0) item.resolve({ text: "这批微信消息处理失败了，请稍后重试。" });
        else item.resolve({});
      });
      logger.error("微信消息批次处理失败:", error);
    } finally {
      for (const item of items) {
        const inboundMessageKey = weixinInboundMessageKey(this.accountId, item.messageId);
        if (inboundMessageKey) this.inFlightInboundMessageIds.delete(inboundMessageKey);
      }
      batch.processing = false;
      if (batch.items.length > 0) {
        this.scheduleInboundBatch(conversationId, batch);
      } else {
        this.inboundBatches.delete(conversationId);
      }
    }
  }

  private async processInboundBatch(conversationId: string, items: WeixinBatchItem[]): Promise<{ text?: string }> {
    const first = items[0];
    const contextToken = [...items].reverse().find((item) => item.contextToken)?.contextToken;
    const userContext = await resolveOrCreateChannelUser({
      channel: "weixin-mobile",
      backend: config.acp.backend,
      externalUserId: conversationId,
      externalAccountId: this.accountId,
      conversationId,
      contextToken,
      projectBinding: this.projectBinding,
    });

    let attachments: StoredAttachment[] = [];
    for (const item of items) {
      if (!item.media) continue;
      if (!userContext.workspacePath) {
        return { text: "我收到了一份附件，但当前工作区还没准备好，暂时无法处理。请稍后再试。" };
      }
      try {
        attachments.push(await storeWeixinAttachment({
          workspacePath: userContext.workspacePath,
          media: item.media,
        }));
      } catch (error) {
        logger.warn(`微信附件保存失败: ${(error as Error).message}`);
        return { text: attachmentErrorText(error) };
      }
    }

    const userText = formatBatchedUserText(items, attachments.length);
    const idempotencyKey = weixinInboundBatchKey(this.accountId, items);
    const scope: ConversationScope = {
      userId: userContext.userId,
      projectId: userContext.projectId || "invest-agent",
      instanceId: userContext.instanceId || defaultInstanceIdForUser(userContext.userId),
      assistantId: userContext.instanceId || defaultInstanceIdForUser(userContext.userId),
    };
    if (idempotencyKey) {
      const existing = getConversationMessageByIdempotencyKey({ idempotencyKey, scope, conversationId });
      if (existing?.requestId && getAssistantMessageByRequestId({ conversationId, requestId: existing.requestId })) {
        logger.info(`微信重复入站消息已持久化 account=${this.accountId} conversation=${conversationId}`);
        return {};
      }
    }
    const userMessage = appendConversationMessage({
      scope,
      conversationId,
      channel: "weixin-mobile",
      role: "user",
      content: formatConversationUserContent(userText, attachments),
      requestId: idempotencyKey,
      idempotencyKey,
    });
    // Register WeChat uploads in the authoritative attachment table so they get
    // the same 7-day TTL and cleanup path as Portal uploads. Failures are
    // non-fatal: the bytes are already on disk and the conversation proceeds.
    for (const stored of attachments) {
      try {
        registerAttachment({
          userId: userContext.userId,
          instanceId: userContext.instanceId || defaultInstanceIdForUser(userContext.userId),
          conversationId,
          messageId: userMessage.messageId,
          stored,
        });
      } catch (error) {
        logger.warn(`微信附件索引失败 attachmentId=${stored.id}: ${(error as Error).message}`);
      }
    }
    if (userContext.instanceId) {
      await resumeAwaitingWeixinDeliveries(userContext.userId, userContext.instanceId);
    }
    let response: Awaited<ReturnType<InvestAgentMobileBridge["agent"]["handleMessage"]>>;
    try {
      response = await executeWithRetryPolicy(
        () => this.agent.handleMessage({
          id: `wx-${Date.now()}`,
          from: first.conversationId || "weixin-mobile",
          timestamp: Date.now(),
          content: { type: "text", text: userText },
          context: {
            channel: "weixin-mobile",
            conversationId,
            userId: userContext.userId,
            projectId: userContext.projectId,
            instanceId: userContext.instanceId,
            instanceExpansionPath: userContext.instanceExpansionPath,
            workspacePath: userContext.workspacePath,
            attachments,
          },
        }),
        {
          executionBudgetMs: Number(process.env.WEIXIN_EXECUTION_BUDGET_MS) || undefined,
          isRetryableResult: (candidate) => Boolean(executionResponseError(candidate)?.retryable),
        },
      );
      const responseError = executionResponseError(response);
      if (responseError) {
        const terminal = terminalTaskError(responseError);
        response = {
          content: { type: "text", text: terminal.userMessage },
          finished: true,
          data: {
            executionStatus: "failed",
            executionErrorCode: terminal.code,
            executionErrorCategory: terminal.category,
            executionRetryable: false,
          },
        };
      }
    } catch (error) {
      const classified = terminalTaskError(classifyTaskError(error));
      response = {
        content: { type: "text", text: classified.userMessage },
        finished: true,
        data: {
          executionStatus: "failed",
          executionErrorCode: classified.code,
          executionErrorCategory: classified.category,
          executionRetryable: false,
        },
      };
    }

    const chunks = await this.persistWeixinResponse({ userContext, userText, scope, conversationId, response });
    if (chunks.length > 1) {
      setTimeout(() => {
        this.pushToConversation(conversationId, chunks.slice(1), contextToken).catch((error) => {
          logger.warn(`微信后续分片发送失败: ${(error as Error).message}`);
        });
      }, 1200);
    }
    return { text: chunks[0] };
  }

  private async persistWeixinResponse(input: {
    userContext: Awaited<ReturnType<typeof resolveOrCreateChannelUser>>;
    userText: string;
    scope: ConversationScope;
    conversationId: string;
    response: Awaited<ReturnType<InvestAgentMobileBridge["agent"]["handleMessage"]>>;
  }): Promise<string[]> {
    const text = input.response.content.text ?? "处理完成，但没有生成文本回复。";
    await rememberWeixinTurn(input.userContext, input.userText, text);
    appendConversationMessage({
      scope: input.scope,
      conversationId: input.conversationId,
      channel: "weixin-mobile",
      role: "assistant",
      content: text,
      requestId: `wx-response:${input.conversationId}:${Date.now()}`,
      metadata: input.response.data?.executionStatus === "failed"
        ? { executionStatus: "failed", executionErrorCode: input.response.data.executionErrorCode, executionErrorCategory: input.response.data.executionErrorCategory }
        : { executionStatus: "succeeded" },
    });
    return splitWeixinText(text);
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
      const batch = this.inboundBatches.get(conversationId);
      if (batch?.timer) clearTimeout(batch.timer);
      this.inboundBatches.delete(conversationId);
      clearAcpSessions(conversationId);
    }
  }
}

function weixinInboundMessageKey(accountId: string, messageId?: string) {
  const normalized = messageId?.trim();
  return normalized ? `weixin-inbound:${accountId}:${normalized}` : null;
}

function weixinInboundBatchKey(accountId: string, items: WeixinBatchItem[]) {
  const messageIds = items
    .map((item) => item.messageId?.trim())
    .filter((messageId): messageId is string => Boolean(messageId));
  return messageIds.length === items.length && messageIds.length > 0
    ? `weixin-inbound:${accountId}:${messageIds.join(",")}`
    : undefined;
}

function formatBatchedUserText(items: WeixinBatchItem[], attachmentCount: number) {
  const parts = items
    .map((item) => {
      const text = item.text?.trim();
      if (text) return text;
      if (item.media?.type === "image") return "[用户发送了一张图片]";
      return item.media ? `[用户发送了一个${item.media.type}附件]` : "";
    })
    .filter(Boolean);
  if (parts.length === 0 && attachmentCount > 0) {
    return "用户发送了一张图片，请识别其中可能的持仓或观察仓信息。";
  }
  if (parts.length <= 1) return parts[0] || "用户发送了一条空消息。";
  return [
    "用户在微信里连续发送了多条消息，请按顺序合并理解为同一次表达：",
    ...parts.map((part, index) => `${index + 1}. ${part}`),
  ].join("\n");
}

function attachmentErrorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("UNSUPPORTED_ATTACHMENT_TYPE")) {
    return "我收到附件了，但当前阶段微信端只支持图片截图识别。请先发送持仓/观察仓截图。";
  }
  if (message.startsWith("UNSUPPORTED_ATTACHMENT_MIME")) {
    return "这张图片格式暂时无法识别。请重新发送截图，或换一种方式截图后再发。";
  }
  if (message.startsWith("ATTACHMENT_TOO_LARGE")) {
    return "这张图片超过当前 10MB 限制。请压缩后再发，或分多张截图发送。";
  }
  return "我收到图片了，但保存附件时失败。请稍后重试。";
}

function formatConversationUserContent(text: string, attachments: StoredAttachment[]) {
  if (attachments.length === 0) return text;
  return [
    text,
    "",
    ...attachments.map((item) => `[图片附件] ${item.fileName} (${item.mimeType}, ${Math.round(item.sizeBytes / 1024)}KB)`),
  ].join("\n");
}
