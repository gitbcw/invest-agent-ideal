import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { createAgent } from "../acp/agent.js";
import { clearAcpSessions } from "../acp/stdio-agent.js";
import { db, initDb } from "../db/index.js";
import { channelIdentities, channelIdentityInstances } from "../db/schema.js";
import { config } from "../lib/config.js";
import { sanitizeCustomerText } from "../lib/customer-output.js";
import { logger } from "../lib/logger.js";
import { resolveOrCreateChannelUser } from "../lib/user-identity.js";
import { DEFAULT_USER_ID } from "../lib/user-context.js";
import { and, desc, eq } from "drizzle-orm";
import { rememberWeixinTurn } from "../lib/weixin-conversation-memory.js";

type WeixinBackend = "hermes";

type LoginStage = "idle" | "waiting_scan" | "scanned" | "connected" | "error";

interface WeixinLoginSession {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  refreshCount: number;
}

interface WeixinConnectState {
  enabled: boolean;
  backend: WeixinBackend;
  stage: LoginStage;
  stateDir: string;
  accountId?: string;
  message: string;
  qrcodeUrl?: string;
  qrcodeDataUrl?: string;
  sessionKey?: string;
  updatedAt: string;
  listenerRunning: boolean;
  lastError?: string;
  lastConversationId?: string;
  lastConversationAt?: string;
  pushReady?: boolean;
  accounts?: Array<{
    accountId: string;
    listenerRunning: boolean;
    lastConversationId?: string;
    lastConversationAt?: string;
    pushReady?: boolean;
  }>;
}

interface WeixinAccountRecord {
  token?: string;
  baseUrl?: string;
  userId?: string;
  lastConversationId?: string;
  lastConversationAt?: string;
  lastContextToken?: string;
}

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const MAX_QR_REFRESH_COUNT = 3;
const ACTIVE_LOGIN_TTL_MS = 5 * 60 * 1000;
const QR_LONG_POLL_TIMEOUT_MS = 35 * 1000;
const WEIXIN_MESSAGE_ITEM_TEXT = 1;
const WEIXIN_MESSAGE_TYPE_BOT = 2;
const WEIXIN_MESSAGE_STATE_FINISH = 2;
const WEIXIN_TEXT_CHUNK_LIMIT = Number(process.env.WEIXIN_TEXT_CHUNK_LIMIT) || 500;

interface WeixinProjectBinding {
  projectId: string;
  instanceId: string;
  ownerUserId?: string;
  ownerDisplayName?: string;
  sharedUsers?: boolean;
}

let weixinSdkPromise: Promise<{
  start: (
    agent: { chat(request: { conversationId: string; text: string; media?: { type: string } }): Promise<{ text?: string }>; clearSession?: (conversationId: string) => void },
    opts?: { accountId?: string; abortSignal?: AbortSignal; log?: (msg: string) => void }
  ) => Promise<void>;
}> | null = null;

function syncWeixinSdkStateDirEnv(stateDir = config.weixin.stateDir) {
  process.env.OPENCLAW_STATE_DIR = stateDir;
}

function loadWeixinSdk(stateDir = config.weixin.stateDir) {
  syncWeixinSdkStateDirEnv(stateDir);
  if (!weixinSdkPromise) {
    weixinSdkPromise = import("weixin-agent-sdk");
  }
  return weixinSdkPromise;
}

function resolveStateDir(stateDir = config.weixin.stateDir) {
  return stateDir;
}

function resolveWeixinStateDir(stateDir = config.weixin.stateDir) {
  return path.join(resolveStateDir(stateDir), "openclaw-weixin");
}

function resolveAccountIndexPath(stateDir = config.weixin.stateDir) {
  return path.join(resolveWeixinStateDir(stateDir), "accounts.json");
}

function resolveAccountsDir(stateDir = config.weixin.stateDir) {
  return path.join(resolveWeixinStateDir(stateDir), "accounts");
}

function resolveAccountPath(accountId: string, stateDir = config.weixin.stateDir) {
  return path.join(resolveAccountsDir(stateDir), `${accountId}.json`);
}

function normalizeAccountId(raw: string) {
  return raw.trim().toLowerCase().replace(/[@.]/g, "-");
}

