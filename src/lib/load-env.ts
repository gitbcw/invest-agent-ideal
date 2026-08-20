import { config } from "dotenv";

// 测试进程保持封闭（2026-08-20 套件挂起根因修复）：NODE_ENV=test 时不加载
// .env。真实网关、本地 MCP keep-alive 连接、SearXNG 端点等一旦泄入测试进程，
// 轻则断言漂移（provider 前缀、搜索通道），重则模型轮健康降级冷却 30 分钟、
// MCP socket 残留导致测试进程永不退出。测试需要的环境变量一律显式设置。
if (process.env.NODE_ENV !== "test") {
  config();
}
