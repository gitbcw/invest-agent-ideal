/**
 * Mastra in-process 工具注册表（阶段 1）
 *
 * 这是 28 个 service tool 的 schema / description / annotations 单一真相，
 * 从 `src/mcp/invest-agent-service-tools.ts` 的 MCP server 注册逐条翻译而来。
 * 业务逻辑零迁移：每个工具的 execute 直接调 `callServiceTool(name, input, context)`。
 *
 * 注意：这里只定义"工具长什么样"（name + schema + description），
 * "怎么执行"（callServiceTool + scope guard + requestContext 注入）在 index.ts。
 *
 * schema 用 zod/v4（与现有 MCP server 一致，避免双轨）。Mastra createTool 接受
 * 标准 schema（zod 实现 StandardSchemaLike），zod/v4 兼容。
 */

import { z } from "zod/v4";

/** 一个工具的声明性定义（不含 execute，execute 由 index.ts 统一注入）。 */
export interface ToolSpec {
  /** 工具名，与 callServiceTool 的 name 参数一致。 */
  id: string;
  /** 给模型看的工具描述（从 invest-agent-service-tools.ts 原样搬运）。 */
  description: string;
  /** 输入 schema（zod raw shape，与 MCP server registerTool 用法一致）。 */
  inputSchema: z.ZodRawShape;
  /** MCP 风格的 annotation hint（只影响展示，不影响 scope guard 判定）。 */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}

// onboarding 风格 profile（多处复用）
const onboardingStyleProfileSchema = z.object({
  style: z.string().optional().describe("Canonical investment style label."),
  name: z.string().optional().describe("Natural-language strategy name; accepted as the style label."),
  notes: z.string().optional().describe("Canonical strategy summary and important details."),
  summary: z.string().optional().describe("Natural-language strategy summary; accepted as notes."),
  strategySummary: z.string().optional().describe("Detailed strategy summary; accepted as notes."),
  selectedStylePack: z.string().nullable().optional(),
  customStyleEnabled: z.boolean().optional(),
  investmentHorizon: z.string().optional(),
  holdingHorizon: z.string().optional().describe("Alias of investmentHorizon."),
  riskPreference: z.string().optional(),
  buyRules: z.array(z.unknown()).optional(),
  entryRules: z.array(z.unknown()).optional().describe("Alias of buyRules."),
  sellRules: z.array(z.unknown()).optional(),
  exitRules: z.array(z.unknown()).optional().describe("Alias of sellRules."),
  riskRules: z.array(z.unknown()).optional(),
  corePrinciple: z.string().optional(),
  riskNotes: z.string().optional(),
  basePositionPercent: z.number().optional(),
  positionStepPercent: z.number().optional(),
  executionPrice: z.string().optional(),
}).catchall(z.unknown()).describe("Style profile. Provide at least a style/name or notes/summary/strategySummary so the confirmed strategy can be persisted.");

const automationScheduleSchema = z.object({
  frequency: z.enum(["daily", "trading_days", "weekdays", "weekly", "monthly"]),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().min(1).max(100),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  monthlyDay: z.number().int().min(1).max(28).optional(),
  windows: z.array(z.string().regex(/^\d{2}:\d{2}$/)).max(12).optional(),
});
const automationAssetBindingSchema = z.object({
  assetId: z.string().min(1),
  role: z.enum(["input", "update_target"]),
  versionPolicy: z.enum(["latest", "fixed"]),
  versionId: z.string().min(1).optional(),
});
const automationOutputSchema = z.union([
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("agent") }),
  z.object({ mode: z.literal("create"), format: z.enum(["markdown", "html", "xlsx", "pdf", "png", "jpeg", "webp", "svg"]), fileName: z.string().min(1).max(240), titleTemplate: z.string().max(500).optional() }),
  z.object({ mode: z.literal("update"), assetId: z.string().min(1), versionPolicy: z.literal("latest"), expectedVersionId: z.string().min(1).optional() }),
]);
const automationDeliverySchema = z.union([
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("wechat_summary") }),
  z.object({ mode: z.literal("wechat_on_condition"), conditionVersion: z.literal(1) }),
]);
const automationStatusFields = {
  status: z.enum(["active", "paused"]).optional(),
  enabled: z.boolean().optional(),
};

