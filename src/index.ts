import { startServer } from "./server.js";
import { initDb } from "./db/index.js";
import { startScheduler, stopScheduler } from "./scheduler/index.js";
import { logger } from "./lib/logger.js";
import { disposeCodexAcp, startCodexAcp } from "./acp/codex-stdio-agent.js";
import { disposeHermesAcp, startHermesAcpIfEnabled } from "./acp/hermes-stdio-agent.js";
import { hermesWeixinMobileManager, weixinMobileManager } from "./channels/weixin-mobile.js";
import { stopPlatformWeixinListeners } from "./routes/platform.js";

async function main() {
  logger.info("正在启动投资选股智能体...");

  // 初始化数据库
  initDb();

  // 启动 HTTP 服务
  const app = await startServer();

  // 启动 Codex ACP 子进程。会话上下文后续按微信 conversationId 复用。
  await startCodexAcp();

  // Hermes 作为可选后端链路；默认关闭，不影响当前 Codex 主链路。
  await startHermesAcpIfEnabled();

  // 启动定时任务
  await startScheduler();

  logger.info("✅ 所有模块启动完成");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在停止投资选股智能体...`);
    stopScheduler();
    stopPlatformWeixinListeners();
    weixinMobileManager.stop();
    hermesWeixinMobileManager.stop();
    disposeCodexAcp();
    disposeHermesAcp();
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
