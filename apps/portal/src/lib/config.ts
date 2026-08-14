import path from "node:path";
import fs from "node:fs";

/**
 * 在 Node 进程启动时(独立 tsx 脚本 / Next.js server side)加载项目根的 .env。
 * Next.js dev/build 本身会加载 .env / .env.local,这一步主要服务 scripts/start-*.ts。
 * Edge runtime(middleware)不会经过本模块的运行时,因此 env 必须由 process 自身提供。
 */
function loadDotEnvIfPresent(): void {
  if (process.env.PORTAL_ENV_LOADED === "1") return;
  const candidates = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), ".env")
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line
        .slice(eq + 1)
        .trim()
        .replace(/^['"]/, "")
        .replace(/['"]$/, "");
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
  process.env.PORTAL_ENV_LOADED = "1";
}

loadDotEnvIfPresent();

const DEV_JWT_SECRET = "dev-secret-change-me-please-32-chars-min";
const DEV_CONNECTOR_TOKEN = "dev-connector-token";

function requiredEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required env: ${key}`);
  }
  return value;
}

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production" && process.env.PORTAL_DEV !== "1";
}

function secureEnv(key: string, devFallback: string): string {
  const value = process.env[key] ?? (isProductionEnv() ? undefined : devFallback);
  if (!value) {
    throw new Error(`Missing required production env: ${key}`);
  }
  if (isProductionEnv() && value === devFallback) {
    throw new Error(`Refusing to start production with default ${key}`);
  }
  return value;
}

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const num = Number.parseInt(raw, 10);
  if (Number.isNaN(num)) {
    throw new Error(`Invalid integer env: ${key}=${raw}`);
  }
  return num;
}

function boolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export interface PortalConfig {
  port: number;
  dbPath: string;
  jwtSecret: string;
  cookieName: string;
  sessionTtlSec: number;
  relayPort: number;
  executionBudgetMs: number;
  connectorRequestTimeoutMs: number;
  connectorToken: string;
  distributionToken: string;
  defaultAssistantId: string;
  defaultInstanceId: string;
  defaultProjectId: string;
  isDev: boolean;
}

export const PORTAL_TIMEOUT_BUFFER_MS = 15_000;
export const DEFAULT_PORTAL_EXECUTION_BUDGET_MS = 1_200_000;
export const DEFAULT_PORTAL_CONNECTOR_REQUEST_TIMEOUT_MS =
  DEFAULT_PORTAL_EXECUTION_BUDGET_MS + PORTAL_TIMEOUT_BUFFER_MS;

export interface PortalTimeoutSummary {
  executionBudgetMs: number;
  connectorRequestTimeoutMs: number;
  relayBufferMs: number;
}

let cached: PortalConfig | null = null;

export function getConfig(): PortalConfig {
  if (cached) return cached;
  const projectRoot = process.cwd();
  const connectorToken = secureEnv("PORTAL_CONNECTOR_TOKEN", DEV_CONNECTOR_TOKEN);
  const distributionToken = process.env.PORTAL_DISTRIBUTION_TOKEN ?? (isProductionEnv() ? undefined : connectorToken);
  if (!distributionToken) {
    throw new Error("Missing required production env: PORTAL_DISTRIBUTION_TOKEN");
  }
  if (isProductionEnv() && distributionToken === DEV_CONNECTOR_TOKEN) {
    throw new Error("Refusing to start production with default PORTAL_DISTRIBUTION_TOKEN");
  }
  if (isProductionEnv() && distributionToken === connectorToken) {
    throw new Error("PORTAL_DISTRIBUTION_TOKEN must differ from PORTAL_CONNECTOR_TOKEN in production");
  }
  const executionBudgetMs = intEnv("PORTAL_EXECUTION_BUDGET_MS", DEFAULT_PORTAL_EXECUTION_BUDGET_MS);
  const connectorRequestTimeoutMs = intEnv(
    "PORTAL_CONNECTOR_REQUEST_TIMEOUT_MS",
    DEFAULT_PORTAL_CONNECTOR_REQUEST_TIMEOUT_MS
  );
  validatePortalTimeoutRelation(executionBudgetMs, connectorRequestTimeoutMs);
  cached = {
    port: intEnv("PORTAL_PORT", 3100),
    dbPath: path.resolve(projectRoot, process.env.PORTAL_DB_PATH ?? "./data/portal.db"),
    jwtSecret: secureEnv("PORTAL_JWT_SECRET", DEV_JWT_SECRET),
    cookieName: process.env.PORTAL_COOKIE_NAME ?? "portal_session",
    sessionTtlSec: intEnv("PORTAL_SESSION_TTL_SEC", 60 * 60 * 24 * 30),
    relayPort: intEnv("PORTAL_RELAY_PORT", 3199),
    executionBudgetMs,
    connectorRequestTimeoutMs,
    connectorToken,
    distributionToken,
    defaultAssistantId: process.env.PORTAL_DEFAULT_ASSISTANT_ID ?? "invest-agent-primary",
    defaultInstanceId: process.env.PORTAL_DEFAULT_INSTANCE_ID ?? "invest-agent-primary",
    defaultProjectId: process.env.PORTAL_DEFAULT_PROJECT_ID ?? "invest-agent",
    isDev: boolEnv("PORTAL_DEV", process.env.NODE_ENV !== "production")
  };
  return cached;
}

export function validatePortalTimeoutRelation(
  executionBudgetMs: number,
  connectorRequestTimeoutMs: number
): void {
  if (!Number.isInteger(executionBudgetMs) || executionBudgetMs <= 0) {
    throw new Error(`PORTAL_EXECUTION_BUDGET_MS must be a positive integer: ${executionBudgetMs}`);
  }
  if (!Number.isInteger(connectorRequestTimeoutMs) || connectorRequestTimeoutMs <= 0) {
    throw new Error(
      `PORTAL_CONNECTOR_REQUEST_TIMEOUT_MS must be a positive integer: ${connectorRequestTimeoutMs}`
    );
  }
  const minimum = executionBudgetMs + PORTAL_TIMEOUT_BUFFER_MS;
  if (connectorRequestTimeoutMs < minimum) {
    throw new Error(
      `PORTAL_CONNECTOR_REQUEST_TIMEOUT_MS (${connectorRequestTimeoutMs}) must be at least PORTAL_EXECUTION_BUDGET_MS + ${PORTAL_TIMEOUT_BUFFER_MS} (${minimum})`
    );
  }
}

export function portalTimeoutSummary(config: PortalConfig = getConfig()): PortalTimeoutSummary {
  return {
    executionBudgetMs: config.executionBudgetMs,
    connectorRequestTimeoutMs: config.connectorRequestTimeoutMs,
    relayBufferMs: config.connectorRequestTimeoutMs - config.executionBudgetMs
  };
}

/**
 * 供 mock connector 等外部脚本使用:读取当前选定的 mock 场景。
 */
export function getMockScenario(): string {
  return process.env.PORTAL_MOCK_SCENARIO ?? "online";
}