function registerWeixinAccountId(accountId: string, stateDir = config.weixin.stateDir) {
  const dir = resolveWeixinStateDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const ids = listWeixinAccountIds(stateDir).filter((id) => id !== accountId);
  ids.push(accountId);
  fs.writeFileSync(resolveAccountIndexPath(stateDir), JSON.stringify(ids, null, 2), "utf-8");
}

function listWeixinAccountIds(stateDir = config.weixin.stateDir): string[] {
  const ids: string[] = [];
  try {
    const filePath = resolveAccountIndexPath(stateDir);
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (Array.isArray(parsed)) {
        ids.push(...parsed.filter((id) => typeof id === "string"));
      }
    }
  } catch {
    // Fall through to account file discovery below.
  }
  try {
    const dir = resolveAccountsDir(stateDir);
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.endsWith(".json") && !entry.endsWith(".sync.json")) {
          ids.push(entry.slice(0, -".json".length));
        }
      }
    }
  } catch {
    // Ignore corrupt state directories; callers handle an empty account list.
  }
  return Array.from(new Set(ids.map((id) => normalizeAccountId(id)).filter(Boolean)));
}

function loadWeixinAccount(accountId: string, stateDir = config.weixin.stateDir): WeixinAccountRecord | null {
  try {
    const filePath = resolveAccountPath(accountId, stateDir);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WeixinAccountRecord;
  } catch {
    return null;
  }
}

function saveWeixinAccount(accountId: string, update: WeixinAccountRecord, stateDir = config.weixin.stateDir) {
  fs.mkdirSync(resolveAccountsDir(stateDir), { recursive: true });
  const existing = loadWeixinAccount(accountId, stateDir) ?? {};
  const next = {
    token: update.token?.trim() || existing.token,
    baseUrl: update.baseUrl?.trim() || existing.baseUrl || DEFAULT_BASE_URL,
    userId: update.userId?.trim() || existing.userId,
    lastConversationId: update.lastConversationId?.trim() || existing.lastConversationId,
    lastConversationAt: update.lastConversationAt?.trim() || existing.lastConversationAt,
    lastContextToken: update.lastContextToken?.trim() || existing.lastContextToken,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(resolveAccountPath(accountId, stateDir), JSON.stringify(next, null, 2), "utf-8");
}

function resolveWeixinAccount(accountId?: string, stateDir = config.weixin.stateDir) {
  const ids = listWeixinAccountIds(stateDir);
  const resolvedId = normalizeAccountId(accountId || ids[0] || "");
  if (!resolvedId) {
    return {
      accountId: "",
      configured: false,
      token: undefined,
      baseUrl: DEFAULT_BASE_URL,
    };
  }

  const account = loadWeixinAccount(resolvedId, stateDir);
  return {
    accountId: resolvedId,
    configured: Boolean(account?.token),
    token: account?.token,
    baseUrl: account?.baseUrl || DEFAULT_BASE_URL,
    lastConversationId: account?.lastConversationId || account?.userId,
    lastConversationAt: account?.lastConversationAt,
    lastContextToken: account?.lastContextToken,
  };
}

async function resolvePushConversation(params: {
  accountId: string;
  backend: WeixinBackend;
  userId?: string;
  instanceId?: string;
  fallbackConversationId?: string;
  fallbackContextToken?: string;
}) {
  const userId = params.userId?.trim() || DEFAULT_USER_ID;
  const instanceId = params.instanceId?.trim();
  if (instanceId) {
    const rows = await db
      .select({
        externalAccountId: channelIdentities.externalAccountId,
        lastConversationId: channelIdentities.lastConversationId,
        lastContextToken: channelIdentities.lastContextToken,
      })
      .from(channelIdentityInstances)
      .innerJoin(channelIdentities, eq(channelIdentityInstances.channelIdentityId, channelIdentities.id))
      .where(and(
        eq(channelIdentityInstances.instanceId, instanceId),
        eq(channelIdentities.userId, userId),
        eq(channelIdentities.channel, "weixin-mobile"),
        eq(channelIdentities.backend, params.backend),
      ))
      .orderBy(desc(channelIdentities.updatedAt))
      .limit(1);

    const identity = rows[0];
    if (identity?.lastConversationId) {
      if (identity.externalAccountId && identity.externalAccountId !== params.accountId) {
        logger.warn(`微信主动推送跳过：实例 ${instanceId} 绑定账号 ${identity.externalAccountId}，当前账号 ${params.accountId}`);
        return { conversationId: undefined, contextToken: undefined };
      }
      return {
        conversationId: identity.lastConversationId,
        contextToken: identity.lastContextToken ?? undefined,
      };
    }
  }
  if (userId === DEFAULT_USER_ID) {
    return {
      conversationId: params.fallbackConversationId,
      contextToken: params.fallbackContextToken,
    };
  }

  const rows = await db
    .select({
      externalAccountId: channelIdentities.externalAccountId,
      lastConversationId: channelIdentities.lastConversationId,
      lastContextToken: channelIdentities.lastContextToken,
    })
    .from(channelIdentities)
    .where(and(
      eq(channelIdentities.userId, userId),
      eq(channelIdentities.channel, "weixin-mobile"),
      eq(channelIdentities.backend, params.backend),
    ))
    .orderBy(desc(channelIdentities.updatedAt))
    .limit(1);

  const identity = rows[0];
  if (!identity?.lastConversationId) {
    return { conversationId: undefined, contextToken: undefined };
  }
  if (identity.externalAccountId && identity.externalAccountId !== params.accountId) {
    logger.warn(`微信主动推送跳过：用户 ${userId} 绑定账号 ${identity.externalAccountId}，当前账号 ${params.accountId}`);
    return { conversationId: undefined, contextToken: undefined };
  }
  return {
    conversationId: identity.lastConversationId,
    contextToken: identity.lastContextToken ?? undefined,
  };
}

function isLoginFresh(session: WeixinLoginSession) {
  return Date.now() - session.startedAt < ACTIVE_LOGIN_TTL_MS;
}

async function fetchQRCode(apiBaseUrl: string, botType = "3") {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    base
  );
  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`获取微信二维码失败: ${response.status} ${body}`);
  }
  return (await response.json()) as {
    qrcode: string;
    qrcode_img_content: string;
  };
}

