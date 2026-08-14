import { PORTAL_PROTOCOL_VERSION } from "./version";
import type {
  PortalEnvelope,
  PortalError,
  PortalErrorCode,
  PortalResponse
} from "./envelope";

export * from "./version";
export * from "./envelope";
export * from "./types";

/**
 * 构造一条请求 envelope。
 */
export function buildEnvelope<T>(
  type: string,
  requestId: string,
  payload: T,
  protocolVersion: string = PORTAL_PROTOCOL_VERSION
): PortalEnvelope<T> {
  return {
    protocolVersion: protocolVersion as PortalEnvelope["protocolVersion"],
    requestId,
    type,
    sentAt: new Date().toISOString(),
    payload
  };
}

/**
 * 构造一条成功响应。
 */
export function buildOkResponse<T>(
  type: string,
  requestId: string,
  data: T,
  protocolVersion: string = PORTAL_PROTOCOL_VERSION
): PortalResponse<T> {
  return {
    protocolVersion: protocolVersion as PortalResponse["protocolVersion"],
    requestId,
    type,
    ok: true,
    sentAt: new Date().toISOString(),
    data
  };
}

/**
 * 构造一条错误响应。
 */
export function buildErrorResponse(
  type: string,
  requestId: string,
  error: PortalError,
  protocolVersion: string = PORTAL_PROTOCOL_VERSION
): PortalResponse {
  return {
    protocolVersion: protocolVersion as PortalResponse["protocolVersion"],
    requestId,
    type,
    ok: false,
    sentAt: new Date().toISOString(),
    error
  };
}

/**
 * 构造错误对象。
 */
export function makeError(
  code: PortalErrorCode,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>
): PortalError {
  return { code, message, retryable, details };
}

/**
 * 解析一条入站消息为 envelope,并校验 protocolVersion。
 * 当前版本对未知版本宽容,允许后续兼容测试。
 */
export function parseEnvelope<T = unknown>(raw: string): PortalEnvelope<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON envelope: ${(err as Error).message}`);
  }
  const env = json as Partial<PortalEnvelope<T>>;
  if (!env || typeof env !== "object") {
    throw new Error("Envelope must be an object");
  }
  if (typeof env.type !== "string" || typeof env.requestId !== "string") {
    throw new Error("Envelope missing type or requestId");
  }
  if (typeof env.protocolVersion !== "string") {
    throw new Error("Envelope missing protocolVersion");
  }
  return env as PortalEnvelope<T>;
}
