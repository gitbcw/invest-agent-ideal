import { startServer } from "./server.js";
import { initDb } from "./db/index.js";
import { startScheduler, stopScheduler } from "./scheduler/index.js";
import { logger } from "./lib/logger.js";
import { disposeAllAcp, startDefaultAcp } from "./acp/stdio-agent.js";
import { weixinMobileManager } from "./channels/weixin-mobile.js";
import { stopPlatformWeixinListeners } from "./routes/platform.js";
import { registerDataQualityAlertSink } from "./handlers/data-quality-report.js";
import { startPortalConnector } from "./portal/connector.js";

async function main() {
  logger.info("正在启动投资选股智能体...");

  const offlineMode = process.env.INVEST_AGENT_OFFLINE_MODE === "true";
  if (offlineMode) {
    process.env.WEIXIN_AUTO_START = "false";
    process.env.PORTAL_CONNECTOR_AUTO_START = "false";
    process.env.PLATFORM_WEIXIN_AUTO_START = "false";
    logger.info("INVEST_AGENT_OFFLINE_MODE=true:已禁用微信恢复、Portal connector、Platform 微信 listener、scheduler 和 push queue worker,仅保留 HTTP 服务与本地路由。");
  }

  // 初始化数据库
  initDb();

  // 注册数据质量告警 sink(给 services/market-data-providers.ts 用,避免循环依赖)
  registerDataQualityAlertSink();

  // 启动 HTTP 服务
  const app = await startServer();

  if (!offlineMode) {
    // 启动当前 ACP backend 子进程。会话上下文后续按微信 conversationId 复用。
    await startDefaultAcp();

    // 启动定时任务
    await startScheduler();
  } else {
    logger.info("OFFLINE 模式:跳过 ACP 子进程和 scheduler 启动。");
  }

  const portalConnector = offlineMode || process.env.PORTAL_CONNECTOR_AUTO_START === "false"
    ? null
    : startPortalConnector();

  logger.info("✅ 所有模块启动完成");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在停止投资选股智能体...`);
    if (!offlineMode) stopScheduler();
    stopPlatformWeixinListeners();
    portalConnector?.stop();
    weixinMobileManager.stop();
    disposeAllAcp();
    await app.close();
    logger.info("✅ 投资选股智能体已停止");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error("启动异常:", error);
  process.exit(1);
});
