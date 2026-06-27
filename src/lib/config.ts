import "dotenv/config";
import path from "node:path";

const repoRoot = process.cwd();
const defaultRuntimeDataRoot = path.resolve(repoRoot, "../../my-data/projects/invest-agent-ideal");

function defaultWorkspaceRoot() {
  return path.join(defaultRuntimeDataRoot, "workspaces");
}

export type LlmProvider = "deepseek" | "stepfun" | "doubao";

export const config = {
  port: Number(process.env.PORT) || 22648,
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

  acp: {
    agentId: process.env.ACP_AGENT_ID || "invest-agent",
    agentName: process.env.ACP_AGENT_NAME || "投资选股助手",
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
};
