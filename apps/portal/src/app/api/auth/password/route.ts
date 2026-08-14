import { z } from "zod";

import { openDatabase } from "@/lib/db";
import { AuditRepository, UserRepository } from "@/lib/db/users";
import { badRequest, getIp, getUserAgent, ok, unauthorized } from "@/lib/http";
import {
  createSessionToken,
  getCurrentSession,
  hashPassword,
  setSessionCookie,
  validatePasswordPolicy,
  verifyPassword
} from "@/lib/auth";

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(1).max(128),
  confirmNewPassword: z.string().min(1).max(128)
});

export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) {
    return unauthorized();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = ChangePasswordSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("参数错误", { issues: parsed.error.issues });
  }
  const { currentPassword, newPassword, confirmNewPassword } = parsed.data;

  if (newPassword !== confirmNewPassword) {
    return badRequest("两次输入的新密码不一致");
  }
  const policy = validatePasswordPolicy(newPassword, session.username);
  if (!policy.ok) {
    return badRequest(policy.reason ?? "新密码不符合规则");
  }
  if (newPassword === currentPassword) {
    return badRequest("新密码不能与当前密码相同");
  }

  const db = openDatabase();
  const users = new UserRepository(db);
  const audit = new AuditRepository(db);
  const user = users.getById(session.sub);
  if (!user) {
    return unauthorized("登录已失效");
  }

  const currentOk = await verifyPassword(currentPassword, user.passwordHash);
  if (!currentOk) {
    return badRequest("当前密码错误");
  }

  const newHash = await hashPassword(newPassword);
  users.updatePassword(user.id, newHash, false);
  audit.recordPasswordChange({
    userId: user.id,
    username: user.username,
    ip: getIp(request as never),
    userAgent: getUserAgent(request as never)
  });

  // 改密成功后重新签发 session(把 mustChangePassword 标志清掉)
  const refreshed = await createSessionToken({
    sub: user.id,
    username: user.username,
    role: user.role,
    assistantId: user.assistantId,
    instanceId: user.instanceId,
    mustChangePassword: false
  });
  await setSessionCookie(refreshed);

  return ok({ changed: true, requiresReLogin: false });
}
