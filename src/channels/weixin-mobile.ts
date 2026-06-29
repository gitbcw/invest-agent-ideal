import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { db, initDb } from "../db/index.js";
import { channelIdentities, channelIdentityInstances } from "../db/schema.js";
import { config } from "../lib/config.js";
import { sanitizeCustomerText } from "../lib/customer-output.js";
import { logger } from "../lib/logger.js";
import { DEFAULT_USER_ID } from "../lib/user-context.js";
import { and, desc, eq } from "drizzle-orm";
import {
  listWeixinAccountIds,
  normalizeAccountId,
  registerWeixinAccountId,
  resolveWeixinAccount,
  resolveWeixinStateDir,
  saveWeixinAccount,
} from "./weixin-account-store.js";
import { InvestAgentMobileBridge } from "./weixin-message-bridge.js";
import { fetchWeixinQRCode, isLoginFresh, pollWeixinQRStatus, type WeixinLoginSession } from "./weixin-login-flow.js";

type WeixinBackend = "hermes" | "codex";
type LoginStage = "idle" | "waiting_scan" | "scanned" | "connected" | "error";

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

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const MAX_QR_REFRESH_COUNT = 3;
const WEIXIN_MESSAGE_ITEM_TEXT = 1;
const WEIXIN_MESSAGE_TYPE_BOT = 2;
const WEIXIN_MESSAGE_STATE_FINISH = 2;
const WEIXIN_TEXT_CHUNK_LIMIT = Number(process.env.WEIXIN_TEXT_CHUNK_LIMIT) || 500;

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

export class WeixinMobileManager {
  private state: WeixinConnectState = {
    enabled: false,
    backend: config.acp.backend,
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

  private buildBridge(accountId: string) {
    return new InvestAgentMobileBridge(accountId, this.stateDir, this.projectBinding);
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

    const qr = await fetchWeixinQRCode(DEFAULT_BASE_URL, "3");
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
    const bridge = this.buildBridge(accountId);
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
    const bridge = this.buildBridge(account.accountId);
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

      logger.info(
        `微信主动推送命中 account=${account.accountId} user=${options.userId || DEFAULT_USER_ID} instance=${options.instanceId || "-"} conversation=${target.conversationId} contextToken=${target.contextToken ? "yes" : "no"} chunks=${splitWeixinText(sanitizeCustomerText(message)).length}`
      );

      const chunks = splitWeixinText(sanitizeCustomerText(message));
      await this.buildBridge(account.accountId).pushToConversation(
        target.conversationId,
        chunks,
        target.contextToken,
        account.baseUrl,
        account.token
      );
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
        const result = await pollWeixinQRStatus(DEFAULT_BASE_URL, this.loginSession.qrcode);

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

          const qr = await fetchWeixinQRCode(DEFAULT_BASE_URL, "3");
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
