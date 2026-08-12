/**
 * 外部只读 MCP 注册项 (WP2 / T-243 声明式激活改造)
 *
 * 把 `market-data-tool` 与 `qsse-qlib` 作为外部只读 MCP 接入 invest-agent。
 *
 * 设计要点:
 *   - 默认关闭 (enabled: false),需显式 env 开启,保证零行为回归。
 *   - market-data-tool 与 qsse-qlib 均通过标准 HTTP MCP 接入。解析后的 URL 和
 *     Token 只进入 ACP 会话,绝不进入 manifest、trace 或日志。
 *   - activation 自 T-243 起改为声明式:每个注册项自带 activateIf 规则,
 *     由 evaluateActivation 求值。本文件不再持有 server-specific 的激活分派表
 *     (原先的 switch-case 已删除) —— 新增外部 server 只需在 builder 声明 activateIf。
 *   - legacy `INVEST_AGENT_MCP_EXTERNAL_ENABLED` 仅作为 `market-data-tool` 的
 *     兼容别名,通过声明的 refs 列表生效,不会被未来的外部注册项继承。
 *   - external-readonly 安全边界由 mcp-registry 的校验护栏保证 (禁止引用 service scope env)。
 */

import type { McpServerRegistration, McpActivationRule } from "./mcp-registry.js";

/**
 * 按声明式 activateIf 规则求值一个外部注册项是否应被激活。
 * 未声明规则的 (含 service-scoped) 一律返回 false —— 由各自默认 enabled 控制。
 * 这是 isExternalRegistrationActivated 的无副作用内核,便于单测。
 *
 * 放在本模块而非 mcp-registry:激活规则属于"外部 server"概念,且 mcp-registry
 * 在 registerExternalMcpServers 里反向调用本模块,这里持有内核避免循环依赖。
 */
export function evaluateActivation(
  rule: McpActivationRule | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!rule) return false;
  if (rule.kind === "env-any-of") {
    return rule.refs.some((ref) => env[ref] === "true");
  }
  return false;
}

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
    // 声明式激活 (T-243): dedicated 开关 + legacy 全局别名 (仅对本 server 生效)。
    activateIf: {
      kind: "env-any-of",
      refs: ["INVEST_AGENT_MCP_MARKET_DATA_ENABLED", "INVEST_AGENT_MCP_EXTERNAL_ENABLED"],
    },
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
    // 声明式激活 (T-243): dedicated 开关。
    activateIf: { kind: "env-any-of", refs: ["INVEST_AGENT_MCP_QSSE_ENABLED"] },
  };
}

/**
 * 判断一个外部注册项在当前 env 下是否应被注册并启用。
 *
 * 自 T-243 起按注册项声明的 activateIf 规则求值 (evaluateActivation)，
 * 不再分派 server id。未声明规则的注册项一律 fail-closed。
 * mcp-session-manifest 与 mcp-registry 都不含 server-specific activation 逻辑。
 */
export function isExternalRegistrationActivated(
  reg: McpServerRegistration,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return evaluateActivation(reg.activateIf, env);
}

/** 全部外部注册项。每项仍由自己的 activateIf 规则决定是否实际注册。 */
export function buildExternalRegistrations(): McpServerRegistration[] {
  return [buildMarketDataToolRegistration(), buildQsseQlibRegistration()];
}
