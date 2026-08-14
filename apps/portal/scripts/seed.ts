import "node:process";

import { getConfig } from "../src/lib/config";
import { openDatabaseAt } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";
import { AuditRepository, UserRepository } from "../src/lib/db/users";

/**
 * 初始化默认账号:
 * - primary  : 测试账号,密码 User@2026
 * - admin    : 管理员,密码 Admin@2026
 *
 * 如果账号已存在,会被跳过(幂等)。如需重置密码,请用 admin 调用 /api/admin/reset-password。
 */
async function main() {
  const cfg = getConfig();
  const db = openDatabaseAt(cfg.dbPath);
  const users = new UserRepository(db);
  const audit = new AuditRepository(db);

  const seedAccount = async (input: {
    username: string;
    password: string;
    role: "user" | "admin";
    displayName: string;
  }) => {
    const existing = users.getByUsername(input.username);
    if (existing) {
      console.log(`[seed] skip ${input.username} (already exists, id=${existing.id})`);
      return;
    }
    const hash = await hashPassword(input.password);
    const user = users.create({
      username: input.username,
      passwordHash: hash,
      role: input.role,
      assistantId: cfg.defaultAssistantId,
      instanceId: cfg.defaultInstanceId,
      displayName: input.displayName
    });
    console.log(`[seed] created ${input.username} (id=${user.id})`);
  };

  await seedAccount({
    username: "primary",
    password: "User@2026",
    role: "user",
    displayName: "测试账号"
  });
  await seedAccount({
    username: "admin",
    password: "Admin@2026",
    role: "admin",
    displayName: "管理员"
  });

  // 留一条空审计占位,便于 schema 校验
  audit.recordAuthEvent({ event: "seed_completed", details: new Date().toISOString() });

  console.log("[seed] done");
  db.close();
}

void main().catch((err) => {
  console.error("[seed] fatal:", err);
  process.exit(1);
});
