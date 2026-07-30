/**
 * 外部只读 MCP 注册项 (WP2)
 *
 * 把 `market-data-tool` 作为外部只读 MCP 接入 invest-agent 的注册表。
 *
 * 设计要点:
 *   - 默认关闭 (enabled: false),需显式 env 开启,保证零行为回归。
 *   - transport 选 stdio: ACP 协议里所有 Agent MUST 支持 stdio,codex-acp 直接
 *     spawn 子进程并管理 stdio 通信,invest-agent 无需自建 MCP client。
 *   - 路径/凭证走 env 引用,不写开发机绝对路径到默认值。
 *   - external-readonly 安全边界由 WP1 的校验护栏保证 (禁止引用 service scope env)。
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
      kind: "stdio",
      // 占位符: resolve 时从 env 解析为实际 uv 可执行路径
      command: "<runtime:mdt-uv-bin>",
      // 占位符: resolve 时展开为 ["run", "--project", <MDT_PROJECT_DIR>, "mdt-mcp"]
      args: ["<runtime:mdt-run-args>"],
      // envRefs 只含外部工具自己的引用; WP1 校验禁止 service scope env 进来
      envRefs: [
        // 必需 (缺则 fail closed)
        "MDT_PROJECT_DIR",
        "MDT_UV_BIN",
        // 可选凭证/配置 (缺省不阻断: 工具自身有内置默认或返回结构化错误)
        "MDT_SEARCH_PROVIDER",
        "MDT_SEARCH_API_KEY",
        "MDT_TENCENT_TOKEN",
        "MDT_TENCENT_DEV_ID",
        "MDT_CACHE_DIR",
      ],
    },
    versionPolicy: { expected: "1.29.0", allowedRange: "^1" },
    // 开放式研究 + 定时只读可用; 不含 evaluation (eval 隔离会话不接入外部 MCP)
    sessionKinds: ["interactive", "scheduled-read"],
  };
}

/** 全部外部注册项 (当前仅 market-data-tool)。 */
export function buildExternalRegistrations(): McpServerRegistration[] {
  return [buildMarketDataToolRegistration()];
}