async function pollQRStatus(apiBaseUrl: string, qrcode: string) {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    base
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`轮询二维码状态失败: ${response.status} ${body}`);
    }
    return (await response.json()) as {
      status: string;
      bot_token?: string;
      ilink_bot_id?: string;
      baseurl?: string;
      ilink_user_id?: string;
    };
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  }
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

async function sendWeixinTextMessage(params: {
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

class InvestAgentMobileBridge {
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
      backend: "hermes",
      externalUserId: conversationId,
      externalAccountId: this.accountId,
      conversationId,
      contextToken: request.contextToken,
      projectBinding: this.projectBinding,
    });

    if (request.conversationId) {
      saveWeixinAccount(
        this.accountId,
        {
          lastConversationId: request.conversationId,
          lastConversationAt: new Date().toISOString(),
          lastContextToken: request.contextToken,
        },
        this.stateDir
      );
    }

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
        projectType: userContext.projectType,
        skillBundleId: userContext.skillBundleId,
        strategySkillId: userContext.strategySkillId,
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

  private async pushToConversation(conversationId: string, text: string | string[], contextToken?: string) {
    const account = resolveWeixinAccount(this.accountId, this.stateDir);
    if (!account.configured || !account.token) {
      throw new Error(`账号 ${this.accountId} 未配置 token，无法推送后台复盘结果`);
    }
    const chunks = Array.isArray(text) ? text : splitWeixinText(text);
    for (const chunk of chunks) {
      await sendWeixinTextMessage({
        baseUrl: account.baseUrl,
        token: account.token,
        to: conversationId,
        text: chunk,
        contextToken: contextToken || account.lastContextToken,
      });
    }
  }

  clearSession(conversationId?: string): void {
    if (conversationId) {
      clearAcpSessions(conversationId);
    }
  }
}

export class WeixinMobileManager {
  private state: WeixinConnectState = {
    enabled: false,
    backend: "hermes",
    stage: "idle",
    stateDir: resolveWeixinStateDir(),
    message: "未连接微信",
    updatedAt: new Date().toISOString(),
    listenerRunning: false,
  };

  private loginSession: WeixinLoginSession | null = null;
  private listenerAbortControllers = new Map<string, AbortController>();
  private loginPollTask: Promise<void> | null = null;
  private readonly backend: WeixinBackend;
  private readonly stateDir: string;
  private readonly label: string;
  private readonly projectBinding?: {
    projectId: string;
    instanceId: string;
    sharedUsers?: boolean;
  };

