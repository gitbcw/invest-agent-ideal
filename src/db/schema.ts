import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const channelAccounts = sqliteTable("channel_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channel: text("channel").notNull(),
  backend: text("backend").notNull().default("hermes"),
  externalAccountId: text("external_account_id").notNull(),
  stateDir: text("state_dir"),
  displayName: text("display_name"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const channelIdentities = sqliteTable("channel_identities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  channel: text("channel").notNull(),
  backend: text("backend"),
  externalUserId: text("external_user_id").notNull(),
  externalAccountId: text("external_account_id"),
  lastConversationId: text("last_conversation_id"),
  lastContextToken: text("last_context_token"),
  welcomedAt: text("welcomed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const aiProjects = sqliteTable("ai_projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull().default("active"),
  description: text("description"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const aiInstances = sqliteTable("ai_instances", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  backend: text("backend").notNull().default("hermes"),
  skillBundleId: text("skill_bundle_id"),
  config: text("config").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const channelIdentityInstances = sqliteTable("channel_identity_instances", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channelIdentityId: integer("channel_identity_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const watchlist = sqliteTable("watchlist", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("primary"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  stockCode: text("stock_code").notNull(),
  stockName: text("stock_name").notNull(),
  addedAt: text("added_at").notNull(),
  reason: text("reason"),
  source: text("source").notNull().default("manual"),
});

export const portfolio = sqliteTable("portfolio", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("primary"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  stockCode: text("stock_code").notNull(),
  stockName: text("stock_name").notNull(),
  buyDate: text("buy_date").notNull(),
  buyPrice: real("buy_price"),
  sellPrice: real("sell_price"),
  sellDate: text("sell_date"),
  status: text("status").notNull().default("open"),
});

export const stockPlans = sqliteTable("stock_plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("primary"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  stockCode: text("stock_code").notNull(),
  stockName: text("stock_name").notNull(),
  support: real("support"),
  resistance: real("resistance"),
  targetPrice: real("target_price"),
  stopLoss: real("stop_loss"),
  notes: text("notes"),
  watchConditions: text("watch_conditions"),
  linkedAlertRuleIds: text("linked_alert_rule_ids"),
  planType: text("plan_type").notNull().default("manual"),
  /** 溯源:这条预案基于哪份交易策略生成。软引用,策略本体在 trading_strategies.yaml。 */
  strategyKey: text("strategy_key"),
  updatedAt: text("updated_at").notNull(),
});

export const chatHistory = sqliteTable("chat_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("primary"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  conversationId: text("conversation_id"),
  role: text("role").notNull(), // user / assistant
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
});

export const conversationSessions = sqliteTable("conversation_sessions", {
  conversationId: text("conversation_id").primaryKey(),
  userId: text("user_id").notNull().default("primary"),
  projectId: text("project_id").notNull().default("invest-agent"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  assistantId: text("assistant_id").notNull().default("invest-agent-primary"),
  channel: text("channel").notNull().default("web"),
  title: text("title").notNull(),
  lastMessagePreview: text("last_message_preview"),
  messageCount: integer("message_count").notNull().default(0),
  status: text("status").notNull().default("active"),
  metadata: text("metadata").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const conversationMessages = sqliteTable("conversation_messages", {
  messageId: text("message_id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  userId: text("user_id").notNull().default("primary"),
  projectId: text("project_id").notNull().default("invest-agent"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  assistantId: text("assistant_id").notNull().default("invest-agent-primary"),
  channel: text("channel").notNull().default("web"),
  role: text("role").notNull(),
  content: text("content").notNull(),
  status: text("status").notNull().default("sent"),
  traceId: text("trace_id"),
  requestId: text("request_id"),
  idempotencyKey: text("idempotency_key"),
  metadata: text("metadata").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
});

export const conversationTaskRuns = sqliteTable("conversation_task_runs", {
  runId: text("run_id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  requestId: text("request_id").notNull(),
  channel: text("channel").notNull(),
  status: text("status").notNull(),
  attempt: integer("attempt").notNull().default(1),
  responseDeadlineAt: text("response_deadline_at").notNull(),
  executionDeadlineAt: text("execution_deadline_at").notNull(),
  errorCategory: text("error_category"),
  retryable: integer("retryable", { mode: "boolean" }),
  resultMessageId: text("result_message_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  finishedAt: text("finished_at"),
});

export const dailyPlans = sqliteTable("daily_plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("primary"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  planDate: text("plan_date").notNull(),
  generatedAt: text("generated_at").notNull(),
  summary: text("summary"),
  content: text("content").notNull(),
  data: text("data").notNull(), // JSON
});

export const methodologyProfiles = sqliteTable("methodology_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("primary"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  fundamentalMethod: text("fundamental_method").notNull().default(""),
  technicalMethod: text("technical_method").notNull().default(""),
  macroMethod: text("macro_method").notNull().default(""),
  riskMethod: text("risk_method").notNull().default(""),
  sourcePolicy: text("source_policy").notNull().default("{}"),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Mastra-era, service-owned projection of a user project's structured profile.
 * It deliberately does not replace the user's readable methods/project files.
 */
export const mastraProjectProfiles = sqliteTable("mastra_project_profiles", {
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  profileJson: text("profile_json").notNull(),
  sourcePath: text("source_path").notNull(),
  sourceChecksum: text("source_checksum").notNull(),
  sourceRevision: text("source_revision"),
  migrationBatchId: text("migration_batch_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Mastra-era, service-owned projection of the user's current investment state.
 * The complete structured payload preserves fields that legacy row tables
 * cannot represent; it is distinct from any historical Workspace YAML.
 */
export const mastraPortfolioStates = sqliteTable("mastra_portfolio_states", {
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  portfolioJson: text("portfolio_json").notNull(),
  sourcePath: text("source_path").notNull(),
  sourceChecksum: text("source_checksum").notNull(),
  sourceRevision: text("source_revision"),
  migrationBatchId: text("migration_batch_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Mastra-era, service-owned user scheduling, notification and onboarding state. */
export const mastraRuntimePreferences = sqliteTable("mastra_runtime_preferences", {
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  preferencesJson: text("preferences_json").notNull(),
  sourceChecksumsJson: text("source_checksums_json").notNull(),
  sourceRevision: text("source_revision"),
  migrationBatchId: text("migration_batch_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Scope-bound migration ledger for daily state and review/memory records. */
export const mastraReviewMemoryRecords = sqliteTable("mastra_review_memory_records", {
  recordId: text("record_id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  recordType: text("record_type").notNull(),
  businessKey: text("business_key").notNull(),
  payloadJson: text("payload_json").notNull(),
  sourcePath: text("source_path").notNull(),
  sourceLine: integer("source_line"),
  sourceChecksum: text("source_checksum").notNull(),
  migrationBatchId: text("migration_batch_id").notNull(),
  createdAt: text("created_at").notNull(),
});

/** Generic migration asset ledger; supports formats outside the Portal upload contract. */
export const mastraWorkspaceAssetRecords = sqliteTable("mastra_workspace_asset_records", {
  recordId: text("record_id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  sourcePath: text("source_path").notNull(),
  disposition: text("disposition").notNull(),
  retentionClass: text("retention_class").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  checksum: text("checksum").notNull(),
  targetPath: text("target_path").notNull(),
  executable: integer("executable", { mode: "boolean" }).notNull().default(false),
  migrationBatchId: text("migration_batch_id").notNull(),
  createdAt: text("created_at").notNull(),
});

export const methodChangeCandidates = sqliteTable("method_change_candidates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("primary"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  sourceReviewId: text("source_review_id"),
  sourceType: text("source_type").notNull().default("review"),
  proposedChange: text("proposed_change").notNull(),
  reason: text("reason").notNull(),
  affectedResource: text("affected_resource").notNull().default("methodology_profile"),
  status: text("status").notNull().default("proposed"),
  decisionNote: text("decision_note"),
  confirmedAt: text("confirmed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const reviewViewpoints = sqliteTable("review_viewpoints", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("primary"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  sourceDate: text("source_date").notNull(),
  viewpointId: text("viewpoint_id").notNull(),
  view: text("view").notNull(),
  reason: text("reason").notNull(),
  action: text("action").notNull(),
  validation: text("validation").notNull(),
  expectedReviewDate: text("expected_review_date").notNull(),
  status: text("status").notNull().default("open"),
  resolution: text("resolution"),
  resolvedAt: text("resolved_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const alertEvents = sqliteTable("alert_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("primary"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  stockCode: text("stock_code").notNull(),
  stockName: text("stock_name").notNull(),
  eventDate: text("event_date").notNull(),
  eventType: text("event_type").notNull(),
  signalKey: text("signal_key").notNull(),
  message: text("message").notNull(),
  relationToPlan: text("relation_to_plan").notNull().default("未找到预案"),
  severity: text("severity").notNull().default("medium"),
  price: real("price"),
  status: text("status").notNull().default("pending"),
  feedback: text("feedback"),
  createdAt: text("created_at").notNull(),
});

export const alertSignalStates = sqliteTable("alert_signal_states", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("primary"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  signalKey: text("signal_key").notNull(),
  stockCode: text("stock_code").notNull(),
  stockName: text("stock_name").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  lastPrice: real("last_price"),
  activatedAt: text("activated_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const tradeActions = sqliteTable("trade_actions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("primary"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  stockCode: text("stock_code").notNull(),
  action: text("action").notNull(),
  price: real("price"),
  quantity: integer("quantity"),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
});

export const codexAcpTraces = sqliteTable("codex_acp_traces", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("primary"),
  projectId: text("project_id").notNull().default("invest-agent"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  conversationId: text("conversation_id").notNull(),
  messageId: text("message_id"),
  channel: text("channel").notNull(),
  userText: text("user_text").notNull(),
  promptText: text("prompt_text"),
  replyTextRaw: text("reply_text_raw"),
  replyTextSanitized: text("reply_text_sanitized"),
  mode: text("mode").notNull(),
  reviewContextSummary: text("review_context_summary"),
  sandboxTokenId: text("sandbox_token_id"),
  sandboxPermissions: text("sandbox_permissions"),
  acpBackend: text("acp_backend"),
  acpModel: text("acp_model"),
  mcpManifest: text("mcp_manifest"),
  toolCalls: text("tool_calls"),
  promptChars: integer("prompt_chars"),
  replyChars: integer("reply_chars"),
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  elapsedMs: integer("elapsed_ms"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  thoughtTokens: integer("thought_tokens"),
  cachedReadTokens: integer("cached_read_tokens"),
  cachedWriteTokens: integer("cached_write_tokens"),
  totalTokens: integer("total_tokens"),
  contextWindowUsed: integer("context_window_used"),
  contextWindowSize: integer("context_window_size"),
  costAmount: real("cost_amount"),
  costCurrency: text("cost_currency"),
  usageSource: text("usage_source"),
  usageRaw: text("usage_raw"),
  createdAt: text("created_at").notNull(),
});

/** Agent-neutral execution observability. Legacy ACP rows are copied here once on DB open. */
export const agentTraces = sqliteTable("agent_traces", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  traceId: text("trace_id"),
  runId: text("run_id"),
  taskId: text("task_id"),
  userId: text("user_id").notNull().default("primary"),
  projectId: text("project_id").notNull().default("invest-agent"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  conversationId: text("conversation_id").notNull(),
  messageId: text("message_id"),
  channel: text("channel").notNull(),
  userText: text("user_text").notNull(),
  promptText: text("prompt_text"),
  replyTextRaw: text("reply_text_raw"),
  replyTextSanitized: text("reply_text_sanitized"),
  mode: text("mode").notNull(),
  reviewContextSummary: text("review_context_summary"),
  sandboxTokenId: text("sandbox_token_id"),
  sandboxPermissions: text("sandbox_permissions"),
  agentBackend: text("agent_backend"),
  agentModel: text("agent_model"),
  modelSource: text("model_source"),
  toolManifest: text("tool_manifest"),
  toolCalls: text("tool_calls"),
  promptChars: integer("prompt_chars"),
  replyChars: integer("reply_chars"),
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  elapsedMs: integer("elapsed_ms"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  thoughtTokens: integer("thought_tokens"),
  cachedReadTokens: integer("cached_read_tokens"),
  cachedWriteTokens: integer("cached_write_tokens"),
  totalTokens: integer("total_tokens"),
  contextWindowUsed: integer("context_window_used"),
  contextWindowSize: integer("context_window_size"),
  costAmount: real("cost_amount"),
  costCurrency: text("cost_currency"),
  usageSource: text("usage_source"),
  usageRaw: text("usage_raw"),
  createdAt: text("created_at").notNull(),
});

/** External MCP observer evidence; one row per observed tools/call request. */
export const externalMcpToolCalls = sqliteTable("external_mcp_tool_calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull().default("invest-agent"),
  instanceId: text("instance_id").notNull(),
  conversationId: text("conversation_id"),
  /** Per-turn correlation key. Equals the ACP/trace messageId for observer-routed calls. */
  runId: text("run_id"),
  serverId: text("server_id").notNull(),
  toolName: text("tool_name").notNull(),
  requestId: text("request_id"),
  status: text("status").notNull(),
  elapsedMs: integer("elapsed_ms").notNull(),
  inputChars: integer("input_chars"),
  outputChars: integer("output_chars"),
  errorClass: text("error_class"),
  createdAt: text("created_at").notNull(),
});

/**
 * MCP server 运行时启停覆盖 (T-243 Phase 2)。
 * per-server 一行,enabled 覆盖 env 基线 (env 是启动时基线,DB 是运行时覆盖)。
 * reason 记录启停理由 (借鉴 ToolRegistry 的 disable(name, reason) 语义,审计用)。
 */
export const mcpServerOverrides = sqliteTable("mcp_server_overrides", {
  serverId: text("server_id").primaryKey(),
  enabled: integer("enabled").notNull(),
  reason: text("reason"),
  updatedAt: text("updated_at").notNull(),
});

export const indicatorDefinitions = sqliteTable("indicator_definitions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  scope: text("scope").notNull().default("stock"),
  timeframe: text("timeframe").notNull(),
  formulaType: text("formula_type").notNull(),
  formula: text("formula").notNull(),
  paramsSchema: text("params_schema").notNull().default("{}"),
  outputSchema: text("output_schema").notNull().default("{}"),
  dataRequirements: text("data_requirements").notNull().default("[]"),
  reliability: text("reliability").notNull().default("stable"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  owner: text("owner").notNull().default("system"),
  description: text("description"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const indicatorResults = sqliteTable("indicator_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("primary"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  indicatorKey: text("indicator_key").notNull(),
  stockCode: text("stock_code").notNull(),
  stockName: text("stock_name").notNull(),
  timeframe: text("timeframe").notNull(),
  calculatedAt: text("calculated_at").notNull(),
  dataTime: text("data_time").notNull(),
  value: text("value").notNull(),
  level: text("level"),
  confidence: text("confidence"),
  explanation: text("explanation"),
  sourceSnapshot: text("source_snapshot").notNull().default("{}"),
  missingData: text("missing_data").notNull().default("[]"),
});

export const alertRules = sqliteTable("alert_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("primary"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  stockCode: text("stock_code").notNull(),
  stockName: text("stock_name").notNull(),
  indicatorKey: text("indicator_key").notNull(),
  condition: text("condition").notNull(),
  params: text("params").notNull().default("{}"),
  schedule: text("schedule").notNull().default("intraday"),
  dedupePolicy: text("dedupe_policy").notNull().default("{}"),
  severity: text("severity").notNull().default("medium"),
  relationToPlan: text("relation_to_plan"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sandboxAuditLogs = sqliteTable("sandbox_audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull().default("invest-agent"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  role: text("role").notNull(),
  channel: text("channel").notNull(),
  backend: text("backend"),
  conversationId: text("conversation_id"),
  tokenId: text("token_id"),
  operation: text("operation").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  requestBody: text("request_body").notNull().default("{}"),
  resultSummary: text("result_summary"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
});

export const pendingSandboxConfirmations = sqliteTable("pending_sandbox_confirmations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull().default("invest-agent"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  role: text("role").notNull(),
  channel: text("channel").notNull(),
  backend: text("backend"),
  conversationId: text("conversation_id"),
  requestedTokenId: text("requested_token_id"),
  confirmedTokenId: text("confirmed_token_id"),
  operation: text("operation").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  requestBody: text("request_body").notNull().default("{}"),
  status: text("status").notNull().default("pending"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Service-owned onboarding draft state. This intentionally does not mirror
 * workspace configuration: workspace files change only after a frozen draft
 * has completed its single commit.
 */
export const onboardingDrafts = sqliteTable("onboarding_drafts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull().default("invest-agent"),
  instanceId: text("instance_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  revision: integer("revision").notNull().default(0),
  status: text("status").notNull().default("collecting"),
  stepsJson: text("steps_json").notNull().default("{}"),
  commitSnapshotJson: text("commit_snapshot_json"),
  commitKey: text("commit_key"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  queuedAt: text("queued_at"),
  handoffMessageId: text("handoff_message_id"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  notifiedAt: text("notified_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const conversationTasks = sqliteTable("conversation_tasks", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull().default("invest-agent"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  conversationId: text("conversation_id").notNull(),
  channel: text("channel").notNull().default("weixin-mobile"),
  backend: text("backend"),
  type: text("type").notNull(),
  status: text("status").notNull().default("pending"),
  title: text("title").notNull(),
  summary: text("summary"),
  draftPayload: text("draft_payload").notNull().default("{}"),
  targetOperation: text("target_operation").notNull(),
  resultSummary: text("result_summary"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const pushJobs = sqliteTable("push_jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().default("primary"),
  projectId: text("project_id").notNull().default("invest-agent"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  channel: text("channel").notNull().default("weixin-mobile"),
  backend: text("backend").notNull().default("hermes"),
  source: text("source").notNull().default("scheduler"),
  idempotencyKey: text("idempotency_key"),
  messageKind: text("message_kind"),
  expiresAt: text("expires_at"),
  originTaskKey: text("origin_task_key"),
  originRunId: text("origin_run_id"),
  retryPolicy: text("retry_policy"),
  terminalReason: text("terminal_reason"),
  message: text("message").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  nextRetryAt: text("next_retry_at").notNull(),
  lastAttemptAt: text("last_attempt_at"),
  sentAt: text("sent_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const weixinDeliveryAttempts = sqliteTable("weixin_delivery_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  instanceId: text("instance_id").notNull(),
  externalAccountId: text("external_account_id"),
  pushJobId: text("push_job_id"),
  source: text("source").notNull(),
  probe: integer("probe", { mode: "boolean" }).notNull().default(false),
  result: text("result").notNull(),
  reason: text("reason").notNull(),
  errorMessage: text("error_message"),
  conversationId: text("conversation_id"),
  lastInboundAt: text("last_inbound_at"),
  elapsedSinceLastInboundMs: integer("elapsed_since_last_inbound_ms"),
  createdAt: text("created_at").notNull(),
});

/** Scheduler-owned, immutable facts used to audit a scheduled market-watch window. */
export const marketWatchSnapshots = sqliteTable("market_watch_snapshots", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull().default("invest-agent"),
  instanceId: text("instance_id").notNull(),
  tradingDate: text("trading_date").notNull().default(""),
  windowKey: text("window_key").notNull(),
  capturedAt: text("captured_at").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  deltaJson: text("delta_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const scheduledTaskRuns = sqliteTable("scheduled_task_runs", {
  taskKey: text("task_key").primaryKey(),
  taskType: text("task_type").notNull(),
  userId: text("user_id").notNull().default("primary"),
  projectId: text("project_id").notNull().default("invest-agent"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  scheduledFor: text("scheduled_for").notNull(),
  status: text("status").notNull().default("claimed"),
  claimedAt: text("claimed_at").notNull(),
  finishedAt: text("finished_at"),
  errorMessage: text("error_message"),
  pushJobId: text("push_job_id"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(1),
  nextRetryAt: text("next_retry_at"),
  leaseExpiresAt: text("lease_expires_at"),
  expiresAt: text("expires_at"),
  errorClass: text("error_class"),
  artifactRef: text("artifact_ref"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const platformUsers = sqliteTable("platform_users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  status: text("status").notNull().default("active"),
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(true),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: text("locked_until"),
  lastLoginAt: text("last_login_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const platformRoles = sqliteTable("platform_roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  permissionsJson: text("permissions_json").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const platformUserRoles = sqliteTable("platform_user_roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  platformUserId: text("platform_user_id").notNull(),
  roleId: text("role_id").notNull(),
  createdAt: text("created_at").notNull(),
});

export const platformSessions = sqliteTable("platform_sessions", {
  id: text("id").primaryKey(),
  platformUserId: text("platform_user_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  revokedAt: text("revoked_at"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: text("created_at").notNull(),
});

export const platformLoginEvents = sqliteTable("platform_login_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  platformUserId: text("platform_user_id"),
  username: text("username").notNull(),
  result: text("result").notNull(),
  reason: text("reason"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: text("created_at").notNull(),
});

export const platformAdminAuditLogs = sqliteTable("platform_admin_audit_logs", {
  id: text("id").primaryKey(),
  platformUserId: text("platform_user_id"),
  role: text("role"),
  action: text("action").notNull(),
  route: text("route").notNull(),
  permission: text("permission"),
  targetCustomerKey: text("target_customer_key"),
  requestId: text("request_id"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  status: text("status").notNull(),
  summaryJson: text("summary_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
});

/**
 * First-class artifact index for the Portal viewer.
 *
 * Each row binds an unguessable `artifactId` to a precise
 * `userId + instanceId + relativePath` so the Portal never exposes workspace
 * absolute paths in conversation messages. The relative path is validated
 * against the user's `reports/` directory on every read (see
 * `src/services/conversation-artifacts.ts`).
 */
export const conversationArtifacts = sqliteTable("conversation_artifacts", {
  artifactId: text("artifact_id").primaryKey(),
  userId: text("user_id").notNull(),
  instanceId: text("instance_id").notNull(),
  projectId: text("project_id").notNull().default("invest-agent"),
  assistantId: text("assistant_id").notNull(),
  conversationId: text("conversation_id"),
  messageId: text("message_id"),
  turnId: text("turn_id"),
  source: text("source").notNull(),
  kind: text("kind").notNull(),
  previewMode: text("preview_mode").notNull(),
  title: text("title").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  relativePath: text("relative_path").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  checksum: text("checksum"),
  assetId: text("asset_id"),
  versionId: text("version_id"),
  idempotencyKey: text("idempotency_key"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  // ---- Portal file-retention additive columns (added 2026-07-25) ----
  // All nullable so existing rows keep their pre-migration behaviour until
  // backfill classifies them. `origin` records how the row was created;
  // `retentionClass` + `visibility` decide whether the file belongs in the
  // permanent library; `expiresAt`/`deletedAt`/`purgeAt` drive the lifecycle.
  origin: text("origin"),
  retentionClass: text("retention_class"),
  visibility: text("visibility"),
  expiresAt: text("expires_at"),
  deletedAt: text("deleted_at"),
  deletedBy: text("deleted_by"),
  deleteReason: text("delete_reason"),
  trashRelativePath: text("trash_relative_path"),
  purgeAt: text("purge_at"),
});

/**
 * Authoritative index for Portal/WeChat user uploads. Replaces the previous
 * "guess TTL from `attachments/YYYY-MM-DD/` directory name" approach: every
 * stored upload gets one row here, and the cleanup job deletes bytes only for
 * rows whose `expires_at` has passed. See
 * `docs/portal-file-retention-and-library-governance-work-package.md` §5.
 */
export const conversationAttachments = sqliteTable("conversation_attachments", {
  attachmentId: text("attachment_id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull().default("invest-agent"),
  instanceId: text("instance_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  messageId: text("message_id"),
  source: text("source").notNull(), // portal | weixin
  kind: text("kind").notNull(), // image | document
  mimeType: text("mime_type").notNull(),
  fileName: text("file_name").notNull(),
  relativePath: text("relative_path").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  checksum: text("checksum"),
  retentionClass: text("retention_class").notNull().default("transient_upload"),
  storedAt: text("stored_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  deletedAt: text("deleted_at"),
  deleteReason: text("delete_reason"),
  updatedAt: text("updated_at").notNull(),
});

export const fileLifecycleEvents = sqliteTable("file_lifecycle_events", {
  id: text("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  userId: text("user_id").notNull(),
  instanceId: text("instance_id"),
  event: text("event").notNull(),
  status: text("status").notNull(),
  reason: text("reason"),
  summaryJson: text("summary_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
});

export const artifactDeleteConfirmations = sqliteTable("artifact_delete_confirmations", {
  tokenId: text("token_id").primaryKey(),
  artifactId: text("artifact_id").notNull(),
  userId: text("user_id").notNull(),
  instanceId: text("instance_id").notNull(),
  relativePath: text("relative_path").notNull(),
  checksum: text("checksum"),
  issuedAt: text("issued_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  status: text("status").notNull().default("prepared"),
  trashRelativePath: text("trash_relative_path"),
  purgeAt: text("purge_at"),
  deletedVersions: integer("deleted_versions"),
  errorCode: text("error_code"),
  completedAt: text("completed_at"),
  updatedAt: text("updated_at").notNull(),
});

/** Canonical long-lived user asset identity. Bytes are versioned below. */
export const userAssetFolders = sqliteTable("user_asset_folders", {
  folderId: text("folder_id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  parentFolderId: text("parent_folder_id"),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const userAssets = sqliteTable("user_assets", {
  assetId: text("asset_id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  folderId: text("folder_id"),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  currentVersionId: text("current_version_id"),
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Immutable bytes and provenance for one logical user asset. */
export const userAssetVersions = sqliteTable("user_asset_versions", {
  versionId: text("version_id").primaryKey(),
  assetId: text("asset_id").notNull(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  versionNumber: integer("version_number").notNull().default(1),
  fileName: text("file_name").notNull(),
  format: text("format").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  checksum: text("checksum").notNull(),
  storagePath: text("storage_path").notNull(),
  source: text("source").notNull(),
  conversationId: text("conversation_id"),
  taskId: text("task_id"),
  runId: text("run_id"),
  parentVersionId: text("parent_version_id"),
  idempotencyKey: text("idempotency_key"),
  idempotencyFingerprint: text("idempotency_fingerprint"),
  createdAt: text("created_at").notNull(),
});

/** Additive quota accounting row for one user/instance/project scope. */
export const userStorageQuotas = sqliteTable("user_storage_quotas", {
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  usedBytes: integer("used_bytes").notNull().default(0),
  reservedBytes: integer("reserved_bytes").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

/** Scope-bound report catalog entries; backing ids make no-copy mappings explicit. */
export const reportAssetMappings = sqliteTable("report_asset_mappings", {
  mappingId: text("mapping_id").primaryKey(),
  reportId: text("report_id").notNull(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  title: text("title").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  backingAssetId: text("backing_asset_id"),
  backingVersionId: text("backing_version_id"),
  readPath: text("read_path"),
  createdAt: text("created_at").notNull(),
});

/**
 * Additive per-mutation reservation ledger. One row per reserveStorage() call;
 * its lifecycle active -> committed|released is idempotent per token. Expired
 * active rows are reclaimable so a crashed write can never permanently hold
 * reserved bytes. Authoritative used/reserved bytes are still recomputed from
 * version/mapping rows plus this ledger; nothing here is migrated from real data.
 */
export const userStorageReservations = sqliteTable("user_storage_reservations", {
  reservationToken: text("reservation_token").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  requestedBytes: integer("requested_bytes").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  settledAt: text("settled_at"),
});

/**
 * User-owned automation task identity and mutable lifecycle state.
 *
 * The task definition itself lives in `automation_task_revisions`; this row
 * only points at the current immutable revision and records whether the task
 * may be picked up by a future automation scheduler.
 */
export const automationTasks = sqliteTable("automation_tasks", {
  taskId: text("task_id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  /** Registered scheduled task type (e.g. scheduled-daily-review); null for plain generic tasks. */
  taskType: text("task_type"),
  status: text("status").notNull().default("paused"),
  currentRevision: integer("current_revision").notNull().default(1),
  currentRevisionId: text("current_revision_id"),
  nextRunAt: text("next_run_at"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  /** DB-enforced cross-origin execution mutex. */
  activeRunId: text("active_run_id"),
  activeRunLeaseToken: text("active_run_lease_token"),
  activeRunLeaseExpiresAt: text("active_run_lease_expires_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Append-only task definitions. Updating a task inserts a new row instead of
 * mutating an existing definition, so a run can always be reconstructed from
 * the revision it claimed.
 */
export const automationTaskRevisions = sqliteTable("automation_task_revisions", {
  revisionId: text("revision_id").primaryKey(),
  taskId: text("task_id").notNull(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  revision: integer("revision").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  /** Generic revisions keep their instruction and policy snapshots here. */
  instruction: text("instruction"),
  scheduleJson: text("schedule_json").notNull(),
  inputsJson: text("inputs_json"),
  outputJson: text("output_json"),
  deliveryJson: text("delivery_json"),
  sourceAssetId: text("source_asset_id"),
  workingAssetId: text("working_asset_id"),
  createdAt: text("created_at").notNull(),
});

/** Stable metadata for the source and working files owned by an automation. */
export const automationTaskAssets = sqliteTable("automation_task_assets", {
  assetId: text("asset_id").primaryKey(),
  taskId: text("task_id").notNull(),
  revisionId: text("revision_id"),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  assetRole: text("asset_role").notNull(),
  fileName: text("file_name").notNull(),
  relativePath: text("relative_path").notNull(),
  mimeType: text("mime_type").notNull(),
  extension: text("extension").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  checksum: text("checksum").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** A user automation run, deliberately separate from the review scheduler's runs. */
export const automationTaskRuns = sqliteTable("automation_task_runs", {
  runId: text("run_id").primaryKey(),
  taskId: text("task_id").notNull(),
  revisionId: text("revision_id").notNull(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  origin: text("origin").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  /** Original caller key; idempotencyKey remains physically unique for stale archival attempts. */
  idempotencyBaseKey: text("idempotency_base_key"),
  attempt: integer("attempt").notNull().default(1),
  scheduledFor: text("scheduled_for"),
  executionDeadlineAt: text("execution_deadline_at"),
  status: text("status").notNull().default("running"),
  claimedAt: text("claimed_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  inputAssetId: text("input_asset_id"),
  inputVersionsJson: text("input_versions_json"),
  outputAssetId: text("output_asset_id"),
  outputVersionId: text("output_version_id"),
  outputChecksum: text("output_checksum"),
  deliveryStatus: text("delivery_status"),
  pushJobId: text("push_job_id"),
  resultSummary: text("result_summary"),
  errorMessage: text("error_message"),
  errorCategory: text("error_category"),
  retryable: integer("retryable", { mode: "boolean" }),
  traceId: text("trace_id"),
  conversationId: text("conversation_id"),
  leaseToken: text("lease_token"),
  leaseExpiresAt: text("lease_expires_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Immutable audit trail for task lifecycle, run claims and asset access. */
export const automationTaskAuditLogs = sqliteTable("automation_task_audit_logs", {
  auditId: text("audit_id").primaryKey(),
  taskId: text("task_id").notNull(),
  revisionId: text("revision_id"),
  runId: text("run_id"),
  assetId: text("asset_id"),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  action: text("action").notNull(),
  status: text("status").notNull(),
  detailsJson: text("details_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
});

/** General task-to-asset binding; legacy automation_task_assets remains intact. */
export const automationTaskAssetBindings = sqliteTable("automation_task_asset_bindings", {
  bindingId: text("binding_id").primaryKey(),
  taskId: text("task_id").notNull(),
  revisionId: text("revision_id").notNull(),
  assetId: text("asset_id").notNull(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  instanceId: text("instance_id").notNull(),
  role: text("role").notNull(),
  versionPolicy: text("version_policy").notNull().default("latest"),
  versionId: text("version_id"),
  createdAt: text("created_at").notNull(),
});
