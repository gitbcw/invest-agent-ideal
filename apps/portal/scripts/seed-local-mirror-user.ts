import { getConfig } from "../src/lib/config";
import { openDatabaseAt } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";
import { UserRepository } from "../src/lib/db/users";

const username = process.env.MIRROR_USERNAME;
const instanceId = process.env.MIRROR_INSTANCE_ID;
if (!username || !instanceId) throw new Error("MIRROR_USERNAME and MIRROR_INSTANCE_ID are required");

const cfg = getConfig();
const db = openDatabaseAt(cfg.dbPath);
const users = new UserRepository(db);
const existing = users.getByUsername(username);
if (!existing) {
  const passwordHash = await hashPassword("User@2026");
  users.create({ username, passwordHash, role: "user", assistantId: instanceId, instanceId, displayName: process.env.MIRROR_DISPLAY_NAME ?? username });
  console.log(`[mirror] created ${username} -> ${instanceId}`);
} else {
  console.log(`[mirror] retained ${username} -> ${existing.instanceId}`);
}
db.close();