  constructor(
    private readonly options: {
      backend?: WeixinBackend;
      stateDir?: string;
      label?: string;
      projectBinding?: {
        projectId: string;
        instanceId: string;
        ownerUserId?: string;
        ownerDisplayName?: string;
        sharedUsers?: boolean;
      };
    } = {}
  ) {
    this.backend = this.options.backend ?? "hermes";
    this.stateDir = this.options.stateDir ?? config.weixin.stateDir;
    this.label = this.options.label ?? "微信";
    this.projectBinding = this.options.projectBinding;
    this.state.backend = this.backend;
    this.state.stateDir = resolveWeixinStateDir(this.stateDir);
    this.state.message = `未连接${this.label}`;

    const accounts = this.accountSummaries();
    const account = accounts[accounts.length - 1];
    if (account) {
      this.state = {
        enabled: true,
        backend: this.backend,
        stage: "connected",
        stateDir: resolveWeixinStateDir(this.stateDir),
        accountId: account.accountId,
        message: `已连接${this.label}账号 ${accounts.length} 个`,
        updatedAt: new Date().toISOString(),
        listenerRunning: accounts.some((item) => item.listenerRunning),
        lastConversationId: account.lastConversationId,
        lastConversationAt: account.lastConversationAt,
        pushReady: accounts.some((item) => item.pushReady),
        accounts,
      };
    }
  }

  getState(): WeixinConnectState {
    return { ...this.state, ...this.accountStatePatch() };
  }

  async startLogin(force = false): Promise<WeixinConnectState> {
    if (!force && this.state.stage === "waiting_scan" && this.loginSession && isLoginFresh(this.loginSession)) {
      return this.withState({
        qrcodeUrl: this.loginSession.qrcodeUrl,
        sessionKey: this.loginSession.sessionKey,
        message: "二维码已生成，请扫码。",
      });
    }

    const qr = await fetchQRCode(DEFAULT_BASE_URL, "3");
    this.loginSession = {
      sessionKey: randomUUID(),
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcode_img_content,
      startedAt: Date.now(),
      refreshCount: 1,
    };

    const qrcodeDataUrl = await QRCode.toDataURL(qr.qrcode_img_content, {
      width: 260,
      margin: 1,
      errorCorrectionLevel: "M",
    });

    this.withState({
      enabled: this.accountSummaries().length > 0,
      stage: "waiting_scan",
      qrcodeUrl: qr.qrcode_img_content,
      qrcodeDataUrl,
      sessionKey: this.loginSession.sessionKey,
      message: `请使用微信扫码连接${this.label}。`,
      lastError: undefined,
    });

    this.ensurePolling();
    return this.getState();
  }

  stop() {
    const stoppedCount = this.listenerAbortControllers.size;
    for (const controller of this.listenerAbortControllers.values()) {
      controller.abort();
    }
    this.listenerAbortControllers.clear();
    this.loginSession = null;
    this.loginPollTask = null;
    this.withState({
      enabled: this.accountSummaries().length > 0,
      stage: this.accountSummaries().length > 0 ? "connected" : "idle",
      qrcodeUrl: undefined,
      qrcodeDataUrl: undefined,
      sessionKey: undefined,
      message: stoppedCount > 0 ? `已停止${this.label}监听 ${stoppedCount} 个账号` : `当前没有运行中的${this.label}监听`,
      listenerRunning: false,
    });
  }

  async ensureListenerStarted(accountId?: string) {
    syncWeixinSdkStateDirEnv(this.stateDir);
    const accountIds = accountId ? [normalizeAccountId(accountId)] : listWeixinAccountIds(this.stateDir);
    if (accountIds.length === 0) {
      throw new Error("当前没有已连接的微信账号");
    }

    const started: string[] = [];
    for (const id of accountIds) {
      if (await this.startAccountListener(id)) {
        started.push(id);
      }
    }

    const accounts = this.accountSummaries();
    this.withState({
      enabled: accounts.length > 0,
      stage: accounts.length > 0 ? "connected" : this.state.stage,
      accountId: started[started.length - 1] || this.state.accountId || accounts[accounts.length - 1]?.accountId,
      listenerRunning: this.listenerAbortControllers.size > 0,
      message: started.length > 0
        ? `${this.label}消息监听中：${started.length} 个账号`
        : `${this.label}已无新增账号需要启动监听`,
    });
  }

