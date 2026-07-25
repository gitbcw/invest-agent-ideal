import { startServer } from "./server.js";
import { initDb } from "./db/index.js";
import { startScheduler, stopScheduler } from "./scheduler/index.js";
import { startFileRetentionScheduler, stopFileRetentionScheduler } from "./scheduler/file-retention.js";
import { logger } from "./lib/logger.js";
import { disposeAllAcp, startDefaultAcp } from "./acp/stdio-agent.js";
import { weixinMobileManager } from "./channels/weixin-mobile.js";
import { stopPlatformWeixinListeners } from "./routes/platform.js";
import { registerDataQualityAlertSink } from "./handlers/data-quality-report.js";
import { startPortalConnector } from "./portal/connector.js";
import { startAttachmentRetentionCleanup, stopAttachmentRetentionCleanup } from "./services/attachment-retention.js";

const ACP_START_RETRY_MS = 30_000;

function startDefaultAcpInBackground(attempt = 1): void {
  void startDefaultAcp()
    .then(() => logger.info("ACP 启动就绪"))
    .catch((error) => {
      logger.error(`ACP 启动失败（第 ${attempt} 次），将在 ${ACP_START_RETRY_MS / 1000}s 后重试: ${(error as Error).message}`);
      setTimeout(() => startDefaultAcpInBackground(attempt + 1), ACP_START_RETRY_MS).unref();
    });
}

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
    // Runtime services stay available while the ACP executable/login recovers.
    await startScheduler();
    startAttachmentRetentionCleanup();
    startFileRetentionScheduler();
    startDefaultAcpInBackground();
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
    stopAttachmentRetentionCleanup();
    stopFileRetentionScheduler();
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
