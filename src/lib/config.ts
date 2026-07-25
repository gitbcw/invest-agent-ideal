import "dotenv/config";
import path from "node:path";

const repoRoot = process.cwd();
const defaultRuntimeDataRoot = path.resolve(repoRoot, "../../my-data/projects/invest-agent-ideal");

function defaultWorkspaceRoot() {
  return path.join(defaultRuntimeDataRoot, "workspaces");
}

export type LlmProvider = "deepseek" | "stepfun" | "doubao";
export type RuntimeBackend = "hermes" | "codex";

// Development machines can retain historic cloud Portal values in .env. Keep
// local Portal testing explicitly local unless production config is in use.
export const portalLocalOnly =
  process.env.PORTAL_LOCAL_ONLY === "true" && process.env.NODE_ENV !== "production";

export const config = {
  port: Number(process.env.PORT) || 22655,
  host: process.env.HOST || process.env.BIND_HOST || "127.0.0.1",
  nodeEnv: process.env.NODE_ENV || "development",

  llm: {
    provider: (process.env.LLM_PROVIDER || "deepseek") as LlmProvider,
  },

  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    flashModel: process.env.DEEPSEEK_FLASH_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    proModel: process.env.DEEPSEEK_PRO_MODEL || "deepseek-v4-pro",
  },

  stepfun: {
    apiKey: process.env.STEPFUN_API_KEY || "",
    baseUrl: process.env.STEPFUN_BASE_URL || "https://api.stepfun.com",
    flashModel: process.env.STEPFUN_FLASH_MODEL || "step-3.7-flash",
    proModel: process.env.STEPFUN_PRO_MODEL || "step-3.7-flash",
  },

  doubao: {
    apiKey: process.env.DOUBAO_API_KEY || "",
    baseUrl: process.env.DOUBAO_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
    flashModel: process.env.DOUBAO_FLASH_MODEL || "doubao-seed-2-0-lite-260428",
    proModel: process.env.DOUBAO_PRO_MODEL || "doubao-seed-2-0-lite-260428",
  },

  stock: {
    api: process.env.STOCK_API || "tencent",
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

  acp: {
    agentId: process.env.ACP_AGENT_ID || "invest-agent",
    agentName: process.env.ACP_AGENT_NAME || "投资选股助手",
    backend: (process.env.ACP_BACKEND || "codex") as RuntimeBackend,
  },

  codex: {
    acpCommand: process.env.CODEX_ACP_COMMAND || "/Users/combo/.local/bin/codex-acp",
    acpArgs: process.env.CODEX_ACP_ARGS?.trim()
      ? process.env.CODEX_ACP_ARGS.trim().split(/\s+/)
      : [],
    simpleModel: process.env.CODEX_SIMPLE_MODEL || "gpt-5.4-mini",
    complexModel: process.env.CODEX_COMPLEX_MODEL || "gpt-5.5",
    acpCwd: process.env.CODEX_ACP_CWD || process.cwd(),
    acpTimeoutMs: Number(process.env.CODEX_ACP_TIMEOUT_MS) || 1800000,
    sourceHome: path.resolve(process.env.CODEX_SOURCE_HOME || path.join(process.env.HOME || "", ".codex")),
  },

  hermes: {
    acpCommand: process.env.HERMES_ACP_COMMAND || "/Users/combo/.local/bin/hermes",
    acpArgs: process.env.HERMES_ACP_ARGS?.trim()
      ? process.env.HERMES_ACP_ARGS.trim().split(/\s+/)
      : ["acp", "--accept-hooks"],
    acpCwd: process.env.HERMES_ACP_CWD || process.cwd(),
    acpTimeoutMs: Number(process.env.HERMES_ACP_TIMEOUT_MS) || 1800000,
    sourceHome: path.resolve(process.env.HERMES_SOURCE_HOME || path.join(process.env.HOME || "", ".hermes")),
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
