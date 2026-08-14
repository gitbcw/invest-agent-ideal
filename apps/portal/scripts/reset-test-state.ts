import "node:process";

import { getConfig } from "../src/lib/config";
import { openDatabaseAt } from "../src/lib/db";

async function main() {
  const cfg = getConfig();
  const db = openDatabaseAt(cfg.dbPath);
  const now = new Date().toISOString();
  const assistantId = cfg.defaultAssistantId;
  const instanceId = cfg.defaultInstanceId;

  const tx = db.transaction(() => {
    const user = db
      .prepare(
        `UPDATE users
         SET display_name = ?, updated_at = ?
         WHERE username = ?`
      )
      .run("测试账号", now, "primary");

    const messages = db
      .prepare(
        `DELETE FROM conversation_message_mirror
         WHERE assistant_id = ? OR instance_id = ?`
      )
      .run(assistantId, instanceId);

    const conversations = db
      .prepare(
        `DELETE FROM conversation_mirror
         WHERE assistant_id = ? OR instance_id = ?`
      )
      .run(assistantId, instanceId);

    const cursors = db
      .prepare("DELETE FROM mirror_cursor WHERE assistant_id = ?")
      .run(assistantId);

    return {
      userRows: user.changes,
      messageRows: messages.changes,
      conversationRows: conversations.changes,
      cursorRows: cursors.changes
    };
  });

  const result = tx();
  console.log("[reset-test-state] done", {
    assistantId,
    instanceId,
    ...result
  });
  db.close();
}

void main().catch((err) => {
  console.error("[reset-test-state] fatal:", err);
  process.exit(1);
});
