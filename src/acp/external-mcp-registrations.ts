/**
 * 外部只读 MCP 注册项 (WP2)
 *
 * 把 `market-data-tool` 作为外部只读 MCP 接入 invest-agent 的注册表。
 *
 * 设计要点:
 *   - 默认关闭 (enabled: false),需显式 env 开启,保证零行为回归。
 *   - market-data-tool 与 qsse-qlib 均通过标准 HTTP MCP 接入。解析后的 URL 和
 *     Token 只进入 ACP 会话,绝不进入 manifest、trace 或日志。
 *   - activation 按注册项独立判断,不再用一个全局开关盲目启用所有外部 server。
 *     legacy `INVEST_AGENT_MCP_EXTERNAL_ENABLED` 仅作为 `market-data-tool` 的
 *     兼容别名,不会被未来的外部注册项继承。
 *   - external-readonly 安全边界由 mcp-registry 的校验护栏保证 (禁止引用 service scope env)。
 */

import type { McpServerRegistration } from "./mcp-registry.js";

/** market-data-tool 默认禁用时的注册项。开启后作为外部只读 MCP 接入 ACP 会话。 */
export function buildMarketDataToolRegistration(): McpServerRegistration {
  return {
    id: "market-data-tool",
    owner: "external",
    enabled: false,
    trustClass: "external-readonly",
    transport: {
      kind: "http",
      url: "<env:MARKET_DATA_MCP_URL>",
      headers: [{ name: "Authorization", envRef: "MARKET_DATA_MCP_TOKEN", prefix: "Bearer " }],
      requiredEnvRefs: ["MARKET_DATA_MCP_URL", "MARKET_DATA_MCP_TOKEN"],
    },
    versionPolicy: { expected: "1.29.0", allowedRange: "^1" },
    // 开放式研究 + 定时只读可用; 不含 evaluation (eval 隔离会话不接入外部 MCP)
    sessionKinds: ["interactive", "scheduled-read"],
  };
}

/** qsse-qlib 量化筛选 MCP。首版仅进入交互会话，避免占用定时任务并发。 */
export function buildQsseQlibRegistration(): McpServerRegistration {
  return {
    id: "qsse-qlib",
    owner: "external",
    enabled: false,
    trustClass: "external-readonly",
    transport: {
      kind: "http",
      url: "<env:QSSE_MCP_URL>",
      headers: [{ name: "Authorization", envRef: "QSSE_MCP_TOKEN", prefix: "Bearer " }],
      requiredEnvRefs: ["QSSE_MCP_URL", "QSSE_MCP_TOKEN"],
    },
    versionPolicy: { expected: "0.1.0", allowedRange: "^0.1" },
    sessionKinds: ["interactive"],
  };
}

/**
 * market-data-tool 的按注册项 activation 判断。
 *
 * - dedicated: INVEST_AGENT_MCP_MARKET_DATA_ENABLED === "true"
 * - legacy 兼容: INVEST_AGENT_MCP_EXTERNAL_ENABLED === "true" (仅对本 server 生效,
 *   未来的外部注册项不会继承这个全局别名)
 * 任一为真即激活。默认关闭。
 */
function isMarketDataToolActivated(env: NodeJS.ProcessEnv): boolean {
  return (
    env.INVEST_AGENT_MCP_MARKET_DATA_ENABLED === "true" ||
    env.INVEST_AGENT_MCP_EXTERNAL_ENABLED === "true"
  );
}

function isQsseQlibActivated(env: NodeJS.ProcessEnv): boolean {
  return env.INVEST_AGENT_MCP_QSSE_ENABLED === "true";
}

/**
 * 判断一个外部注册项在当前 env 下是否应被注册并启用。
 * 按 registration.id 分派;未知 id 默认关闭 (fail closed)。
 *
 * 这里的分派表是"哪个 env 开关控制哪个外部 server"的唯一来源,
 * mcp-session-manifest 与 mcp-registry 都不含 server-specific activation 逻辑。
 */
export function isExternalRegistrationActivated(
  reg: McpServerRegistration,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  switch (reg.id) {
    case "market-data-tool":
      return isMarketDataToolActivated(env);
    case "qsse-qlib":
      return isQsseQlibActivated(env);
    default:
      // 未知外部 server 默认不激活:必须先在这里登记 activation,才会被接入。
      return false;
  }
}

/** 全部外部注册项。每项仍由自己的 activation 开关决定是否实际注册。 */
export function buildExternalRegistrations(): McpServerRegistration[] {
  return [buildMarketDataToolRegistration(), buildQsseQlibRegistration()];
}
