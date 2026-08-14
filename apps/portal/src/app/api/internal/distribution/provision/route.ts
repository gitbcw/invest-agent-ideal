import { z } from "zod";

import { getConfig } from "@/lib/config";
import { openDatabase } from "@/lib/db";
import { AuditRepository, UserRepository } from "@/lib/db/users";
import { badRequest, forbidden, ok } from "@/lib/http";
import { generateTemporaryPassword, hashPassword } from "@/lib/auth";

const ProvisionSchema = z.object({
  username: z.string().trim().min(2).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  displayName: z.string().trim().max(80).optional(),
  assistantId: z.string().trim().min(1).max(128),
  instanceId: z.string().trim().min(1).max(128)
});

function bearerToken(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

export async function POST(request: Request) {
  const cfg = getConfig();
  if (bearerToken(request) !== cfg.distributionToken) {
    return forbidden("无权分发门户账号");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = ProvisionSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("参数错误", { issues: parsed.error.issues });
  }

  const { username, displayName, assistantId, instanceId } = parsed.data;
  const db = openDatabase();
  const users = new UserRepository(db);
  const audit = new AuditRepository(db);
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const now = new Date().toISOString();
  const existing = users.getByUsername(username);

  if (existing?.role === "admin") {
    return forbidden("不能把管理员账号分发为用户账号");
  }

  if (existing) {
    db.prepare(
      `UPDATE users
       SET password_hash = ?,
           role = 'user',
           assistant_id = ?,
           instance_id = ?,
           display_name = ?,
           must_change_password = 1,
           updated_at = ?
       WHERE id = ?`
    ).run(
      passwordHash,
      assistantId,
      instanceId,
      displayName || existing.displayName || username,
      now,
      existing.id
    );
  } else {
    users.create({
      username,
      passwordHash,
      role: "user",
      assistantId,
      instanceId,
      displayName: displayName || username,
      mustChangePassword: true
    });
  }

  const user = users.getByUsername(username)!;
  audit.recordAuthEvent({
    userId: user.id,
    username,
    event: "distribution_provisioned",
    details: JSON.stringify({ assistantId, instanceId })
  });

  return ok({
    username,
    displayName: user.displayName ?? username,
    assistantId,
    instanceId,
    temporaryPassword,
    mustChangePassword: true,
    provisionedAt: now
  });
}
