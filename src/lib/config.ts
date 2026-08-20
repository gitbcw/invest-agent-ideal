import "./load-env.js";
import path from "node:path";

const repoRoot = process.cwd();
const defaultRuntimeDataRoot = path.resolve(repoRoot, "../../my-data/projects/invest-agent-ideal");

function defaultWorkspaceRoot() {
  return path.join(defaultRuntimeDataRoot, "workspaces");
}

export type RuntimeBackend = "mastra";

// Development machines can retain historic cloud Portal values in .env. Keep
// local Portal testing explicitly local unless production config is in use.
export const portalLocalOnly =
  process.env.PORTAL_LOCAL_ONLY === "true" && process.env.NODE_ENV !== "production";

export const config = {
  port: Number(process.env.PORT) || 22655,
  host: process.env.HOST || process.env.BIND_HOST || "127.0.0.1",
  nodeEnv: process.env.NODE_ENV || "development",

  stock: {
    api: process.env.STOCK_API || "tencent",
  },

  marketProviders: {
    /** Optional official Tushare Pro token. Kept service-side only. */
    tushareToken: process.env.TUSHARE_TOKEN || "",
    /** Optional official TDX MCP credentials and endpoint. */
    tdxMcpUrl: process.env.TDX_MCP_URL || "https://mcp.tdx.com.cn:3001/mcp",
    tdxMcpApiKey: process.env.TDX_MCP_API_KEY || "",
    tdxMcpFundamentalsTool: process.env.TDX_MCP_FUNDAMENTALS_TOOL || "tdx_wenda_quotes",
  },

  db: {
    path: process.env.DB_PATH || "./data/invest-agent.db",
  },

  platform: {
    anonymizationSecret: process.env.PLATFORM_ANONYMIZATION_SECRET ||
      (process.env.NODE_ENV === "production" ? "" : "dev-platform-anonymization-secret"),
    anonymizationPreviousSecret: process.env.PLATFORM_ANONYMIZATION_PREVIOUS_SECRET || "",
    authEnabled: process.env.PLATFORM_AUTH_ENABLED !== "false",
  },

  agent: {
    id: process.env.AGENT_ID || "invest-agent",
    name: process.env.AGENT_NAME || "投资选股助手",
    backend: "mastra" as RuntimeBackend,
  },

  weixin: {
    stateDir: path.resolve(
      process.env.INVEST_AGENT_WEIXIN_STATE_DIR ||
        process.env.OPENCLAW_STATE_DIR ||
        process.env.CLAWDBOT_STATE_DIR ||
        "./.state"
    ),
  },

  workspace: {
    root: path.resolve(process.env.WORKSPACE_ROOT || defaultWorkspaceRoot()),
    templatePath: path.resolve(process.env.WORKSPACE_TEMPLATE_PATH || "./templates/workspace"),
  },

  portal: {
    localOnly: portalLocalOnly,
    publicUrl: portalLocalOnly ? "http://localhost:3100" : (process.env.PORTAL_PUBLIC_URL || "http://localhost:3100"),
    distributionUrl: portalLocalOnly
      ? "http://127.0.0.1:3100/api/internal/distribution/provision"
      : (process.env.PORTAL_DISTRIBUTION_URL || "http://127.0.0.1:3100/api/internal/distribution/provision"),
    distributionToken: portalLocalOnly
      ? "dev-connector-token"
      : (process.env.PORTAL_DISTRIBUTION_TOKEN || process.env.PORTAL_CONNECTOR_TOKEN || "dev-connector-token"),
  },

  /**
   * 服务层运行时数据(独立于 workspace,跟 sqlite db 同在 data/ 目录下)。
   * - sourceTelemetryDir: provider 调用遥测 jsonl 按日分区
   * - sourceQualityDir: provider 质量汇总/告警,用于平台观测与评测
   * - archiveDir: 不可逆破坏前的导出/归档目录(如 legacy 表 DROP 前的数据备份)
   */
  runtimeData: {
    root: path.resolve(process.env.RUNTIME_DATA_ROOT || path.join(repoRoot, "data")),
    sourceTelemetryDir: path.resolve(
      process.env.RUNTIME_DATA_ROOT || path.join(repoRoot, "data"),
      "source-telemetry",
    ),
    sourceQualityDir: path.resolve(
      process.env.RUNTIME_DATA_ROOT || path.join(repoRoot, "data"),
      "source-quality",
    ),
    archiveDir: path.resolve(
      process.env.RUNTIME_DATA_ROOT || path.join(repoRoot, "data"),
      "archive",
    ),
  },
};
