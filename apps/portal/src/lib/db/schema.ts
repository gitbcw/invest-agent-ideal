import type { Database } from "better-sqlite3";

/**
 * Shared-database schema for the Portal (merged with runtime DB, 2026-08-15).
 *
 * The Portal opens the SAME SQLite file as the runtime process. Auth tables
 * carry a `portal_` prefix to avoid colliding with the runtime's own `users`
 * and audit tables. Conversation content is read directly from the runtime's
 * authoritative `conversation_sessions` / `conversation_messages` tables;
 * the Portal only stores presentation metadata (pin/archive/label/custom
 * title) in a thin `portal_conversation_meta` table.
 */

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS portal_users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    assistant_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    display_name TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_portal_users_username ON portal_users(username)`,

  `CREATE TABLE IF NOT EXISTS portal_password_reset_audit (
    id TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL,
    operator_role TEXT NOT NULL,
    target_user_id TEXT NOT NULL,
    target_username TEXT NOT NULL,
    temporary_password_set INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_portal_password_reset_audit_target ON portal_password_reset_audit(target_user_id)`,

  `CREATE TABLE IF NOT EXISTS portal_password_change_audit (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_portal_password_change_audit_user ON portal_password_change_audit(user_id)`,

  `CREATE TABLE IF NOT EXISTS portal_auth_events (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    username TEXT,
    event TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    details TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_portal_auth_events_user ON portal_auth_events(user_id)`,

  `CREATE TABLE IF NOT EXISTS portal_conversation_meta (
    conversation_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    assistant_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    title_override TEXT,
    pinned_at TEXT,
    archived_at TEXT,
    deleted_at TEXT,
    label_id TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_portal_conversation_meta_user
    ON portal_conversation_meta(user_id, assistant_id, deleted_at, archived_at, pinned_at, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_portal_conversation_meta_label
    ON portal_conversation_meta(user_id, assistant_id, label_id, position)`,

  `CREATE TABLE IF NOT EXISTS conversation_labels (
    label_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    assistant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, assistant_id, name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_labels_owner ON conversation_labels(user_id, assistant_id, position, created_at)`,


  // Runtime tables the Portal reads from — created with IF NOT EXISTS so
  // they co-exist with the runtime process's own schema initialization.
  `CREATE TABLE IF NOT EXISTS conversation_sessions (
    conversation_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'invest-agent',
    instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
    assistant_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'web',
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_sessions_scope
    ON conversation_sessions(instance_id, assistant_id, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS conversation_messages (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'invest-agent',
    instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
    assistant_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'web',
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'sent',
    trace_id TEXT,
    request_id TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv
    ON conversation_messages(conversation_id, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_messages_status
    ON conversation_messages(conversation_id, status)`,

  `CREATE TABLE IF NOT EXISTS ai_instances (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'invest-agent',
    name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    config TEXT NOT NULL DEFAULT '{}',
    instance_expansion_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS portal_conversation_reconciliation (
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    assistant_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    user_message_id TEXT,
    request_id TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    reason TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, assistant_id, instance_id, conversation_id)
  )`,
];

export function initializeSchema(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const stmt of SCHEMA_STATEMENTS) {
    db.exec(stmt);
  }
  // The runtime's conversation_messages table needs a metadata_json column
  // for Portal-specific message metadata (inline visuals, attachments).
  ensureColumn(db, "conversation_messages", "metadata_json", "TEXT");
}

function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