/**
 * 当前主项目全部 49 个 service tools 的声明性定义。外部 MCP 仍是独立
 * transport；这里的 research 工具仅保留 service-core 的受控 read wrapper。
 */
export const TOOL_SPECS: readonly ToolSpec[] = [
  // ── read: 行情 / 研究 / 文件 ──
  {
    id: "market_watch.snapshot",
    description: "Read the latest scheduler-captured market-watch facts and change marker for the current user and instance.",
    inputSchema: {},
  },
  {
    id: "file.parse",
    description: "Parse a user-uploaded document attachment (PDF/Word/PPT/Excel/CSV/image) into Markdown text via MinerU. Pass the attachment_id shown in the attachment context of the conversation. Returns the parsed document content as Markdown. The file is uploaded to and parsed by the MinerU cloud service (servers in China). Use this instead of writing your own parsing code. If MINERU_API_TOKEN is not configured, this tool returns an error explaining it is unavailable.",
    inputSchema: {
      attachment_id: z.string().min(1).describe("The attachment_id from the conversation attachment context."),
      language: z.string().optional().describe("Document language for OCR accuracy, e.g. 'ch', 'en'. Defaults to 'ch'."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },

  // ── read/write: user assets and automations ──
  {
    id: "research.news_search",
    description: "Search public financial news and return source-backed evidence.",
    inputSchema: { query: z.string().min(1).max(120), days: z.number().int().min(1).max(90).optional(), limit: z.number().int().min(1).max(10).optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    id: "research.web_search",
    description: "Search the public web for source discovery.",
    inputSchema: { query: z.string().min(1).max(120), limit: z.number().int().min(1).max(10).optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    id: "research.web_read",
    description: "Read a validated public HTTP(S) page selected from research evidence.",
    inputSchema: { url: z.string().url().max(2048), maxCharacters: z.number().int().min(2000).max(50000).optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    id: "assets.list",
    description: "List active same-scope user assets.",
    inputSchema: { status: z.enum(["active", "archived", "all"]).optional(), search: z.string().max(200).optional(), format: z.enum(["markdown", "html", "csv", "xlsx", "pdf", "png", "jpeg", "webp", "svg", "yaml", "jsonl"]).optional(), source: z.enum(["upload", "conversation", "automation", "restore", "system"]).optional(), limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true },
  },
  {
    id: "automation.list",
    description: "List automation tasks in the current service scope.",
    inputSchema: { query: z.string().max(200).optional(), statuses: z.array(z.enum(["paused", "active", "needs_attention", "archived"])).max(4).optional(), frequencies: z.array(z.enum(["daily", "trading_days", "weekdays", "weekly"])).max(4).optional(), deliveryModes: z.array(z.enum(["none", "wechat_summary", "wechat_on_condition"])).max(3).optional(), outputModes: z.array(z.enum(["none", "agent", "create", "update"])).max(4).optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true },
  },
  { id: "automation.get", description: "Get one same-scope automation task.", inputSchema: { taskId: z.string().min(1) }, annotations: { readOnlyHint: true } },
  {
    id: "automation.create", description: "Create a generic automation task in the current scope.",
    inputSchema: { taskId: z.string().min(1).max(200).optional(), name: z.string().min(1).max(200), description: z.string().max(12000).nullable().optional(), instruction: z.string().min(1).max(12000), schedule: automationScheduleSchema, inputs: z.array(automationAssetBindingSchema).max(8).optional(), output: automationOutputSchema.optional(), delivery: automationDeliverySchema.optional(), ...automationStatusFields },
  },
  {
    id: "automation.update", description: "Create a new automation revision in the current scope.",
    inputSchema: { taskId: z.string().min(1), expectedRevision: z.number().int().positive().optional(), name: z.string().min(1).max(200).optional(), description: z.string().max(12000).nullable().optional(), instruction: z.string().min(1).max(12000).optional(), schedule: automationScheduleSchema.optional(), inputs: z.array(automationAssetBindingSchema).max(8).optional(), output: automationOutputSchema.optional(), delivery: automationDeliverySchema.optional(), ...automationStatusFields },
  },
  { id: "automation.activate", description: "Activate a same-scope automation task.", inputSchema: { taskId: z.string().min(1), expectedRevision: z.number().int().positive().optional() } },
  { id: "automation.pause", description: "Pause a same-scope automation task.", inputSchema: { taskId: z.string().min(1), expectedRevision: z.number().int().positive().optional() } },
  { id: "assets.version.read", description: "Read an authorized user asset version without exposing filesystem paths.", inputSchema: { assetId: z.string().min(1), versionId: z.string().min(1).optional() }, annotations: { readOnlyHint: true } },
  { id: "assets.version.commit", description: "Submit validated bytes as a new same-scope asset version.", inputSchema: { assetId: z.string().min(1), fileName: z.string().min(1), mimeType: z.string().optional(), base64: z.string().min(1), expectedVersionId: z.string().nullable().optional(), idempotencyKey: z.string().max(500).optional() } },
  { id: "assets.conversation.save", description: "Save generated bytes to the same-scope asset library.", inputSchema: { assetId: z.string().min(1).optional(), name: z.string().max(200).optional(), fileName: z.string().min(1), mimeType: z.string().optional(), base64: z.string().min(1), idempotencyKey: z.string().max(500).optional() } },
  { id: "assets.attachment.save", description: "Save a current-scope conversation attachment to the asset library.", inputSchema: { attachmentId: z.string().min(1), assetId: z.string().min(1).optional(), name: z.string().max(200).optional(), idempotencyKey: z.string().max(500).optional() } },
  { id: "assets.rename", description: "Rename an active same-scope user asset.", inputSchema: { assetId: z.string().min(1), name: z.string().min(1).max(200) } },
  { id: "assets.archive", description: "Archive a same-scope user asset.", inputSchema: { assetId: z.string().min(1) } },
  { id: "assets.delete", description: "Permanently delete a same-scope user asset after confirmation.", inputSchema: { assetId: z.string().min(1), confirmationId: z.string().min(1).max(300), confirmedByUser: z.literal(true) }, annotations: { destructiveHint: true } },

  // ── read: 用户状态 ──
  {
    id: "portfolio.read",
    description: "Read active portfolio holdings, weights, cash state, and the current revision for the current user and instance. Read this before drafting portfolio changes.",
    inputSchema: {},
  },
  {
    id: "watchlist.read",
    description: "Read watchlist entries for the current user and instance.",
    inputSchema: {},
  },
  {
    id: "plans.read",
    description: "Read stock plans for the current user and instance.",
    inputSchema: {},
  },
  {
    id: "conversation.history",
    description: "Read recent canonical conversation-log messages for the current user, instance, and conversation. Use this when a short message such as '确认' or '继续' depends on missing chat context.",
    inputSchema: {
      conversationId: z.string().optional().describe("Conversation id to read. Defaults to the current MCP conversation context."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum messages to return, default 12."),
    },
  },
  {
    id: "confirmations.pending",
    description: "Read pending service-owned confirmations for the current user, instance, and conversation. Use this before acting on ambiguous confirmation replies.",
    inputSchema: {
      conversationId: z.string().optional().describe("Conversation id to filter by. Defaults to the current MCP conversation context."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum pending confirmations to inspect, default 20."),
    },
  },

  // ── other-write: 确认 / 持仓 / 观察仓 / 计划 ──
  {
    id: "confirmations.request",
    description: "Safe pre-write step: call this in the same turn when the user asks to change durable state. It only registers an exact draft and returns a confirmationId; it does not perform the durable write. After this call, show the draft and wait for a later explicit user confirmation before calling the matching write tool.",
    inputSchema: {
      operation: z.enum(["portfolio.apply_changes", "onboarding.confirm_portfolio", "watchlist.add", "plans.set", "plans.watch_conditions", "method_changes.propose", "method_changes.apply", "preferences.apply", "watch_rules.create"]),
      payload: z.record(z.string(), z.unknown()),
      summary: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    id: "portfolio.apply_changes",
    description: "After a later explicit user confirmation, apply one complete portfolio change set. Use a single draft for holding removals/upserts, cash ratio, and explicit keep/remove decisions when a watched stock becomes a holding. Read portfolio first and pass its revision. Re-read after success.",
    inputSchema: {
      confirmedByUser: z.literal(true),
      confirmationId: z.string(),
      expectedLastConfirmedAt: z.string().datetime().nullable(),
      removeHoldingCodes: z.array(z.string().regex(/^\d{6}$/)).optional(),
      upsertHoldings: z.array(z.object({
        code: z.string().regex(/^\d{6}$/),
        name: z.string().min(1),
        weight: z.number().min(0).max(100).nullable().optional(),
        cost: z.number().nonnegative().nullable().optional(),
        shares: z.number().nonnegative().nullable().optional(),
        notes: z.string().optional(),
      })).optional(),
      watchlistActions: z.array(z.object({
        code: z.string().regex(/^\d{6}$/),
        action: z.enum(["keep", "remove"]),
      })).optional(),
      cashRatioPercent: z.number().min(0).max(100).optional(),
      summary: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    id: "watchlist.add",
    description: "After explicit user confirmation, add a stock to the current user's watchlist. Name-only inputs will be resolved by the service.",
    inputSchema: {
      confirmedByUser: z.literal(true),
      confirmationId: z.string(),
      name: z.string().optional(),
      code: z.string().optional(),
      reason: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    id: "plans.set",
    description: "After explicit user confirmation, create or update a stock plan with support/resistance/target/stop-loss fields.",
    inputSchema: {
      confirmedByUser: z.literal(true),
      confirmationId: z.string(),
      stockCode: z.string(),
      stockName: z.string().optional(),
      support: z.number().optional(),
      resistance: z.number().optional(),
      targetPrice: z.number().optional(),
      stopLoss: z.number().optional(),
      notes: z.string().optional(),
      watchConditions: z.array(z.record(z.string(), z.unknown())).optional(),
      linkedAlertRuleIds: z.array(z.union([z.string(), z.number()])).optional(),
      planType: z.string().optional(),
      strategyKey: z.string().nullable().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    id: "plans.watch_conditions",
    description: "After explicit user confirmation, update structured watch conditions for an existing stock plan.",
    inputSchema: {
      confirmedByUser: z.literal(true),
      confirmationId: z.string(),
      stockCode: z.string(),
      stockName: z.string().optional(),
      conditions: z.array(z.record(z.string(), z.unknown())),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },

  // ── other-write: 方法变更 / 偏好 ──
  {
    id: "method_changes.propose",
    description: "After explicit user confirmation, create a methodology change candidate. This does not change the active strategy; ask the user whether to formally adopt it next.",
    inputSchema: {
      confirmedByUser: z.literal(true),
      confirmationId: z.string(),
      proposedChange: z.string(),
      reason: z.string(),
      sourceReviewId: z.string().optional(),
      sourceType: z.string().optional(),
      affectedResource: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    id: "method_changes.apply",
    description: "After a second explicit user confirmation, adopt one proposed method-change candidate into config/strategy.yaml. Pass only the exact structured strategy patch shown to the user; the service records the change, verifies the write, and publishes the strategy file artifact.",
    inputSchema: {
      confirmedByUser: z.literal(true),
      confirmationId: z.string(),
      candidateId: z.string(),
      expectedLastConfirmedAt: z.string().datetime().nullable().optional(),
      strategyPatch: z.object({
        profile: z.record(z.string(), z.unknown()).optional(),
        allocation: z.record(z.string(), z.unknown()).optional(),
        positionRoles: z.record(z.string(), z.unknown()).optional(),
        buyRules: z.array(z.unknown()).optional(),
        sellRules: z.array(z.unknown()).optional(),
        rebalanceRules: z.array(z.unknown()).optional(),
        riskRules: z.array(z.unknown()).optional(),
        doNotDoRules: z.array(z.string()).optional(),
        decisionBoundaries: z.record(z.string(), z.unknown()).optional(),
        notes: z.string().optional(),
      }),
      decisionNote: z.string().optional(),
      summary: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    id: "preferences.apply",
    description: "After explicit user confirmation, update review times, intraday brief schedule, or notification preference after onboarding. This is a named semantic configuration write, not arbitrary YAML editing; the service validates, writes, reads back, audits, and publishes the changed config files.",
    inputSchema: {
      confirmedByUser: z.literal(true),
      confirmationId: z.string(),
      expectedLastConfirmedAt: z.string().datetime().nullable().optional(),
      reviewSchedule: z.record(z.string(), z.unknown()).optional(),
      marketWatchSchedule: z.record(z.string(), z.unknown()).optional(),
      notificationPreference: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      summary: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },

  // ── final-action: 复盘保存 ──
  {
    id: "reviews.save",
    description: "Publish an Agent-authored review (daily/weekly/monthly). Preserve the full Markdown as the report, store an independent WeChat push brief, and optionally append Agent-authored decision/source records. Scheduled reviews do not need interactive confirmation; manual durable saves require confirmedByUser=true. For weekly/monthly, pass kind and reportKey. The reply includes an `artifact` descriptor whose `artifactId` should be embedded in the assistant reply metadata so the Portal can render it inline.",
    inputSchema: {
      confirmedByUser: z.literal(true).optional(),
      date: z.string().optional(),
      kind: z.enum(["daily", "weekly", "monthly"]).optional(),
      reportKey: z.string().optional(),
      content: z.string(),
      pushBrief: z.string().optional(),
      summary: z.string().optional(),
      decisionRecords: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
      sourceEvents: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
      context: z.unknown().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    id: "artifacts.publish",
    description: "Register an already-existing workspace file (under reports/ or config/) as a first-class artifact and return its descriptor. Use it for a Portal file delivery only when the user explicitly requests the file/link/download, or when the current turn actually created or modified that file. Do not publish files merely because you read, referenced, mentioned, or found them in the workspace or conversation history. During the internal development phase, the user's own config/ files are deliverable as raw workspace files; portfolio.apply_changes automatically publishes config/portfolio.yaml after a successful write, so do not publish that same file a second time. For an explicitly requested standalone webpage report, write a static self-contained HTML file under reports/html/ and call artifacts.publish in the same turn; do not claim that the report is available unless this tool returns successfully. Existing semantic reports may remain under reports/daily, reports/weekly, reports/monthly, or reports/company even when their format is HTML. Do not use it for a Portal request to draw, explain, visualize, diagram, or chart something: those are handled by the Portal's inline SVG response protocol, not an artifact. Image artifacts (SVG/PNG/JPEG/WebP) published during the current turn render inline inside the Portal conversation message; Markdown, HTML, and YAML artifacts open in the Portal side-panel preview instead. Never accept absolute paths or paths outside the user's reports/ or config/ directory.",
    inputSchema: {
      relativePath: z.string().min(1).describe("Workspace-relative path that begins with reports/ or config/, e.g. reports/daily/2026-07-24.md, reports/html/2026-07-24-portfolio-risk.html, or config/portfolio.yaml."),
      kind: z.enum(["report", "chart", "data", "document"]).optional(),
      title: z.string().max(200).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    id: "spreadsheet.create",
    description: "Create a real Excel .xlsx workbook from structured columns and rows and deliver it as a conversation artifact card in the current turn. Use this tool whenever a web user asks for a spreadsheet, table file, Excel file, or download. Do not claim Excel binary writing is unavailable. The file is NOT saved to My Files automatically — the user saves it from the artifact card's save button; only mention My Files storage after the user actually saves or explicitly asks to keep it. Pass typed numeric values as numbers; keep source notes in a final column. The service applies a frozen header, filter, readable widths, and validates the workbook before delivery.",
    inputSchema: {
      fileName: z.string().regex(/^[^/\\]+\.xlsx$/i).max(180),
      title: z.string().max(200).optional(),
      columns: z.array(z.string().min(1).max(120)).min(1).max(30),
      rows: z.array(z.array(z.unknown())).max(100).optional(),
      notes: z.string().max(2000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    id: "spreadsheet.transform",
    description: "Transform a staged .xlsx workbook in the current workspace: read the input file, apply structured sheet changes (appendRows, setCells, createSheets, renameSheets, setColumnWidths, setRowHeights, mergeCells, freezePanes, autoFilters), and write a NEW output .xlsx next to it. The execution environment cannot run local scripts, so use this tool instead of any helper script when an automation task must update a bound workbook; do not treat XLSX as text. It does not commit asset versions — return the output file via stagedOutput / the automation result.",
    inputSchema: {
      inputPath: z.string().min(1).max(400),
      outputPath: z.string().min(1).max(400),
      changes: z.record(z.string(), z.unknown()),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },

  // ── read: watch_rules ──
  {
    id: "watch_rules.catalog",
    description: "Read the service-owned explicit watch-rule catalog.",
    inputSchema: {},
  },
  {
    id: "watch_rules.list",
    description: "Read explicit watch rules for the current user and instance.",
    inputSchema: {},
  },
  {
    id: "watch_rules.validate",
    description: "Validate an explicit watch-rule draft before asking the user to confirm creation.",
    inputSchema: {
      stockCode: z.string().optional(),
      stockName: z.string().optional(),
      ruleType: z.string().optional(),
      targetScope: z.string().optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      cooldown: z.record(z.string(), z.unknown()).optional(),
      notification: z.record(z.string(), z.unknown()).optional(),
      enabled: z.boolean().optional(),
    },
  },
  {
    id: "watch_rules.dry_run",
    description: "Dry-run an existing explicit watch rule by id using current/latest service facts.",
    inputSchema: { id: z.union([z.number(), z.string()]) },
  },
  {
    id: "watch_rules.create",
    description: "After explicit user confirmation, create an explicit deterministic watch rule.",
    inputSchema: {
      confirmedByUser: z.literal(true),
      confirmationId: z.string(),
      stockCode: z.string(),
      stockName: z.string().optional(),
      ruleType: z.string(),
      targetScope: z.string().optional(),
      params: z.record(z.string(), z.unknown()),
      cooldown: z.record(z.string(), z.unknown()).optional(),
      notification: z.record(z.string(), z.unknown()).optional(),
      enabled: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },

  // ── other-write: onboarding 族 (10) ──
  {
    id: "onboarding.confirm_portfolio",
    description: "After explicit user confirmation, write onboarding holdings/watchlist with required six-digit stock codes and advance onboarding to style.",
    inputSchema: {
      confirmedByUser: z.literal(true).describe("Must be true only after the user explicitly confirmed this write."),
      confirmationId: z.string().describe("Service-issued confirmation id returned by confirmations.request for this exact payload."),
      holdings: z.array(z.object({ name: z.string(), code: z.string(), notes: z.string().optional() })).optional(),
      watchlist: z.array(z.object({ name: z.string(), code: z.string(), notes: z.string().optional() })).optional(),
      summary: z.string().optional(),
      notes: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    id: "onboarding.draft.get",
    description: "Read the current onboarding draft and its next unconfirmed step. First read config/onboarding_state.yaml: if status is completed, handle ordinary investment requests without starting or resuming onboarding; only inspect this draft when onboarding state is not completed or the user explicitly requests reconfiguration.",
    inputSchema: {},
  },
  {
    id: "onboarding.draft.upsert_step",
    description: "Create or revise one onboarding draft section. This validates and stores only the draft; it does not modify workspace configuration.",
    inputSchema: {
      draftId: z.string().optional(),
      step: z.enum(["portfolio", "style", "review_schedule", "market_watch_schedule", "notification", "watch_rules"]),
      payload: z.record(z.string(), z.unknown()),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    id: "onboarding.draft.request_confirmation",
    description: "Bind a displayed onboarding draft section and revision to one later ordinary user confirmation. Call before asking the user to confirm that exact draft.",
    inputSchema: {
      draftId: z.string(),
      step: z.enum(["portfolio", "style", "review_schedule", "market_watch_schedule", "notification", "watch_rules"]),
      revision: z.number().int().positive(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
] as const;

/** 工具 id 清单（供 smoke / 校验用）。 */
export const TOOL_IDS: readonly string[] = TOOL_SPECS.map((spec) => spec.id);
