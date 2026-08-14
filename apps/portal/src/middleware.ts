import { NextResponse, type NextRequest } from "next/server";

import { readSessionFromRequest } from "@/lib/auth/session";

const PROTECTED_PREFIXES = ["/chat", "/api/conversations", "/api/assistant", "/api/auth/password"];
const ADMIN_PREFIXES = ["/api/admin"];

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const cookieName = process.env.PORTAL_COOKIE_NAME ?? "portal_session";
  const token = request.cookies.get(cookieName)?.value;
  const session = await readSessionFromRequest(token);

  // 已登录用户访问根路径或 login -> 跳转聊天
  if (session && (pathname === "/" || pathname === "/login")) {
    const url = request.nextUrl.clone();
    url.pathname = "/chat";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // 未登录访问受保护路径 -> 跳登录
  if (!session && PROTECTED_PREFIXES.some((p) => pathname.startsWith(p))) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: { code: "UNAUTHORIZED", message: "未登录", retryable: false } },
        { status: 401 }
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }

  // 管理员路径
  if (ADMIN_PREFIXES.some((p) => pathname.startsWith(p))) {
    if (!session || session.role !== "admin") {
      return NextResponse.json(
        { ok: false, error: { code: "FORBIDDEN", message: "无权限", retryable: false } },
        { status: 403 }
      );
    }
  }

  // 必须改密的用户,只允许访问改密接口
  if (session?.mustChangePassword) {
    const allowed = pathname === "/api/auth/password" || pathname === "/api/auth/logout" || pathname.startsWith("/change-password");
    if (!allowed && PROTECTED_PREFIXES.some((p) => pathname.startsWith(p))) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          {
            ok: false,
            error: {
              code: "FORBIDDEN",
              message: "请先修改初始密码",
              retryable: false
            }
          },
          { status: 403 }
        );
      }
      const url = request.nextUrl.clone();
      url.pathname = "/change-password";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/login",
    "/chat/:path*",
    "/change-password",
    "/api/conversations/:path*",
    "/api/assistant/:path*",
    "/api/auth/password",
    "/api/auth/logout",
    "/api/admin/:path*"
  ]
};
