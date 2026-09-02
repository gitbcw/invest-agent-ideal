import { startServer } from "./server.js";
import { initDb } from "./db/index.js";
import { startScheduler, stopScheduler } from "./scheduler/index.js";
import { activeMastraTurnCount } from "./mastra/run-turn.js";
import { activeGenericAutomationRunCount } from "./services/generic-automation-runner.js";
import { activeTypedAutomationRunCount } from "./services/automation-runner.js";
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
  // The local Mastra candidate can exercise the Portal protocol without
  // enabling WeChat, scheduler, or push. This flag is intentionally opt-in.
  const allowPortalConnectorInOfflineMode = process.env.INVEST_AGENT_PORTAL_CONNECTOR_IN_OFFLINE_MODE === "true";
  if (offlineMode) {
    process.env.WEIXIN_AUTO_START = "false";
    if (!allowPortalConnectorInOfflineMode) process.env.PORTAL_CONNECTOR_AUTO_START = "false";
    process.env.PLATFORM_WEIXIN_AUTO_START = "false";
    logger.info(
      allowPortalConnectorInOfflineMode
        ? "INVEST_AGENT_OFFLINE_MODE=true:已禁用微信恢复、Platform 微信 listener、scheduler 和 push queue worker；仅允许显式配置的本地 Portal connector。"
        : "INVEST_AGENT_OFFLINE_MODE=true:已禁用微信恢复、Portal connector、Platform 微信 listener、scheduler 和 push queue worker,仅保留 HTTP 服务与本地路由。"
    );
  }

  // 信号处理必须先于 main() 内的第一个 await 注册：注册前进程对 SIGINT 无
  // 防护，pm2 restart 类操作落在启动窗口会让进程以 130 裸退（2026-09-01
  // 生产复发）。启动早期收到信号时还没有任何在途工作，直接退出。
  let app: Awaited<ReturnType<typeof startServer>> | null = null;
  let portalConnector: ReturnType<typeof startPortalConnector> | null = null;
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在停止投资选股智能体...`);
    if (!app) {
      process.exit(0);
    }
    if (!offlineMode) stopScheduler();
    // W5 优雅排空：等待在途 Agent 轮次与 automation run 完成（上限 240s），
    // 避免发布重启打断用户请求与自动化提交。automation run 的 commit/deliver
    // 阶段轮次计数已归零但 run 仍在途（2026-09-01 dyk 月复盘正是在该阶段被
    // 孤儿化），所以按 run 整段计数。
    if (!offlineMode) {
      const drainDeadline = Date.now() + 240_000;
      const inFlight = () => activeMastraTurnCount() + activeGenericAutomationRunCount() + activeTypedAutomationRunCount();
      while (inFlight() > 0 && Date.now() < drainDeadline) {
        logger.info(`优雅排空中：${inFlight()} 个在途（会话轮次+自动化运行）...`);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      if (inFlight() > 0) logger.warn(`排空超时，仍有 ${inFlight()} 个在途，强制退出`);
    }
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
  app = await startServer();

  if (!offlineMode) {
    // Runtime services start independently of any external agent executable.
    await startScheduler();
    startAttachmentRetentionCleanup();
    startFileRetentionScheduler();
  } else {
    logger.info("OFFLINE 模式:跳过 scheduler 启动。");
  }

  portalConnector = (offlineMode && !allowPortalConnectorInOfflineMode) || process.env.PORTAL_CONNECTOR_AUTO_START === "false"
    ? null
    : startPortalConnector();

  logger.info("✅ 所有模块启动完成");
}

main().catch((error) => {
  logger.error("启动异常:", error);
  process.exit(1);
});
