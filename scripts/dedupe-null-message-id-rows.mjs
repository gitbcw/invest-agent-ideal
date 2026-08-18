#!/usr/bin/env node
/**
 * Deduplicate NULL message_id rows in conversation_messages (C1 cleanup,
 * authorized 2026-08-18).
 *
 * The 2026-08-17 mirror-flood left one conversation with ~70k rows that have
 * `message_id IS NULL` (SQLite text primary keys permit NULL, so the portal
 * upsert's ON CONFLICT(message_id) could never dedupe them). Some of those
 * turns have NO canonical row — the NULL copies are the only record of real
 * user turns — so this script dedupes instead of deleting blindly:
 *
 *   1. NULL rows whose (conversation_id, role, request_id, content) already
 *      exists as a canonical (message_id NOT NULL) row are deleted outright.
 *   2. Remaining NULL rows are grouped by
 *      (conversation_id, role, request_id, content); each group keeps exactly
 *      one row — preferring a row that carries idempotency_key — and the
 *      rest are deleted.
 *   3. conversation_sessions.message_count is recomputed for affected
 *      conversations.
 *
 * Group matching happens in memory (the table lacks a covering index, and a
 * correlated EXISTS over 70k rows is prohibitively slow).
 *
 * Usage:
 *   node scripts/dedupe-null-message-id-rows.mjs --db <runtime.db> --dry-run
 *   node scripts/dedupe-null-message-id-rows.mjs --db <runtime.db> --apply
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
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const db = new Database(args.values.db, { readonly: args.values["dry-run"] === true });

const keyOf = (conversationId, role, requestId, content) =>
  `${conversationId}\u0000${role}\u0000${requestId ?? "-"}\u0000${content}`;
const canonicalKeys = new Set(
  db.prepare(`
    SELECT conversation_id AS c, role AS r, request_id AS q, content AS t
    FROM conversation_messages WHERE message_id IS NOT NULL
  `).all().map((row) => keyOf(row.c, row.r, row.q, row.t)),
);
const nullRows = db.prepare(`
  SELECT rowid, conversation_id, role, request_id, content, idempotency_key IS NOT NULL AS has_idem
  FROM conversation_messages WHERE message_id IS NULL
`).all();
console.log(`NULL message_id rows total: ${nullRows.length}; canonical rows: ${canonicalKeys.size}`);

const groups = new Map();
let duplicatesOfCanonical = 0;
for (const row of nullRows) {
  const key = keyOf(row.conversation_id, row.role, row.request_id, row.content);
  if (canonicalKeys.has(key)) {
    duplicatesOfCanonical += 1;
    continue;
  }
  let group = groups.get(key);
  if (!group) {
    group = { keep: null, size: 0, conversationId: row.conversation_id, role: row.role, requestId: row.request_id, contentPrefix: row.content.slice(0, 40) };
    groups.set(key, group);
  }
  group.size += 1;
  const better = !group.keep
    || (row.has_idem && !group.keep.has_idem)
    || (row.has_idem === group.keep.has_idem && row.rowid < group.keep.rowid);
  if (better) group.keep = row;
}

const kept = [...groups.values()].filter((group) => group.size > 0);
const doomed = nullRows.filter((row) => {
  const group = groups.get(keyOf(row.conversation_id, row.role, row.request_id, row.content));
  return !group || group.keep.rowid !== row.rowid;
}).map((row) => row.rowid);

console.log("== groups ==");
for (const group of kept) {
  console.log(`  ${group.conversationId} role=${group.role} req=${group.requestId ?? "-"} n=${group.size} keep_rowid=${group.keep.rowid} "${group.contentPrefix}"`);
}
console.log(`plan: delete ${duplicatesOfCanonical} duplicates-of-canonical + ${doomed.length} intra-group duplicates; keep ${kept.length} group representatives`);

if (args.values["dry-run"]) {
  console.log("dry-run: no changes written");
  db.close();
  process.exit(0);
}

const backupPath = `${args.values.db}.pre-c1-dedupe-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`;
await db.backup(backupPath);
console.log(`backup written: ${backupPath}`);

const affected = [...new Set(kept.map((group) => group.conversationId))];
const deleteStmt = db.prepare("DELETE FROM conversation_messages WHERE rowid = ?");
const refresh = db.prepare(`
  UPDATE conversation_sessions
  SET message_count = (SELECT COUNT(*) FROM conversation_messages WHERE conversation_id = conversation_sessions.conversation_id)
  WHERE conversation_id = ?
`);
let deleted = 0;
const chunk = 500;
const tx = db.transaction(() => {
  for (let i = 0; i < doomed.length; i += chunk) {
    db.transaction(() => {
      for (const rowid of doomed.slice(i, i + chunk)) deleted += deleteStmt.run(rowid).changes;
    })();
  }
  for (const conversationId of affected) refresh.run(conversationId);
});
tx();

const remaining = db.prepare("SELECT COUNT(*) AS n FROM conversation_messages WHERE message_id IS NULL").get().n;
const total = db.prepare("SELECT COUNT(*) AS n FROM conversation_messages").get().n;
console.log(`done. deleted=${deleted}; remaining NULL rows: ${remaining} (expected ${kept.length}); table total: ${total}`);
if (remaining !== kept.length) {
  console.error("unexpected remaining count; inspect backup before retrying");
  process.exit(1);
}
for (const row of db.prepare(`
  SELECT s.conversation_id, s.message_count,
         (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = s.conversation_id) AS actual
  FROM conversation_sessions s
  WHERE s.conversation_id IN (${affected.map(() => "?").join(",")})
`).all(...affected)) {
  console.log(`  session ${row.conversation_id} message_count=${row.message_count} actual=${row.actual} ${row.message_count === row.actual ? "ok" : "MISMATCH"}`);
}
db.close();
