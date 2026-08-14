import type { Database } from "better-sqlite3";

/**
 * SQLite schema 初始化。
 *
 * 与 invest-agent-ideal 不共享数据库,本数据库只服务于云端门户。
 *
 * 表设计:
 * - users:账号密码,以及与 assistantId/instanceId 的绑定。
 * - password_reset_audit:管理员重置密码的审计记录。
 * - password_change_audit:用户改密的审计记录。
 * - conversation_mirror:云端镜像会话(来自 connector sync 或本地拉取)。
 * - conversation_message_mirror:云端镜像消息(按 messageId 幂等)。
 * - conversation_reconciliation:超时/断线后的待协调会话标记。
 * - auth_events:登录/登出/失败事件审计。
 */

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
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
  `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`,

  `CREATE TABLE IF NOT EXISTS password_reset_audit (
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
  `CREATE INDEX IF NOT EXISTS idx_password_reset_audit_target ON password_reset_audit(target_user_id)`,

  `CREATE TABLE IF NOT EXISTS password_change_audit (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_password_change_audit_user ON password_change_audit(user_id)`,

  `CREATE TABLE IF NOT EXISTS auth_events (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    username TEXT,
    event TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    details TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_events_user ON auth_events(user_id)`,

  `CREATE TABLE IF NOT EXISTS conversation_mirror (
    conversation_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    assistant_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    title TEXT NOT NULL,
    title_override TEXT,
    last_message_preview TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sync_cursor TEXT,
    pinned_at TEXT,
    archived_at TEXT,
    deleted_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_mirror_user ON conversation_mirror(user_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_mirror_assistant ON conversation_mirror(assistant_id, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS conversation_message_mirror (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    assistant_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    trace_id TEXT,
    request_id TEXT,
    created_at TEXT NOT NULL,
    metadata_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_message_mirror_conv ON conversation_message_mirror(conversation_id, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_message_mirror_request ON conversation_message_mirror(request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_message_mirror_trace ON conversation_message_mirror(trace_id)`,

  `CREATE TABLE IF NOT EXISTS conversation_reconciliation (
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
  `CREATE INDEX IF NOT EXISTS idx_conversation_reconciliation_assistant
    ON conversation_reconciliation(assistant_id, state, updated_at ASC)`,

  `CREATE TABLE IF NOT EXISTS mirror_cursor (
    assistant_id TEXT PRIMARY KEY,
    last_sync_at TEXT NOT NULL,
    last_sync_cursor TEXT
  )`,
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
  `CREATE INDEX IF NOT EXISTS idx_conversation_labels_owner ON conversation_labels(user_id, assistant_id, position, created_at)`
];

export function initializeSchema(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const stmt of SCHEMA_STATEMENTS) {
    db.exec(stmt);
  }
  ensureColumn(db, "conversation_mirror", "title_override", "TEXT");
  ensureColumn(db, "conversation_mirror", "pinned_at", "TEXT");
  ensureColumn(db, "conversation_mirror", "archived_at", "TEXT");
  ensureColumn(db, "conversation_mirror", "deleted_at", "TEXT");
  ensureColumn(db, "conversation_mirror", "label_id", "TEXT");
  ensureColumn(db, "conversation_mirror", "position", "INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_conversation_mirror_label ON conversation_mirror(user_id, assistant_id, label_id, position)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_conversation_mirror_user_state ON conversation_mirror(user_id, assistant_id, instance_id, deleted_at, archived_at, pinned_at, updated_at DESC)");
  // Older connector syncs stored the runtime user ID on message rows. The
  // Portal conversation owner is the authoritative scope for its mirror.
  db.prepare(`
    UPDATE conversation_message_mirror AS message
    SET user_id = conversation.user_id
    FROM conversation_mirror AS conversation
    WHERE message.conversation_id = conversation.conversation_id
      AND message.assistant_id = conversation.assistant_id
      AND message.instance_id = conversation.instance_id
      AND message.user_id <> conversation.user_id
  `).run();
}

function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
