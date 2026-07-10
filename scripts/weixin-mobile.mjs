#!/usr/bin/env node
/**
 * 微信私聊 → invest-agent 轻量桥接
 *
 * 用法：
 *   npm run weixin:mobile
 *   npm run weixin:mobile -- --login
 *
 * 说明：
 * - 通过 weixin-agent-sdk 连接微信 iLink API。
 * - 不依赖 OpenClaw 服务。
 * - 直接调用本项目 dist/acp/agent.js 中的投资 Agent。
 */

import fsSync from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function log(message) {
  console.error(`[weixin-mobile] ${message}`);
}

function resolveStateDir() {
  return path.resolve(
    process.env.INVEST_AGENT_WEIXIN_STATE_DIR?.trim() ||
      process.env.OPENCLAW_STATE_DIR?.trim() ||
      process.env.CLAWDBOT_STATE_DIR?.trim() ||
      "./.state"
  );
}

function syncWeixinSdkStateDirEnv() {
  process.env.OPENCLAW_STATE_DIR = resolveStateDir();
}

function checkExistingLogin() {
  try {
    const stateDir = resolveStateDir();
    const indexPath = path.join(stateDir, "openclaw-weixin", "accounts.json");
    if (!fsSync.existsSync(indexPath)) return null;

    const accountIds = JSON.parse(fsSync.readFileSync(indexPath, "utf-8"));
    if (!Array.isArray(accountIds) || accountIds.length === 0) return null;

    const accountId = accountIds[0];
    const accountPath = path.join(
      stateDir,
      "openclaw-weixin",
      "accounts",
      `${accountId}.json`
    );
    if (!fsSync.existsSync(accountPath)) return null;

    const accountData = JSON.parse(fsSync.readFileSync(accountPath, "utf-8"));
    return accountData.token?.trim() ? accountId : null;
  } catch {
    return null;
  }
}

async function ensureBuilt() {
  const agentPath = path.resolve("dist/acp/agent.js");
  if (!fsSync.existsSync(agentPath)) {
    throw new Error("未找到 dist/acp/agent.js，请先运行 npm run build");
  }
  return agentPath;
}

async function main() {
  syncWeixinSdkStateDirEnv();
  const { login, start } = await import("weixin-agent-sdk");
  const args = process.argv.slice(2);
  const forceLogin = args.includes("--login") || args.includes("-l");

  const existingAccount = checkExistingLogin();
  if (existingAccount && !forceLogin) {
    log(`已登录微信账号: ${existingAccount}`);
  } else {
    log("请扫码登录微信...");
    await login();
    log("微信登录成功");
  }

  const { initDb } = await import(pathToFileURL(path.resolve("dist/db/index.js")).href);
  const { InvestAgentMobileBridge } = await import(pathToFileURL(path.resolve("dist/channels/weixin-message-bridge.js")).href);
  initDb();

  const accountId = existingAccount || "weixin-mobile";
  const bridge = new InvestAgentMobileBridge(accountId, resolveStateDir());
  log("启动微信消息监听... 按 Ctrl+C 停止");
  await start(bridge, { accountId });
}

main().catch((error) => {
  console.error("[weixin-mobile] 启动失败:", error);
  process.exit(1);
});