  async simulateIncomingText(input: {
    text: string;
    conversationId: string;
    accountId?: string;
    contextToken?: string;
  }): Promise<{ text?: string; accountId: string; conversationId: string }> {
    const accountId = normalizeAccountId(input.accountId || this.state.accountId || `${this.backend}-simulator`);
    const bridge = new InvestAgentMobileBridge(accountId, this.stateDir, this.projectBinding);
    const response = await bridge.chat({
      conversationId: input.conversationId,
      text: input.text,
      contextToken: input.contextToken,
    });
    return {
      ...response,
      accountId,
      conversationId: input.conversationId,
    };
  }

  private async startAccountListener(accountId: string): Promise<boolean> {
    const account = resolveWeixinAccount(accountId, this.stateDir);
    if (!account.configured || !account.accountId) {
      logger.warn(`${this.label}监听跳过：账号 ${accountId} 未配置 token`);
      return false;
    }
    if (this.listenerAbortControllers.has(account.accountId)) {
      return false;
    }

    const { start } = await loadWeixinSdk(this.stateDir);
    initDb();
    const bridge = new InvestAgentMobileBridge(account.accountId, this.stateDir, this.projectBinding);
    const abortController = new AbortController();
    this.listenerAbortControllers.set(account.accountId, abortController);

    start(bridge, {
      accountId: account.accountId,
      abortSignal: abortController.signal,
      log: (msg) => logger.info(`[weixin-mobile:${this.backend}:${account.accountId}] ${msg}`),
    }).catch((error) => {
      this.listenerAbortControllers.delete(account.accountId);
      this.withState({
        stage: "error",
        listenerRunning: this.listenerAbortControllers.size > 0,
        message: `${this.label}账号 ${account.accountId} 消息监听异常退出`,
        lastError: (error as Error).message,
      });
      logger.error(`${this.label}账号 ${account.accountId} 消息监听失败:`, error);
    });
    return true;
  }

  async pushText(message: string, options: { userId?: string; instanceId?: string } = {}): Promise<boolean> {
    const accounts = listWeixinAccountIds(this.stateDir)
      .map((accountId) => resolveWeixinAccount(accountId, this.stateDir))
      .filter((account) => account.configured && account.accountId && account.token);
    if (accounts.length === 0) {
      logger.warn("微信主动推送跳过：当前没有已连接账号");
      return false;
    }

    for (const account of accounts.slice().reverse()) {
      const target = await resolvePushConversation({
        accountId: account.accountId,
        backend: this.backend,
        userId: options.userId,
        instanceId: options.instanceId,
        fallbackConversationId: account.lastConversationId,
        fallbackContextToken: account.lastContextToken,
      });
      if (!target.conversationId || !account.token) {
        continue;
      }

      const chunks = splitWeixinText(sanitizeCustomerText(message));
      for (const chunk of chunks) {
        await sendWeixinTextMessage({
          baseUrl: account.baseUrl,
          token: account.token,
          to: target.conversationId,
          text: chunk,
          contextToken: target.contextToken,
        });
      }
      this.withState({
        accountId: account.accountId,
        lastConversationId: target.conversationId,
        lastConversationAt: account.lastConversationAt,
        pushReady: true,
        lastError: undefined,
      });
      return true;
    }

    const latest = accounts[accounts.length - 1];
    if (!latest) {
      return false;
    }
    {
      logger.warn(`微信主动推送跳过：用户 ${options.userId || DEFAULT_USER_ID} 尚无最近会话，请先让该用户给助手发送一条消息`);
      this.withState({
        accountId: latest.accountId,
        lastConversationId: latest.lastConversationId,
        lastConversationAt: latest.lastConversationAt,
        pushReady: false,
        lastError: "尚无最近会话，无法主动推送",
      });
      return false;
    }
  }

  private ensurePolling() {
    if (this.loginPollTask) return;
    this.loginPollTask = this.pollUntilConnected().finally(() => {
      this.loginPollTask = null;
    });
  }

