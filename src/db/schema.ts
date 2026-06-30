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

export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("primary"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  stockCode: text("stock_code").notNull(),
  indicator: text("indicator").notNull(), // trend / volume / mainforce
  threshold: text("threshold").notNull(), // JSON
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
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

export const investmentProfiles = sqliteTable("investment_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("primary"),
  instanceId: text("instance_id").notNull().default("invest-agent-primary"),
  style: text("style"),
  selectedStylePack: text("selected_style_pack"),
  customStyle: text("custom_style").notNull().default("{}"),
  riskPreference: text("risk_preference"),
  investmentHorizon: text("investment_horizon"),
  markets: text("markets").notNull().default("[]"),
  allocation: text("allocation").notNull().default("{}"),
  positionRoles: text("position_roles").notNull().default("{}"),
  buyRules: text("buy_rules").notNull().default("[]"),
  sellRules: text("sell_rules").notNull().default("[]"),
  rebalanceRules: text("rebalance_rules").notNull().default("[]"),
  riskRules: text("risk_rules").notNull().default("[]"),
  notificationPolicy: text("notification_policy").notNull().default("{}"),
  decisionPolicy: text("decision_policy").notNull().default("{}"),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
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

export const agentTraces = sqliteTable("agent_traces", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerUserId: text("owner_user_id").notNull().default("primary"),
  userId: text("user_id").notNull(),
  userMessage: text("user_message").notNull(),
  mode: text("mode").notNull(),
  toolName: text("tool_name"),
  toolArgs: text("tool_args"),
  toolResult: text("tool_result"),
  finalReply: text("final_reply").notNull(),
  memoryBefore: text("memory_before"),
  memoryAfter: text("memory_after"),
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
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
