import { NextResponse, type NextRequest } from "next/server";

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
}

export type ApiResult<T> = ApiOk<T> | ApiError;

export function ok<T>(data: T, init?: ResponseInit): NextResponse<ApiOk<T>> {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(
  code: string,
  message: string,
  options: { status?: number; retryable?: boolean; details?: Record<string, unknown> } = {}
): NextResponse<ApiError> {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code,
        message,
        retryable: options.retryable ?? false,
        details: options.details
      }
    },
    { status: options.status ?? 400 }
  );
}

export function unauthorized(message = "未登录"): NextResponse<ApiError> {
  return fail("UNAUTHORIZED", message, { status: 401, retryable: false });
}

export function forbidden(message = "无权限"): NextResponse<ApiError> {
  return fail("FORBIDDEN", message, { status: 403, retryable: false });
}

export function badRequest(message: string, details?: Record<string, unknown>): NextResponse<ApiError> {
  return fail("INVALID_REQUEST", message, { status: 400, retryable: false, details });
}

export function notFound(message: string): NextResponse<ApiError> {
  return fail("NOT_FOUND", message, { status: 404, retryable: false });
}

export function getIp(request: NextRequest): string | undefined {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim();
  return request.headers.get("x-real-ip") ?? undefined;
}

export function getUserAgent(request: NextRequest): string | undefined {
  return request.headers.get("user-agent") ?? undefined;
}
