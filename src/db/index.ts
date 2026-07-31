import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID, defaultInstanceIdForUser } from "../lib/user-context.js";
import { hashPlatformPassword } from "../lib/platform-password.js";

// 确保数据库目录存在
mkdirSync(dirname(config.db.path), { recursive: true });

export const sqlite: any = new Database(config.db.path);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

// 初始化表
export function initDb() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      key TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      backend TEXT NOT NULL DEFAULT 'hermes',
      external_account_id TEXT NOT NULL,
      state_dir TEXT,
      display_name TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      backend TEXT,
      external_user_id TEXT NOT NULL,
      external_account_id TEXT,
      last_conversation_id TEXT,
      last_context_token TEXT,
      welcomed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS ai_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_instances (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      backend TEXT NOT NULL DEFAULT 'hermes',
      skill_bundle_id TEXT,
      config TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES ai_projects(id),
      FOREIGN KEY(owner_user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS channel_identity_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_identity_id INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(channel_identity_id) REFERENCES channel_identities(id),
      FOREIGN KEY(project_id) REFERENCES ai_projects(id),
      FOREIGN KEY(instance_id) REFERENCES ai_instances(id)
    );
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      added_at TEXT NOT NULL,
      reason TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      UNIQUE(user_id, instance_id, stock_code)
    );
    CREATE TABLE IF NOT EXISTS portfolio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      buy_date TEXT NOT NULL,
      buy_price REAL,
      sell_price REAL,
      sell_date TEXT,
      status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE TABLE IF NOT EXISTS stock_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      support REAL,
      resistance REAL,
      target_price REAL,
      stop_loss REAL,
      notes TEXT,
      watch_conditions TEXT,
      linked_alert_rule_ids TEXT,
      plan_type TEXT NOT NULL DEFAULT 'manual',
      strategy_key TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, instance_id, stock_code)
    );
    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      conversation_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_sessions (
      conversation_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'primary',
      project_id TEXT NOT NULL DEFAULT 'invest-agent',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      assistant_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      channel TEXT NOT NULL DEFAULT 'web',
      title TEXT NOT NULL,
      last_message_preview TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_messages (
      message_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'primary',
      project_id TEXT NOT NULL DEFAULT 'invest-agent',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      assistant_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      channel TEXT NOT NULL DEFAULT 'web',
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      trace_id TEXT,
      request_id TEXT,
      idempotency_key TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversation_sessions(conversation_id)
    );
    CREATE TABLE IF NOT EXISTS daily_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      plan_date TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      summary TEXT,
      content TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS investment_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      style TEXT,
      selected_style_pack TEXT,
      custom_style TEXT NOT NULL DEFAULT '{}',
      risk_preference TEXT,
      investment_horizon TEXT,
      markets TEXT NOT NULL DEFAULT '[]',
      allocation TEXT NOT NULL DEFAULT '{}',
      position_roles TEXT NOT NULL DEFAULT '{}',
      buy_rules TEXT NOT NULL DEFAULT '[]',
      sell_rules TEXT NOT NULL DEFAULT '[]',
      rebalance_rules TEXT NOT NULL DEFAULT '[]',
      risk_rules TEXT NOT NULL DEFAULT '[]',
      notification_policy TEXT NOT NULL DEFAULT '{}',
      decision_policy TEXT NOT NULL DEFAULT '{}',
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, instance_id)
    );
    CREATE TABLE IF NOT EXISTS methodology_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      fundamental_method TEXT NOT NULL DEFAULT '',
      technical_method TEXT NOT NULL DEFAULT '',
      macro_method TEXT NOT NULL DEFAULT '',
      risk_method TEXT NOT NULL DEFAULT '',
      source_policy TEXT NOT NULL DEFAULT '{}',
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, instance_id)
    );
    CREATE TABLE IF NOT EXISTS method_change_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      source_review_id TEXT,
      source_type TEXT NOT NULL DEFAULT 'review',
      proposed_change TEXT NOT NULL,
      reason TEXT NOT NULL,
      affected_resource TEXT NOT NULL DEFAULT 'methodology_profile',
      status TEXT NOT NULL DEFAULT 'proposed',
      decision_note TEXT,
      confirmed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_viewpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      source_date TEXT NOT NULL,
      viewpoint_id TEXT NOT NULL,
      view TEXT NOT NULL,
      reason TEXT NOT NULL,
      action TEXT NOT NULL,
      validation TEXT NOT NULL,
      expected_review_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, instance_id, source_date, viewpoint_id)
    );
    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      event_date TEXT NOT NULL,
      event_type TEXT NOT NULL,
      signal_key TEXT NOT NULL,
      message TEXT NOT NULL,
      relation_to_plan TEXT NOT NULL DEFAULT '未找到预案',
      severity TEXT NOT NULL DEFAULT 'medium',
      price REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      feedback TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alert_signal_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      signal_key TEXT NOT NULL,
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      last_price REAL,
      activated_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, instance_id, signal_key)
    );
    CREATE TABLE IF NOT EXISTS trade_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      stock_code TEXT NOT NULL,
      action TEXT NOT NULL,
      price REAL,
      quantity INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id TEXT NOT NULL DEFAULT 'primary',
      user_id TEXT NOT NULL,
      user_message TEXT NOT NULL,
      mode TEXT NOT NULL,
      tool_name TEXT,
      tool_args TEXT,
      tool_result TEXT,
      final_reply TEXT NOT NULL,
      memory_before TEXT,
      memory_after TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codex_acp_traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      project_id TEXT NOT NULL DEFAULT 'invest-agent',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      conversation_id TEXT NOT NULL,
      message_id TEXT,
      channel TEXT NOT NULL,
      user_text TEXT NOT NULL,
      prompt_text TEXT,
      reply_text_raw TEXT,
      reply_text_sanitized TEXT,
      mode TEXT NOT NULL,
      review_context_summary TEXT,
      sandbox_token_id TEXT,
      sandbox_permissions TEXT,
      acp_backend TEXT,
      acp_model TEXT,
      mcp_manifest TEXT,
      tool_calls TEXT,
      prompt_chars INTEGER,
      reply_chars INTEGER,
      status TEXT NOT NULL,
      error_message TEXT,
      elapsed_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      thought_tokens INTEGER,
      cached_read_tokens INTEGER,
      cached_write_tokens INTEGER,
      total_tokens INTEGER,
      context_window_used INTEGER,
      context_window_size INTEGER,
      cost_amount REAL,
      cost_currency TEXT,
      usage_source TEXT,
      usage_raw TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS indicator_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'stock',
      timeframe TEXT NOT NULL,
      formula_type TEXT NOT NULL,
      formula TEXT NOT NULL,
      params_schema TEXT NOT NULL DEFAULT '{}',
      output_schema TEXT NOT NULL DEFAULT '{}',
      data_requirements TEXT NOT NULL DEFAULT '[]',
      reliability TEXT NOT NULL DEFAULT 'stable',
      enabled INTEGER NOT NULL DEFAULT 1,
      owner TEXT NOT NULL DEFAULT 'system',
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS indicator_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      indicator_key TEXT NOT NULL,
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      calculated_at TEXT NOT NULL,
      data_time TEXT NOT NULL,
      value TEXT NOT NULL,
      level TEXT,
      confidence TEXT,
      explanation TEXT,
      source_snapshot TEXT NOT NULL DEFAULT '{}',
      missing_data TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS alert_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      indicator_key TEXT NOT NULL,
      condition TEXT NOT NULL,
      params TEXT NOT NULL DEFAULT '{}',
      schedule TEXT NOT NULL DEFAULT 'intraday',
      dedupe_policy TEXT NOT NULL DEFAULT '{}',
      severity TEXT NOT NULL DEFAULT 'medium',
      relation_to_plan TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sandbox_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT 'invest-agent',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      role TEXT NOT NULL,
      channel TEXT NOT NULL,
      backend TEXT,
      conversation_id TEXT,
      token_id TEXT,
      operation TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      request_body TEXT NOT NULL DEFAULT '{}',
      result_summary TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_sandbox_confirmations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT 'invest-agent',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      role TEXT NOT NULL,
      channel TEXT NOT NULL,
      backend TEXT,
      conversation_id TEXT,
      requested_token_id TEXT,
      confirmed_token_id TEXT,
      operation TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      request_body TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS onboarding_drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT 'invest-agent',
      instance_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'collecting',
      steps_json TEXT NOT NULL DEFAULT '{}',
      commit_snapshot_json TEXT,
      commit_key TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      queued_at TEXT,
      handoff_message_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      notified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT 'invest-agent',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      conversation_id TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'weixin-mobile',
      backend TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      title TEXT NOT NULL,
      summary TEXT,
      draft_payload TEXT NOT NULL DEFAULT '{}',
      target_operation TEXT NOT NULL,
      result_summary TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'primary',
      project_id TEXT NOT NULL DEFAULT 'invest-agent',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      channel TEXT NOT NULL DEFAULT 'weixin-mobile',
      backend TEXT NOT NULL DEFAULT 'hermes',
      source TEXT NOT NULL DEFAULT 'scheduler',
      idempotency_key TEXT,
      message_kind TEXT,
      expires_at TEXT,
      origin_task_key TEXT,
      retry_policy TEXT,
      terminal_reason TEXT,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_retry_at TEXT NOT NULL,
      last_attempt_at TEXT,
      sent_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS weixin_delivery_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      external_account_id TEXT,
      push_job_id TEXT,
      source TEXT NOT NULL,
      probe INTEGER NOT NULL DEFAULT 0,
      result TEXT NOT NULL,
      reason TEXT NOT NULL,
      error_message TEXT,
      conversation_id TEXT,
      last_inbound_at TEXT,
      elapsed_since_last_inbound_ms INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_watch_snapshots (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT 'invest-agent',
      instance_id TEXT NOT NULL, trading_date TEXT NOT NULL DEFAULT '', window_key TEXT NOT NULL, captured_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL, delta_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      task_key TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'primary',
      project_id TEXT NOT NULL DEFAULT 'invest-agent',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      scheduled_for TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'claimed',
      claimed_at TEXT NOT NULL,
      finished_at TEXT,
      error_message TEXT,
      push_job_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      next_retry_at TEXT,
      lease_expires_at TEXT,
      expires_at TEXT,
      error_class TEXT,
      artifact_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      must_change_password INTEGER NOT NULL DEFAULT 1,
      failed_login_count INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      permissions_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_user_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform_user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_sessions (
      id TEXT PRIMARY KEY,
      platform_user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_login_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform_user_id TEXT,
      username TEXT NOT NULL,
      result TEXT NOT NULL,
      reason TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_admin_audit_logs (
      id TEXT PRIMARY KEY,
      platform_user_id TEXT,
      role TEXT,
      action TEXT NOT NULL,
      route TEXT NOT NULL,
      permission TEXT,
      target_customer_key TEXT,
      request_id TEXT,
      ip_address TEXT,
      user_agent TEXT,
      status TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_artifacts (
      artifact_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT 'invest-agent',
      assistant_id TEXT NOT NULL,
      conversation_id TEXT,
      message_id TEXT,
      turn_id TEXT,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      preview_mode TEXT NOT NULL,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      checksum TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_artifact_events (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      instance_id TEXT,
      event TEXT NOT NULL,
      status TEXT,
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_turn_active (
      user_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      PRIMARY KEY (user_id, instance_id, conversation_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_attachments (
      attachment_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      checksum TEXT,
      retention_class TEXT NOT NULL DEFAULT 'transient_upload',
      stored_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      deleted_at TEXT,
      delete_reason TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_lifecycle_events (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      instance_id TEXT,
      event TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      summary_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifact_delete_confirmations (
      token_id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      checksum TEXT,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'prepared',
      trash_relative_path TEXT,
      purge_at TEXT,
      deleted_versions INTEGER,
      error_code TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  ensureDefaultUser();
  ensureDefaultAiInstance();
  ensurePlatformAuthSeed();
  normalizeRuntimeBackendToCodex();
  migrateWatchlistForUsers();
  migrateStockPlansForUsers();
  migrateAlertSignalStatesForUsers();
  migrateWatchlistForInstances();
  migrateStockPlansForInstances();
  migrateAlertSignalStatesForInstances();
  ensureColumn("watchlist", "source", "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn("portfolio", "user_id", "TEXT NOT NULL DEFAULT 'primary'");
  ensureColumn("portfolio", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("portfolio", "status", "TEXT NOT NULL DEFAULT 'open'");
  ensureColumn("portfolio", "buy_price", "REAL");
  ensureColumn("alert_rules", "user_id", "TEXT NOT NULL DEFAULT 'primary'");
  ensureColumn("alert_rules", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("alert_events", "feedback", "TEXT");
  ensureColumn("alert_events", "user_id", "TEXT NOT NULL DEFAULT 'primary'");
  ensureColumn("alert_events", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("chat_history", "user_id", "TEXT NOT NULL DEFAULT 'primary'");
  ensureColumn("chat_history", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("chat_history", "conversation_id", "TEXT");
  ensureColumn("conversation_sessions", "project_id", "TEXT NOT NULL DEFAULT 'invest-agent'");
  ensureColumn("conversation_sessions", "assistant_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("conversation_sessions", "status", "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn("conversation_sessions", "metadata", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("conversation_messages", "project_id", "TEXT NOT NULL DEFAULT 'invest-agent'");
  ensureColumn("conversation_messages", "assistant_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("conversation_messages", "trace_id", "TEXT");
  ensureColumn("conversation_messages", "request_id", "TEXT");
  ensureColumn("conversation_messages", "idempotency_key", "TEXT");
  ensureColumn("conversation_messages", "metadata", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("conversation_artifacts", "turn_id", "TEXT");
  // Portal file-retention governance (additive, nullable). Backfill assigns
  // these values; rows left NULL behave as they did before the migration.
  ensureColumn("conversation_artifacts", "origin", "TEXT");
  ensureColumn("conversation_artifacts", "retention_class", "TEXT");
  ensureColumn("conversation_artifacts", "visibility", "TEXT");
  ensureColumn("conversation_artifacts", "expires_at", "TEXT");
  ensureColumn("conversation_artifacts", "deleted_at", "TEXT");
  ensureColumn("conversation_artifacts", "deleted_by", "TEXT");
  ensureColumn("conversation_artifacts", "delete_reason", "TEXT");
  ensureColumn("conversation_artifacts", "trash_relative_path", "TEXT");
  ensureColumn("conversation_artifacts", "purge_at", "TEXT");
  ensureColumn("daily_plans", "user_id", "TEXT NOT NULL DEFAULT 'primary'");
  ensureColumn("daily_plans", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("investment_profiles", "user_id", "TEXT NOT NULL DEFAULT 'primary'");
  ensureColumn("investment_profiles", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("methodology_profiles", "user_id", "TEXT NOT NULL DEFAULT 'primary'");
  ensureColumn("methodology_profiles", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("method_change_candidates", "user_id", "TEXT NOT NULL DEFAULT 'primary'");
  ensureColumn("method_change_candidates", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("review_viewpoints", "user_id", "TEXT NOT NULL DEFAULT 'primary'");
  ensureColumn("review_viewpoints", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("review_viewpoints", "resolution", "TEXT");
  ensureColumn("review_viewpoints", "resolved_at", "TEXT");
  ensureColumn("trade_actions", "user_id", "TEXT NOT NULL DEFAULT 'primary'");
  ensureColumn("trade_actions", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("agent_traces", "owner_user_id", "TEXT NOT NULL DEFAULT 'primary'");
  ensureColumn("codex_acp_traces", "user_id", "TEXT NOT NULL DEFAULT 'primary'");
  ensureColumn("codex_acp_traces", "project_id", "TEXT NOT NULL DEFAULT 'invest-agent'");
  ensureColumn("codex_acp_traces", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("codex_acp_traces", "sandbox_token_id", "TEXT");
  ensureColumn("codex_acp_traces", "sandbox_permissions", "TEXT");
  ensureColumn("codex_acp_traces", "acp_backend", "TEXT");
  ensureColumn("codex_acp_traces", "acp_model", "TEXT");
  ensureColumn("codex_acp_traces", "mcp_manifest", "TEXT");
  ensureColumn("codex_acp_traces", "tool_calls", "TEXT");
  ensureColumn("codex_acp_traces", "prompt_chars", "INTEGER");
  ensureColumn("codex_acp_traces", "reply_chars", "INTEGER");
  ensureColumn("codex_acp_traces", "input_tokens", "INTEGER");
  ensureColumn("codex_acp_traces", "output_tokens", "INTEGER");
  ensureColumn("codex_acp_traces", "thought_tokens", "INTEGER");
  ensureColumn("codex_acp_traces", "cached_read_tokens", "INTEGER");
  ensureColumn("codex_acp_traces", "cached_write_tokens", "INTEGER");
  ensureColumn("codex_acp_traces", "total_tokens", "INTEGER");
  ensureColumn("codex_acp_traces", "context_window_used", "INTEGER");
  ensureColumn("codex_acp_traces", "context_window_size", "INTEGER");
  ensureColumn("codex_acp_traces", "cost_amount", "REAL");
  ensureColumn("codex_acp_traces", "cost_currency", "TEXT");
  ensureColumn("codex_acp_traces", "usage_source", "TEXT");
  ensureColumn("codex_acp_traces", "usage_raw", "TEXT");
  ensureColumn("sandbox_audit_logs", "project_id", "TEXT NOT NULL DEFAULT 'invest-agent'");
  ensureColumn("sandbox_audit_logs", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("pending_sandbox_confirmations", "project_id", "TEXT NOT NULL DEFAULT 'invest-agent'");
  ensureColumn("pending_sandbox_confirmations", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("onboarding_drafts", "project_id", "TEXT NOT NULL DEFAULT 'invest-agent'");
  ensureColumn("onboarding_drafts", "handoff_message_id", "TEXT");
  ensureColumn("conversation_tasks", "project_id", "TEXT NOT NULL DEFAULT 'invest-agent'");
  ensureColumn("conversation_tasks", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("channel_identities", "welcomed_at", "TEXT");
  ensureColumn("push_jobs", "project_id", "TEXT NOT NULL DEFAULT 'invest-agent'");
  ensureColumn("push_jobs", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("push_jobs", "idempotency_key", "TEXT");
  ensureColumn("push_jobs", "message_kind", "TEXT");
  ensureColumn("push_jobs", "expires_at", "TEXT");
  ensureColumn("push_jobs", "origin_task_key", "TEXT");
  ensureColumn("push_jobs", "retry_policy", "TEXT");
  ensureColumn("push_jobs", "terminal_reason", "TEXT");
  ensureColumn("weixin_delivery_attempts", "external_account_id", "TEXT");
  ensureColumn("market_watch_snapshots", "trading_date", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("scheduled_task_runs", "project_id", "TEXT NOT NULL DEFAULT 'invest-agent'");
  ensureColumn("scheduled_task_runs", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("scheduled_task_runs", "push_job_id", "TEXT");
  ensureColumn("scheduled_task_runs", "attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("scheduled_task_runs", "max_attempts", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn("scheduled_task_runs", "next_retry_at", "TEXT");
  ensureColumn("scheduled_task_runs", "lease_expires_at", "TEXT");
  ensureColumn("scheduled_task_runs", "expires_at", "TEXT");
  ensureColumn("scheduled_task_runs", "error_class", "TEXT");
  ensureColumn("scheduled_task_runs", "artifact_ref", "TEXT");
  ensureColumn("indicator_results", "user_id", "TEXT NOT NULL DEFAULT 'primary'");
  ensureColumn("indicator_results", "instance_id", "TEXT NOT NULL DEFAULT 'invest-agent-primary'");
  ensureColumn("stock_plans", "watch_conditions", "TEXT");
  ensureColumn("stock_plans", "linked_alert_rule_ids", "TEXT");
  ensureColumn("stock_plans", "plan_type", "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn("stock_plans", "strategy_key", "TEXT");
  dropColumnIfExists("portfolio", "quantity");
  backfillHistoricalInstanceAssignments();
  migrateConversationIdempotencyScope();
  backfillOnboardingDraftHandoffs();
  dropLegacyAlertsTable();
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_users_username ON platform_users(username);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_roles_name ON platform_roles(name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_user_roles_user_role ON platform_user_roles(platform_user_id, role_id);
    CREATE INDEX IF NOT EXISTS idx_platform_sessions_user_expiry ON platform_sessions(platform_user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_platform_sessions_expiry ON platform_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_platform_login_events_username_time ON platform_login_events(username, created_at);
    CREATE INDEX IF NOT EXISTS idx_platform_admin_audit_time ON platform_admin_audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_platform_admin_audit_actor_time ON platform_admin_audit_logs(platform_user_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_accounts_unique ON channel_accounts(channel, backend, external_account_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_identities_unique ON channel_identities(channel, external_user_id);
    CREATE INDEX IF NOT EXISTS idx_ai_instances_project_owner ON ai_instances(project_id, owner_user_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_identity_instances_default ON channel_identity_instances(channel_identity_id, project_id, is_default);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_investment_profiles_scope ON investment_profiles(user_id, instance_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_methodology_profiles_scope ON methodology_profiles(user_id, instance_id);
    CREATE INDEX IF NOT EXISTS idx_method_change_candidates_scope_status ON method_change_candidates(user_id, instance_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_watchlist_user_stock ON watchlist(user_id, stock_code);
    CREATE INDEX IF NOT EXISTS idx_watchlist_instance_user_stock ON watchlist(instance_id, user_id, stock_code);
    CREATE INDEX IF NOT EXISTS idx_portfolio_user_status ON portfolio(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_portfolio_user_stock_open ON portfolio(user_id, stock_code, sell_date);
    CREATE INDEX IF NOT EXISTS idx_portfolio_instance_user_status ON portfolio(instance_id, user_id, status);
    CREATE INDEX IF NOT EXISTS idx_stock_plans_user_stock ON stock_plans(user_id, stock_code);
    CREATE INDEX IF NOT EXISTS idx_stock_plans_instance_user_stock ON stock_plans(instance_id, user_id, stock_code);
    CREATE INDEX IF NOT EXISTS idx_daily_plans_date ON daily_plans(plan_date);
    CREATE INDEX IF NOT EXISTS idx_daily_plans_user_date ON daily_plans(user_id, plan_date);
    CREATE INDEX IF NOT EXISTS idx_daily_plans_instance_user_date ON daily_plans(instance_id, user_id, plan_date);
    CREATE INDEX IF NOT EXISTS idx_review_viewpoints_scope_status ON review_viewpoints(instance_id, user_id, status, expected_review_date);
    CREATE INDEX IF NOT EXISTS idx_review_viewpoints_scope_source ON review_viewpoints(instance_id, user_id, source_date);
    CREATE INDEX IF NOT EXISTS idx_alert_events_date_code ON alert_events(event_date, stock_code);
    CREATE INDEX IF NOT EXISTS idx_alert_events_user_date_code ON alert_events(user_id, event_date, stock_code);
    CREATE INDEX IF NOT EXISTS idx_alert_events_instance_user_date_code ON alert_events(instance_id, user_id, event_date, stock_code);
    CREATE INDEX IF NOT EXISTS idx_alert_events_signal ON alert_events(signal_key, created_at);
    CREATE INDEX IF NOT EXISTS idx_alert_signal_states_stock ON alert_signal_states(stock_code, active);
    CREATE INDEX IF NOT EXISTS idx_alert_signal_states_user_signal ON alert_signal_states(user_id, signal_key);
    CREATE INDEX IF NOT EXISTS idx_alert_signal_states_instance_user_signal ON alert_signal_states(instance_id, user_id, signal_key);
    CREATE INDEX IF NOT EXISTS idx_agent_traces_user ON agent_traces(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_codex_acp_traces_conversation ON codex_acp_traces(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_codex_acp_traces_user_conversation ON codex_acp_traces(user_id, conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_codex_acp_traces_instance ON codex_acp_traces(instance_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_codex_acp_traces_status ON codex_acp_traces(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_sessions_scope_time ON conversation_sessions(instance_id, user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_sessions_channel_time ON conversation_sessions(channel, updated_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_time ON conversation_messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_messages_scope_time ON conversation_messages(instance_id, user_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_idempotency ON conversation_messages(user_id, instance_id, conversation_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_conversation_tasks_scope_status ON conversation_tasks(instance_id, user_id, conversation_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_indicator_definitions_key ON indicator_definitions(key);
    CREATE INDEX IF NOT EXISTS idx_indicator_results_key_stock_time ON indicator_results(indicator_key, stock_code, data_time);
    CREATE INDEX IF NOT EXISTS idx_indicator_results_user_key_stock_time ON indicator_results(user_id, indicator_key, stock_code, data_time);
    CREATE INDEX IF NOT EXISTS idx_indicator_results_instance_user_key_stock_time ON indicator_results(instance_id, user_id, indicator_key, stock_code, data_time);
    CREATE INDEX IF NOT EXISTS idx_alert_rules_stock_enabled ON alert_rules(stock_code, enabled);
    CREATE INDEX IF NOT EXISTS idx_alert_rules_user_stock_enabled ON alert_rules(user_id, stock_code, enabled);
    CREATE INDEX IF NOT EXISTS idx_alert_rules_instance_user_stock_enabled ON alert_rules(instance_id, user_id, stock_code, enabled);
    CREATE INDEX IF NOT EXISTS idx_alert_rules_indicator ON alert_rules(indicator_key);
    CREATE INDEX IF NOT EXISTS idx_sandbox_audit_logs_user_time ON sandbox_audit_logs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sandbox_audit_logs_instance_time ON sandbox_audit_logs(instance_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sandbox_audit_logs_token ON sandbox_audit_logs(token_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sandbox_audit_logs_operation ON sandbox_audit_logs(operation, created_at);
    CREATE INDEX IF NOT EXISTS idx_pending_sandbox_confirmations_user_status ON pending_sandbox_confirmations(user_id, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_pending_sandbox_confirmations_conversation ON pending_sandbox_confirmations(conversation_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_onboarding_drafts_scope_status ON onboarding_drafts(user_id, instance_id, status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_drafts_commit_key ON onboarding_drafts(commit_key) WHERE commit_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_onboarding_drafts_handoff ON onboarding_drafts(status, handoff_message_id, queued_at);
    CREATE INDEX IF NOT EXISTS idx_push_jobs_due ON push_jobs(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_push_jobs_user_time ON push_jobs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_push_jobs_instance_status ON push_jobs(instance_id, status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_push_jobs_backend_status ON push_jobs(backend, status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_push_jobs_expiry_due ON push_jobs(status, expires_at, next_retry_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_push_jobs_idempotency_key ON push_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_weixin_delivery_attempts_scope_time ON weixin_delivery_attempts(instance_id, user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_market_watch_snapshots_scope_time ON market_watch_snapshots(user_id, instance_id, captured_at);
    CREATE INDEX IF NOT EXISTS idx_weixin_delivery_attempts_reason_time ON weixin_delivery_attempts(reason, created_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_scope_time ON scheduled_task_runs(instance_id, user_id, task_type, scheduled_for);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_status ON scheduled_task_runs(status, scheduled_for);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_retry_due ON scheduled_task_runs(status, next_retry_at, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_artifacts_scope_message ON conversation_artifacts(user_id, instance_id, conversation_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_artifacts_turn ON conversation_artifacts(user_id, instance_id, conversation_id, turn_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_artifacts_assistant ON conversation_artifacts(assistant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_artifact_events_artifact ON conversation_artifact_events(artifact_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_artifact_events_scope_time ON conversation_artifact_events(user_id, instance_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_artifacts_library ON conversation_artifacts(user_id, instance_id, visibility, retention_class, deleted_at, updated_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_artifacts_retention ON conversation_artifacts(retention_class, expires_at, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_artifacts_purge ON conversation_artifacts(retention_class, purge_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_attachments_scope ON conversation_attachments(user_id, instance_id, conversation_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_attachments_expiry ON conversation_attachments(expires_at, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_attachments_message ON conversation_attachments(message_id);
    CREATE INDEX IF NOT EXISTS idx_file_lifecycle_events_scope_time ON file_lifecycle_events(user_id, instance_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_file_lifecycle_events_entity ON file_lifecycle_events(entity_type, entity_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_artifact_delete_confirmations_scope ON artifact_delete_confirmations(user_id, instance_id, artifact_id, status);
    CREATE INDEX IF NOT EXISTS idx_artifact_delete_confirmations_expiry ON artifact_delete_confirmations(expires_at, status);
  `);
  logger.info("数据库初始化完成");
}

function ensureDefaultUser() {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO users (id, display_name, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`
    )
    .run(DEFAULT_USER_ID, "默认测试用户", now, now);
}

function ensureDefaultAiInstance() {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO ai_projects (id, name, type, status, description, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`
    )
    .run(DEFAULT_PROJECT_ID, "投资助手", "investment-assistant", "默认投资助手项目类型", now, now);

  sqlite
    .prepare(
      `INSERT OR IGNORE INTO ai_instances (
        id, project_id, owner_user_id, name, status, backend, skill_bundle_id, config, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', 'codex', ?, ?, ?, ?)`
    )
    .run(
      DEFAULT_INSTANCE_ID,
      DEFAULT_PROJECT_ID,
      DEFAULT_USER_ID,
      "默认测试投资助手",
      "invest-agent-default",
      JSON.stringify({ autoCreated: true, role: "default_test_instance" }),
      now,
      now
    );
}

function ensurePlatformAuthSeed() {
  const now = new Date().toISOString();
  if (!hasMigration("platform_auth_v1")) markMigration("platform_auth_v1");
  const ownerPermissions = JSON.stringify(["*"]);
  const partnerPermissions = JSON.stringify(["overview.read", "customers.read", "quality.read", "operations.read", "cost.read"]);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO platform_roles (id, name, permissions_json, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)"
    )
    .run("owner", "Owner", ownerPermissions, now, now, "partner", "Partner", partnerPermissions, now, now);
  // v2: 升级既有 partner 角色权限（加入 cost.read，供成本总览只读）。
  if (!hasMigration("platform_partner_cost_read_v2")) {
    markMigration("platform_partner_cost_read_v2");
    sqlite.prepare("UPDATE platform_roles SET permissions_json=?, updated_at=? WHERE id='partner'")
      .run(partnerPermissions, now);
  }

  const existingUser = sqlite.prepare("SELECT id FROM platform_users LIMIT 1").get() as { id?: string } | undefined;
  if (existingUser?.id) return;

  const username = (process.env.PLATFORM_BOOTSTRAP_USERNAME || "owner").trim();
  let password = process.env.PLATFORM_BOOTSTRAP_PASSWORD?.trim();
  const passwordFile = process.env.PLATFORM_BOOTSTRAP_PASSWORD_FILE || join(config.runtimeData.root, ".platform-bootstrap-password");

  if (!password && existsSync(passwordFile)) {
    password = readFileSync(passwordFile, "utf8").trim();
  }
  if (!password && config.nodeEnv !== "production") {
    password = randomBytes(24).toString("base64url");
    mkdirSync(dirname(passwordFile), { recursive: true });
    writeFileSync(passwordFile, password + "\n", { mode: 0o600 });
    logger.warn("Platform bootstrap 密码已生成并保存到 " + passwordFile + "，不会在日志中打印明文。");
  }
  if (!password) {
    logger.warn("Platform 尚未创建 Owner 账号：请设置 PLATFORM_BOOTSTRAP_PASSWORD 后重启。");
    return;
  }

  const userId = "platform-" + randomBytes(12).toString("hex");
  sqlite
    .prepare(
      "INSERT INTO platform_users (" +
      "id, username, display_name, password_hash, status, must_change_password, " +
      "failed_login_count, created_at, updated_at" +
      ") VALUES (?, ?, ?, ?, 'active', 1, 0, ?, ?)"
    )
    .run(userId, username, "Platform Owner", hashPlatformPassword(password), now, now);
  sqlite
    .prepare(
      "INSERT INTO platform_user_roles (platform_user_id, role_id, created_at) " +
      "VALUES (?, 'owner', ?)"
    )
    .run(userId, now);
  logger.info("Platform Owner 账号已初始化 username=" + username);
}

function normalizeRuntimeBackendToCodex() {
  const migrationKey = "runtime_backend_codex_v1";
  if (hasMigration(migrationKey)) return;
  const legacyBackends = ["hermes", "kimi", "claude"];
  const placeholders = legacyBackends.map(() => "?").join(",");

  const transaction = sqlite.transaction(() => {
    sqlite
      .prepare(`UPDATE settings SET value = 'codex' WHERE key = 'acp_backend' AND value IN (${placeholders})`)
      .run(...legacyBackends);
    for (const table of ["ai_instances", "channel_accounts", "push_jobs"]) {
      if (!hasTable(table) || !hasColumn(table, "backend")) continue;
      sqlite.prepare(`UPDATE ${table} SET backend = 'codex' WHERE backend IN (${placeholders})`).run(...legacyBackends);
    }
    if (hasTable("channel_identities") && hasColumn("channel_identities", "backend")) {
      sqlite.prepare(`UPDATE channel_identities SET backend = 'codex' WHERE backend IN (${placeholders})`).run(...legacyBackends);
    }
    markMigration(migrationKey);
  });
  transaction();
}

function migrateWatchlistForUsers() {
  const columns = tableColumns("watchlist");
  const needsRebuild = !columns.some((c) => c.name === "id") || !columns.some((c) => c.name === "user_id");
  if (!needsRebuild) return;
  const sourceExpr = columns.some((c) => c.name === "source") ? "COALESCE(source, 'manual')" : "'manual'";

  sqlite.exec(`
    ALTER TABLE watchlist RENAME TO watchlist_legacy_user_migration;
    CREATE TABLE watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      added_at TEXT NOT NULL,
      reason TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      UNIQUE(user_id, stock_code)
    );
    INSERT OR IGNORE INTO watchlist (user_id, stock_code, stock_name, added_at, reason, source)
    SELECT 'primary', stock_code, stock_name, added_at, reason, ${sourceExpr}
    FROM watchlist_legacy_user_migration;
    DROP TABLE watchlist_legacy_user_migration;
  `);
  markMigration("watchlist_user_scope_v1");
}

function migrateStockPlansForUsers() {
  const columns = tableColumns("stock_plans");
  const needsRebuild = !columns.some((c) => c.name === "id") || !columns.some((c) => c.name === "user_id");
  if (!needsRebuild) return;
  const watchConditionsExpr = columns.some((c) => c.name === "watch_conditions") ? "watch_conditions" : "NULL";
  const linkedAlertRuleIdsExpr = columns.some((c) => c.name === "linked_alert_rule_ids") ? "linked_alert_rule_ids" : "NULL";
  const planTypeExpr = columns.some((c) => c.name === "plan_type") ? "COALESCE(plan_type, 'manual')" : "'manual'";

  sqlite.exec(`
    ALTER TABLE stock_plans RENAME TO stock_plans_legacy_user_migration;
    CREATE TABLE stock_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      support REAL,
      resistance REAL,
      target_price REAL,
      stop_loss REAL,
      notes TEXT,
      watch_conditions TEXT,
      linked_alert_rule_ids TEXT,
      plan_type TEXT NOT NULL DEFAULT 'manual',
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, stock_code)
    );
    INSERT OR IGNORE INTO stock_plans (
      user_id, stock_code, stock_name, support, resistance, target_price, stop_loss,
      notes, watch_conditions, linked_alert_rule_ids, plan_type, updated_at
    )
    SELECT
      'primary', stock_code, stock_name, support, resistance, target_price, stop_loss,
      notes,
      ${watchConditionsExpr},
      ${linkedAlertRuleIdsExpr},
      ${planTypeExpr},
      updated_at
    FROM stock_plans_legacy_user_migration;
    DROP TABLE stock_plans_legacy_user_migration;
  `);
  markMigration("stock_plans_user_scope_v1");
}

function migrateAlertSignalStatesForUsers() {
  const columns = tableColumns("alert_signal_states");
  const needsRebuild = !columns.some((c) => c.name === "id") || !columns.some((c) => c.name === "user_id");
  if (!needsRebuild) return;

  const transaction = sqlite.transaction(() => {
    sqlite.exec(`
      ALTER TABLE alert_signal_states RENAME TO alert_signal_states_legacy_user_migration;
      CREATE TABLE alert_signal_states (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL DEFAULT 'primary',
        instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
        signal_key TEXT NOT NULL,
        stock_code TEXT NOT NULL,
        stock_name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        last_price REAL,
        activated_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, instance_id, signal_key)
      );
      INSERT OR IGNORE INTO alert_signal_states (
        user_id, instance_id, signal_key, stock_code, stock_name, active, last_price, activated_at, updated_at
      )
      SELECT 'primary', 'invest-agent-primary', signal_key, stock_code, stock_name, active, last_price, activated_at, updated_at
      FROM alert_signal_states_legacy_user_migration;
      DROP TABLE alert_signal_states_legacy_user_migration;
    `);
    markMigration("alert_signal_states_user_scope_v1");
  });
  transaction();
}

function migrateConversationIdempotencyScope() {
  const migrationKey = "conversation_idempotency_scope_v1";
  if (hasMigration(migrationKey)) return;
  const transaction = sqlite.transaction(() => {
    sqlite.exec("DROP INDEX IF EXISTS idx_conversation_messages_idempotency");
    sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_idempotency
      ON conversation_messages(user_id, instance_id, conversation_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);
    markMigration(migrationKey);
  });
  transaction();
}

/** Records the persisted ACP handoff for queued drafts created before the marker existed. */
function backfillOnboardingDraftHandoffs() {
  const migrationKey = "onboarding_draft_handoff_message_v1";
  if (hasMigration(migrationKey)) return;
  const rows = sqlite.prepare(`
    SELECT id, user_id AS userId, instance_id AS instanceId, conversation_id AS conversationId, queued_at AS queuedAt
    FROM onboarding_drafts
    WHERE status = 'queued' AND handoff_message_id IS NULL AND queued_at IS NOT NULL
  `).all() as Array<{ id: string; userId: string; instanceId: string; conversationId: string; queuedAt: string }>;
  const findMessage = sqlite.prepare(`
    SELECT message_id AS messageId FROM conversation_messages
    WHERE user_id = ? AND instance_id = ? AND conversation_id = ? AND role = 'assistant' AND created_at > ?
    ORDER BY created_at ASC LIMIT 1
  `);
  const mark = sqlite.prepare(`
    UPDATE onboarding_drafts SET handoff_message_id = ?, updated_at = ?
    WHERE id = ? AND status = 'queued' AND handoff_message_id IS NULL
  `);
  const now = new Date().toISOString();
  sqlite.transaction(() => {
    for (const row of rows) {
      const message = findMessage.get(row.userId, row.instanceId, row.conversationId, row.queuedAt) as { messageId: string } | undefined;
      if (message) mark.run(message.messageId, now, row.id);
    }
    markMigration(migrationKey);
  })();
}

function migrateWatchlistForInstances() {
  const columns = tableColumns("watchlist");
  if (!columns.some((c) => c.name === "instance_id")) {
    sqlite.exec(`ALTER TABLE watchlist ADD COLUMN instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary'`);
  }
  const indexes = indexList("watchlist");
  const hasInstanceUnique = indexes.some((idx) => idx.unique && indexColumns(idx.name).join(",") === "user_id,instance_id,stock_code");
  if (hasInstanceUnique) {
    backfillInstanceIds("watchlist");
    return;
  }
  sqlite.exec(`
    ALTER TABLE watchlist RENAME TO watchlist_legacy_instance_migration;
    CREATE TABLE watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      added_at TEXT NOT NULL,
      reason TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      UNIQUE(user_id, instance_id, stock_code)
    );
    INSERT OR IGNORE INTO watchlist (id, user_id, instance_id, stock_code, stock_name, added_at, reason, source)
    SELECT id, user_id, instance_id, stock_code, stock_name, added_at, reason, source
    FROM watchlist_legacy_instance_migration;
    DROP TABLE watchlist_legacy_instance_migration;
  `);
  backfillInstanceIds("watchlist");
  markMigration("watchlist_instance_scope_v1");
}

function migrateStockPlansForInstances() {
  const columns = tableColumns("stock_plans");
  if (!columns.some((c) => c.name === "instance_id")) {
    sqlite.exec(`ALTER TABLE stock_plans ADD COLUMN instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary'`);
  }
  const indexes = indexList("stock_plans");
  const hasInstanceUnique = indexes.some((idx) => idx.unique && indexColumns(idx.name).join(",") === "user_id,instance_id,stock_code");
  if (hasInstanceUnique) {
    backfillInstanceIds("stock_plans");
    return;
  }
  sqlite.exec(`
    ALTER TABLE stock_plans RENAME TO stock_plans_legacy_instance_migration;
    CREATE TABLE stock_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      support REAL,
      resistance REAL,
      target_price REAL,
      stop_loss REAL,
      notes TEXT,
      watch_conditions TEXT,
      linked_alert_rule_ids TEXT,
      plan_type TEXT NOT NULL DEFAULT 'manual',
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, instance_id, stock_code)
    );
    INSERT OR IGNORE INTO stock_plans (
      id, user_id, instance_id, stock_code, stock_name, support, resistance, target_price, stop_loss,
      notes, watch_conditions, linked_alert_rule_ids, plan_type, updated_at
    )
    SELECT
      id, user_id, instance_id, stock_code, stock_name, support, resistance, target_price, stop_loss,
      notes, watch_conditions, linked_alert_rule_ids, plan_type, updated_at
    FROM stock_plans_legacy_instance_migration;
    DROP TABLE stock_plans_legacy_instance_migration;
  `);
  backfillInstanceIds("stock_plans");
  markMigration("stock_plans_instance_scope_v1");
}

function migrateAlertSignalStatesForInstances() {
  const columns = tableColumns("alert_signal_states");
  if (!columns.some((c) => c.name === "instance_id")) {
    sqlite.exec(`ALTER TABLE alert_signal_states ADD COLUMN instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary'`);
  }
  const indexes = indexList("alert_signal_states");
  const hasInstanceUnique = indexes.some((idx) => idx.unique && indexColumns(idx.name).join(",") === "user_id,instance_id,signal_key");
  if (hasInstanceUnique) {
    backfillInstanceIds("alert_signal_states");
    return;
  }
  sqlite.exec(`
    ALTER TABLE alert_signal_states RENAME TO alert_signal_states_legacy_instance_migration;
    CREATE TABLE alert_signal_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'primary',
      instance_id TEXT NOT NULL DEFAULT 'invest-agent-primary',
      signal_key TEXT NOT NULL,
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      last_price REAL,
      activated_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, instance_id, signal_key)
    );
    INSERT OR IGNORE INTO alert_signal_states (
      id, user_id, instance_id, signal_key, stock_code, stock_name, active, last_price, activated_at, updated_at
    )
    SELECT id, user_id, instance_id, signal_key, stock_code, stock_name, active, last_price, activated_at, updated_at
    FROM alert_signal_states_legacy_instance_migration;
    DROP TABLE alert_signal_states_legacy_instance_migration;
  `);
  backfillInstanceIds("alert_signal_states");
  markMigration("alert_signal_states_instance_scope_v1");
}

function backfillInstanceIds(table: string) {
  const rows = sqlite.prepare(`SELECT DISTINCT user_id AS userId FROM ${table}`).all() as Array<{ userId: string }>;
  const update = sqlite.prepare(`UPDATE ${table} SET instance_id = ? WHERE user_id = ? AND instance_id = 'invest-agent-primary'`);
  for (const row of rows) {
    update.run(defaultInstanceIdForUser(row.userId), row.userId);
  }
}

function backfillHistoricalInstanceAssignments() {
  const migrationKey = "historical_instance_assignment_v1";
  if (hasMigration(migrationKey)) return;

  const scopedTables = [
    "watchlist",
    "portfolio",
    "alert_rules",
    "stock_plans",
    "chat_history",
    "daily_plans",
    "alert_events",
    "alert_signal_states",
    "trade_actions",
    "codex_acp_traces",
    "sandbox_audit_logs",
    "pending_sandbox_confirmations",
    "push_jobs",
    "indicator_results",
  ].filter((table) => hasTable(table) && hasColumn(table, "user_id") && hasColumn(table, "instance_id"));

  const affectedUsers = new Set<string>();
  for (const table of scopedTables) {
    const rows = sqlite
      .prepare(`SELECT DISTINCT user_id AS userId FROM ${table} WHERE user_id <> ? AND instance_id = ?`)
      .all(DEFAULT_USER_ID, DEFAULT_INSTANCE_ID) as Array<{ userId: string }>;
    for (const row of rows) {
      if (row.userId) affectedUsers.add(row.userId);
    }
  }

  if (affectedUsers.size === 0) {
    markMigration(migrationKey);
    return;
  }

  const now = new Date().toISOString();
  const insertUser = sqlite.prepare(
    `INSERT OR IGNORE INTO users (id, display_name, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`
  );
  const insertInstance = sqlite.prepare(
    `INSERT OR IGNORE INTO ai_instances (
      id, project_id, owner_user_id, name, status, backend, skill_bundle_id, config, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', 'hermes', ?, ?, ?, ?)`
  );

  const transaction = sqlite.transaction(() => {
    for (const userId of affectedUsers) {
      const instanceId = defaultInstanceIdForUser(userId);
      insertUser.run(userId, userId, now, now);
      insertInstance.run(
        instanceId,
        DEFAULT_PROJECT_ID,
        userId,
        `投资助手 ${userId.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || userId}`,
        "invest-agent-default",
        JSON.stringify({ migratedFromUserId: userId, migration: migrationKey }),
        now,
        now
      );
    }

    for (const table of scopedTables) {
      const update = sqlite.prepare(`UPDATE ${table} SET instance_id = ? WHERE user_id = ? AND instance_id = ?`);
      for (const userId of affectedUsers) {
        update.run(defaultInstanceIdForUser(userId), userId, DEFAULT_INSTANCE_ID);
      }
    }

    markMigration(migrationKey);
  });

  transaction();
  logger.info(`历史实例归位完成 users=${affectedUsers.size} tables=${scopedTables.length}`);
}

function hasMigration(key: string) {
  const row = sqlite.prepare("SELECT key FROM schema_migrations WHERE key = ?").get(key);
  return Boolean(row);
}

function markMigration(key: string) {
  sqlite
    .prepare("INSERT OR REPLACE INTO schema_migrations (key, applied_at) VALUES (?, ?)")
    .run(key, new Date().toISOString());
}

function dropLegacyAlertsTable() {
  const migrationKey = "drop_legacy_alerts_table_v1";
  if (hasMigration(migrationKey)) return;
  if (!hasTable("alerts")) {
    markMigration(migrationKey);
    return;
  }
  const rowCount = (
    sqlite.prepare("SELECT COUNT(*) AS n FROM alerts").get() as { n: number }
  ).n;
  if (rowCount > 0) {
    const dumpedRows = archiveLegacyAlerts();
    if (dumpedRows !== rowCount) {
      logger.warn(
        `legacy alerts 归档不完整:表行数 ${rowCount},导出行数 ${dumpedRows};本次保留表结构,请人工核对后重试。`
      );
      return;
    }
    logger.info(
      `legacy alerts 已归档 ${dumpedRows} 行到 ${config.runtimeData.archiveDir},继续 DROP。`
    );
  }
  sqlite.exec("DROP TABLE IF EXISTS alerts");
  markMigration(migrationKey);
  logger.info("legacy alerts 表已迁移删除");
}

function archiveLegacyAlerts(): number {
  const archiveDir = config.runtimeData.archiveDir;
  mkdirSync(archiveDir, { recursive: true });
  const rows = sqlite.prepare("SELECT * FROM alerts").all() as Record<string, unknown>[];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(archiveDir, `alerts-${stamp}.json`);
  writeFileSync(filePath, JSON.stringify(rows, null, 2), "utf-8");
  return rows.length;
}

function ensureColumn(table: string, column: string, definition: string) {
  const columns = tableColumns(table);
  if (!columns.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function dropColumnIfExists(table: string, column: string) {
  const columns = tableColumns(table);
  if (columns.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    logger.info(`迁移:已删除 ${table}.${column}`);
  }
}

function tableColumns(table: string) {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
}

function hasTable(table: string) {
  const row = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return Boolean(row);
}

function hasColumn(table: string, column: string) {
  return tableColumns(table).some((c) => c.name === column);
}

function indexList(table: string) {
  return sqlite.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>;
}

function indexColumns(indexName: string) {
  return sqlite.prepare(`PRAGMA index_info(${indexName})`).all().map((row: any) => row.name as string);
}
