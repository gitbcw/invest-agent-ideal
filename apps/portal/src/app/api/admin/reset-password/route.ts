import { z } from "zod";

import { openDatabase } from "@/lib/db";
import { AuditRepository, UserRepository } from "@/lib/db/users";
import {
  badRequest,
  forbidden,
  getIp,
  getUserAgent,
  ok,
  unauthorized
} from "@/lib/http";
import {
  generateTemporaryPassword,
  getCurrentSession,
  hashPassword
} from "@/lib/auth";

const ResetSchema = z.object({
  username: z.string().trim().min(1).max(64)
});

export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  if (session.role !== "admin") return forbidden("仅管理员可重置密码");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = ResetSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("参数错误", { issues: parsed.error.issues });
  }

  const db = openDatabase();
  const users = new UserRepository(db);
  const audit = new AuditRepository(db);
  const target = users.getByUsername(parsed.data.username);
  if (!target) {
    return badRequest("目标账号不存在");
  }
  if (target.role === "admin") {
    return forbidden("不允许重置管理员密码");
  }

  const temporaryPassword = generateTemporaryPassword();
  const newHash = await hashPassword(temporaryPassword);
  users.updatePassword(target.id, newHash, true);
  audit.recordPasswordReset({
    operatorId: session.sub,
    operatorRole: session.role,
    targetUserId: target.id,
    targetUsername: target.username,
    temporaryPasswordSet: true,
    ip: getIp(request as never),
    userAgent: getUserAgent(request as never)
  });

  return ok({
    username: target.username,
    temporaryPassword,
    mustChangePassword: true,
    notice: "请将临时密码安全地交给用户,首次登录后需修改密码"
  });
}