  private async pollUntilConnected() {
    while (this.loginSession && isLoginFresh(this.loginSession)) {
      try {
        const result = await pollQRStatus(DEFAULT_BASE_URL, this.loginSession.qrcode);

        if (result.status === "scaned") {
          this.withState({
            stage: "scanned",
            message: "已扫码，请在微信中确认登录。",
          });
          continue;
        }

        if (result.status === "wait") {
          continue;
        }

        if (result.status === "expired") {
          if (!this.loginSession) return;
          this.loginSession.refreshCount += 1;
          if (this.loginSession.refreshCount > MAX_QR_REFRESH_COUNT) {
            this.withState({
              stage: "error",
              message: "二维码已多次过期，请重新生成。",
              lastError: "二维码过期",
            });
            this.loginSession = null;
            return;
          }

          const qr = await fetchQRCode(DEFAULT_BASE_URL, "3");
          this.loginSession.qrcode = qr.qrcode;
          this.loginSession.qrcodeUrl = qr.qrcode_img_content;
          this.loginSession.startedAt = Date.now();
          const qrcodeDataUrl = await QRCode.toDataURL(qr.qrcode_img_content, {
            width: 260,
            margin: 1,
            errorCorrectionLevel: "M",
          });
          this.withState({
            stage: "waiting_scan",
            qrcodeUrl: qr.qrcode_img_content,
            qrcodeDataUrl,
            message: `二维码已刷新（${this.loginSession.refreshCount}/${MAX_QR_REFRESH_COUNT}）`,
          });
          continue;
        }

        if (result.status === "confirmed") {
          if (!result.bot_token || !result.ilink_bot_id) {
            throw new Error("扫码已确认，但没有拿到 bot token 或账号 ID");
          }

          const accountId = normalizeAccountId(result.ilink_bot_id);
          saveWeixinAccount(
            accountId,
            {
              token: result.bot_token,
              baseUrl: result.baseurl || DEFAULT_BASE_URL,
              userId: result.ilink_user_id,
            },
            this.stateDir
          );
          registerWeixinAccountId(accountId, this.stateDir);

          this.loginSession = null;
          this.withState({
            enabled: true,
            stage: "connected",
            accountId,
            qrcodeUrl: undefined,
            qrcodeDataUrl: undefined,
            sessionKey: undefined,
            message: `${this.label}连接成功：${accountId}`,
            lastError: undefined,
          });
          await this.ensureListenerStarted(accountId);
          return;
        }
      } catch (error) {
        this.withState({
          stage: "error",
          message: "微信连接过程中出现异常",
          lastError: (error as Error).message,
        });
        logger.error("微信登录轮询失败:", error);
        return;
      }
    }

    if (this.loginSession && !isLoginFresh(this.loginSession)) {
      this.withState({
        stage: "error",
        message: "二维码已过期，请重新生成。",
        lastError: "二维码过期",
      });
      this.loginSession = null;
    }
  }

  private withState(patch: Partial<WeixinConnectState>) {
    const next = {
      ...this.state,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.state = {
      ...next,
      ...this.accountStatePatch(next),
    };
    return this.state;
  }

  private accountSummaries(): NonNullable<WeixinConnectState["accounts"]> {
    const summaries: NonNullable<WeixinConnectState["accounts"]> = [];
    for (const accountId of listWeixinAccountIds(this.stateDir)) {
      const account = resolveWeixinAccount(accountId, this.stateDir);
      if (!account.configured || !account.accountId) continue;
      summaries.push({
        accountId: account.accountId,
        listenerRunning: this.listenerAbortControllers.has(account.accountId),
        lastConversationId: account.lastConversationId,
        lastConversationAt: account.lastConversationAt,
        pushReady: Boolean(account.lastConversationId),
      });
    }
    return summaries;
  }

  private accountStatePatch(base: WeixinConnectState = this.state): Partial<WeixinConnectState> {
    const accounts = this.accountSummaries();
    const preferred =
      accounts.find((account) => account.accountId === base.accountId) ||
      accounts[accounts.length - 1];
    return {
      accounts,
      enabled: accounts.length > 0 || base.enabled,
      accountId: preferred?.accountId || base.accountId,
      listenerRunning: accounts.some((account) => account.listenerRunning),
      lastConversationId: base.lastConversationId || preferred?.lastConversationId,
      lastConversationAt: base.lastConversationAt || preferred?.lastConversationAt,
      pushReady: accounts.some((account) => account.pushReady) || Boolean(base.pushReady),
    };
  }
}

export const weixinMobileManager = new WeixinMobileManager();
