import "dotenv/config";
import Database from "better-sqlite3";
import path from "node:path";

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

const userId = readArg("--user-id");
const instanceId = readArg("--instance-id");
const apply = process.argv.includes("--apply");

if (!userId || !instanceId) {
  console.error("Usage: node scripts/repair-orphan-conversation-log.mjs --user-id <id> --instance-id <id> [--apply]");
  process.exit(1);
}

const dbPath = path.resolve(process.env.DB_PATH || "./data/invest-agent.db");
const db = new Database(dbPath);
db.pragma("foreign_keys = ON");

try {
  const activeUser = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  const activeInstance = db.prepare("SELECT id FROM ai_instances WHERE id = ?").get(instanceId);
  if (activeUser || activeInstance) {
    throw new Error("REFUSING_ACTIVE_SCOPE: both the user and instance must already be absent");
  }

  const messages = db.prepare(`
    SELECT message_id, conversation_id
    FROM conversation_messages
    WHERE user_id = ? AND instance_id = ?
    ORDER BY created_at ASC
  `).all(userId, instanceId);
  const conversationIds = [...new Set(messages.map((row) => row.conversation_id))];

  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      userId,
      instanceId,
      orphanMessageCount: messages.length,
      affectedConversationCount: conversationIds.length,
    }));
    process.exit(0);
  }

  const repair = db.transaction(() => {
    const deletedMessages = db.prepare("DELETE FROM conversation_messages WHERE user_id = ? AND instance_id = ?").run(userId, instanceId).changes;
    let deletedSessions = 0;
    const deleteSession = db.prepare(`
      DELETE FROM conversation_sessions
      WHERE conversation_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM conversation_messages WHERE conversation_id = ?
        )
    `);
    for (const conversationId of conversationIds) {
      deletedSessions += deleteSession.run(conversationId, conversationId).changes;
    }
    return { deletedMessages, deletedSessions };
  });

  const result = repair();
  console.log(JSON.stringify({ ok: true, dryRun: false, userId, instanceId, ...result }));
} finally {
  db.close();
}
