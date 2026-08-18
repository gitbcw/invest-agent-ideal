#!/usr/bin/env node
/**
 * Normalize legacy conversation project_id scope (C2 repair, 2026-08-18).
 *
 * Migrated conversations created before the candidate-era project convention
 * carry project_id='invest-agent-<user>' while the runtime/connector scope
 * whitelist only accepts 'invest-agent' (plus the registry project). Sending
 * into those conversations fails with CONVERSATION_SCOPE_MISMATCH (HTTP 403).
 * This is the web-channel equivalent of the 2026-08-17 WeChat-channel
 * normalization recorded in docs/open-work-items.md (W6 appendix).
 *
 * Only conversation_sessions.project_id is scope-relevant; messages rows of
 * the same conversations are normalized for consistency with that repair.
 *
 * Usage:
 *   node scripts/normalize-legacy-conversation-project.mjs --db <runtime.db> --dry-run
 *   node scripts/normalize-legacy-conversation-project.mjs --db <runtime.db> --apply
 */
import { parseArgs } from "node:util";
import { createRequire } from "node:module";

const args = parseArgs({
  allowPositionals: false,
  options: {
    db: { type: "string" },
    "dry-run": { type: "boolean" },
    apply: { type: "boolean" },
  },
});
if (!args.values.db || args.values["dry-run"] === args.values.apply) {
  console.error("usage: --db <path> with exactly one of --dry-run | --apply");
  process.exit(2);
}
const TARGET = "invest-agent";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const db = new Database(args.values.db, { readonly: args.values["dry-run"] === true });
const legacySessions = db.prepare(`
  SELECT conversation_id, user_id, project_id, channel, message_count
  FROM conversation_sessions
  WHERE project_id LIKE 'invest-agent-%' AND project_id != ?
`).all(TARGET);

const legacyMessages = legacySessions.length === 0 ? 0
  : db.prepare(`
    SELECT COUNT(*) AS n FROM conversation_messages
    WHERE conversation_id IN (
      SELECT conversation_id FROM conversation_sessions
      WHERE project_id LIKE 'invest-agent-%' AND project_id != ?
    )
  `).get(TARGET).n;

console.log(`legacy sessions: ${legacySessions.length}, messages in scope: ${legacyMessages}`);
for (const row of legacySessions) {
  console.log(`  ${row.conversation_id} user=${row.user_id} channel=${row.channel} project=${row.project_id} msgs=${row.message_count}`);
}

if (args.values["dry-run"]) {
  console.log("dry-run: no changes written");
  db.close();
  process.exit(0);
}

const backupPath = `${args.values.db}.pre-c2-normalize-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`;
await db.backup(backupPath);
console.log(`backup written: ${backupPath}`);

const tx = db.transaction(() => {
  const ids = legacySessions.map((row) => row.conversation_id);
  const updateSession = db.prepare("UPDATE conversation_sessions SET project_id = ? WHERE conversation_id = ?");
  const updateMessage = db.prepare("UPDATE conversation_messages SET project_id = ? WHERE conversation_id = ?");
  for (const id of ids) {
    updateSession.run(TARGET, id);
    updateMessage.run(TARGET, id);
  }
});
tx();

const remaining = db.prepare(`
  SELECT COUNT(*) AS n FROM conversation_sessions
  WHERE project_id LIKE 'invest-agent-%' AND project_id != ?
`).get(TARGET).n;
console.log(`applied. remaining legacy sessions: ${remaining}`);
if (remaining !== 0) {
  console.error("unexpected remaining legacy rows; inspect backup before retrying");
  process.exit(1);
}
db.close();
