import { startServer } from "./server.js";
import { initDb } from "./db/index.js";
import { startScheduler, stopScheduler } from "./scheduler/index.js";
import { startFileRetentionScheduler, stopFileRetentionScheduler } from "./scheduler/file-retention.js";
import { logger } from "./lib/logger.js";
import { weixinMobileManager } from "./channels/weixin-mobile.js";
import { stopPlatformWeixinListeners } from "./routes/platform.js";
import { registerDataQualityAlertSink } from "./handlers/data-quality-report.js";
import { applyMcpServerOverridesOnStartup } from "./services/mcp-control-plane.js";
import { startPortalConnector } from "./portal/connector.js";
import { startAttachmentRetentionCleanup, stopAttachmentRetentionCleanup } from "./services/attachment-retention.js";
import { reconcileInterruptedConversationTurnsOnStartup } from "./services/conversation-log.js";

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
  const interruptedTurns = reconcileInterruptedConversationTurnsOnStartup();
  if (interruptedTurns > 0) {
    logger.warn(`已收敛上次进程遗留的对话回合: ${interruptedTurns}`);
  }

  // 应用 MCP server 运行时启停覆盖到 registry (T-243 Phase 2)。
  // 在 HTTP 服务启动前应用:DB 覆盖优先级高于 env 基线,启动时固化一次。
  applyMcpServerOverridesOnStartup();

  // 注册数据质量告警 sink(给 services/source-telemetry.ts 用,避免循环依赖)
  registerDataQualityAlertSink();

  // 启动 HTTP 服务
  const app = await startServer();

  if (!offlineMode) {
    // Runtime services start independently of any external agent executable.
    await startScheduler();
    startAttachmentRetentionCleanup();
    startFileRetentionScheduler();
  } else {
    logger.info("OFFLINE 模式:跳过 scheduler 启动。");
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
