import fs from "node:fs";
import path from "node:path";
import { config } from "../lib/config.js";

export interface WeixinAccountRecord {
  token?: string;
  baseUrl?: string;
  userId?: string;
  lastConversationId?: string;
  lastConversationAt?: string;
  lastContextToken?: string;
}

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

export function resolveStateDir(stateDir = config.weixin.stateDir) {
  return stateDir;
}

export function resolveWeixinStateDir(stateDir = config.weixin.stateDir) {
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

export function normalizeAccountId(raw: string) {
  return raw.trim().toLowerCase().replace(/[@.]/g, "-");
}

export function registerWeixinAccountId(accountId: string, stateDir = config.weixin.stateDir) {
  const dir = resolveWeixinStateDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const ids = listWeixinAccountIds(stateDir).filter((id) => id !== accountId);
  ids.push(accountId);
  fs.writeFileSync(resolveAccountIndexPath(stateDir), JSON.stringify(ids, null, 2), "utf-8");
}

export function replaceWeixinAccount(accountId: string, update: WeixinAccountRecord, stateDir = config.weixin.stateDir): string[] {
  const normalizedId = normalizeAccountId(accountId);
  const replacedAccountIds = listWeixinAccountIds(stateDir).filter((id) => id !== normalizedId);

  saveWeixinAccount(normalizedId, update, stateDir);
  for (const id of replacedAccountIds) {
    removeWeixinAccountState(id, stateDir);
  }

  fs.writeFileSync(resolveAccountIndexPath(stateDir), JSON.stringify([normalizedId], null, 2), "utf-8");
  return replacedAccountIds;
}

function removeWeixinAccountState(accountId: string, stateDir: string) {
  const accountsDir = resolveAccountsDir(stateDir);
  if (!fs.existsSync(accountsDir)) return;
  const normalizedId = normalizeAccountId(accountId);
  for (const entry of fs.readdirSync(accountsDir)) {
    const storedId = entry
      .replace(/\.json\.sync\.json$/, "")
      .replace(/\.sync\.json$/, "")
      .replace(/\.json$/, "");
    if (normalizeAccountId(storedId) === normalizedId) {
      fs.rmSync(path.join(accountsDir, entry), { force: true });
    }
  }
}

export function listWeixinAccountIds(stateDir = config.weixin.stateDir): string[] {
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

export function loadWeixinAccount(accountId: string, stateDir = config.weixin.stateDir): WeixinAccountRecord | null {
  try {
    const filePath = resolveAccountPath(accountId, stateDir);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WeixinAccountRecord;
  } catch {
    return null;
  }
}

export function saveWeixinAccount(accountId: string, update: WeixinAccountRecord, stateDir = config.weixin.stateDir) {
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

export function resolveWeixinAccount(accountId?: string, stateDir = config.weixin.stateDir) {
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
    lastConversationId: account?.lastConversationId,
    lastConversationAt: account?.lastConversationAt,
    lastContextToken: account?.lastContextToken,
  };
}
