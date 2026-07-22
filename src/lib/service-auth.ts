import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const PUBLIC_PATHS = new Set([
  "/health",
  "/.well-known/agent.json",
  "/dashboard",
  "/admin/weixin",
  "/api/platform/auth/login",
]);
const SANDBOX_PREFIX = "/api/sandbox/";

function localDevelopmentToken() {
  const filePath = path.resolve(process.env.INVEST_AGENT_API_TOKEN_FILE || "data/.service-api-token");
  if (existsSync(filePath)) return readFileSync(filePath, "utf8").trim();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(filePath, token, { mode: 0o600 });
  return token;
}

const configuredToken = process.env.INVEST_AGENT_API_TOKEN?.trim();

export const serviceApiToken = configuredToken || (
  config.nodeEnv === "production"
    ? ""
    : localDevelopmentToken()
);

export function assertServiceAuthConfiguration() {
  if (!serviceApiToken || (config.nodeEnv === "production" && (serviceApiToken.length < 32 || serviceApiToken.startsWith("replace_with_")))) {
    throw new Error("INVEST_AGENT_API_TOKEN_REQUIRED_IN_PRODUCTION");
  }
  if (config.nodeEnv === "production" && !config.platform.anonymizationSecret) {
    throw new Error("PLATFORM_ANONYMIZATION_SECRET_REQUIRED_IN_PRODUCTION");
  }
}

export function isPublicServicePath(url: string) {
  return PUBLIC_PATHS.has(url.split("?")[0]);
}

export function isSandboxPath(url: string) {
  return url.split("?")[0].startsWith(SANDBOX_PREFIX);
}

export function hasServiceApiAuthorization(headers: Record<string, string | string[] | undefined>) {
  const auth = headers.authorization;
  const raw = Array.isArray(auth) ? auth[0] : auth;
  const bearer = raw?.match(/^Bearer\s+(.+)$/i)?.[1];
  const basic = raw?.match(/^Basic\s+(.+)$/i)?.[1];
  const basicToken = basic
    ? (() => {
        const decoded = Buffer.from(basic, "base64").toString("utf8");
        const separator = decoded.indexOf(":");
        const username = separator >= 0 ? decoded.slice(0, separator) : "";
        return username === "invest-agent" ? decoded.slice(separator + 1) : undefined;
      })()
    : undefined;
  const token = bearer || basicToken || (
    Array.isArray(headers["x-invest-agent-token"])
      ? headers["x-invest-agent-token"]![0]
      : headers["x-invest-agent-token"]
  );
  return hasServiceApiToken(token);
}

export function hasServiceApiToken(token: string | undefined) {
  if (!token || !serviceApiToken) return false;
  const provided = Buffer.from(token);
  const expected = Buffer.from(serviceApiToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
