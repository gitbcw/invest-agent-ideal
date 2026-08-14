import { z } from "zod";
import { nanoid } from "nanoid";

import { openDatabase } from "@/lib/db";
import { AuditRepository, UserRepository } from "@/lib/db/users";
import { badRequest, fail, getIp, getUserAgent, ok } from "@/lib/http";
import {
  createSessionToken,
  setSessionCookie,
  verifyPassword
} from "@/lib/auth";

const LoginSchema = z.object({
  username: z.string().trim().min(1, "请输入账号").max(64),
  password: z.string().min(1, "请输入密码").max(128)
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }

  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("账号或密码格式错误", { issues: parsed.error.issues });
  }
  const { username, password } = parsed.data;

  const db = openDatabase();
  const users = new UserRepository(db);
  const audit = new AuditRepository(db);

  const user = users.getByUsername(username);
  // 失败也要返回相同的"账号或密码错误"消息,避免账号枚举
  const genericFail = () =>
    fail("INVALID_CREDENTIALS", "账号或密码错误", { status: 401, retryable: false });

  if (!user) {
    audit.recordAuthEvent({
      username,
      event: "login_failed",
      ip: getIp(request as never),
      userAgent: getUserAgent(request as never),
      details: "user_not_found"
    });
    return genericFail();
  }

  const passwordOk = await verifyPassword(password, user.passwordHash);
  if (!passwordOk) {
    audit.recordAuthEvent({
      userId: user.id,
      username,
      event: "login_failed",
      ip: getIp(request as never),
      userAgent: getUserAgent(request as never),
      details: "password_mismatch"
    });
    return genericFail();
  }

  users.markLogin(user.id);
  audit.recordAuthEvent({
    userId: user.id,
    username,
    event: "login_success",
    ip: getIp(request as never),
    userAgent: getUserAgent(request as never)
  });

  const token = await createSessionToken({
    sub: user.id,
    username: user.username,
    role: user.role,
    assistantId: user.assistantId,
    instanceId: user.instanceId,
    mustChangePassword: user.mustChangePassword === 1
  });
  await setSessionCookie(token);

  return ok({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.displayName ?? user.username,
      assistantId: user.assistantId,
      instanceId: user.instanceId,
      mustChangePassword: user.mustChangePassword === 1
    },
    serverRequestId: `req_${nanoid(8)}`
  });
}
