#!/usr/bin/env node

import { chdir } from "node:process";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

// StdioServerTransport owns stdout for JSON-RPC. Shared service code uses
// console.log through the application logger (for example after reviews.save),
// so route ordinary diagnostics to stderr before loading that code.
console.log = (...args: unknown[]) => console.error(...args);

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
  frequency: z.enum(["daily", "trading_days", "weekdays", "weekly"]),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().min(1).max(100),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
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
  z.object({
    mode: z.literal("create"),
      format: z.enum(["markdown", "html", "xlsx", "pdf", "png", "jpeg", "webp", "svg"]),
    fileName: z.string().min(1).max(240),
    titleTemplate: z.string().max(500).optional(),
  }),
  z.object({
    mode: z.literal("update"),
    assetId: z.string().min(1),
    versionPolicy: z.literal("latest"),
    expectedVersionId: z.string().min(1).optional(),
  }),
]);

const automationDeliverySchema = z.union([
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("wechat_summary") }),
  z.object({ mode: z.literal("wechat_on_condition"), conditionVersion: z.literal(1) }),
]);

const automationStatusFields = {
  status: z.enum(["active", "paused"]).optional().describe("Desired task state. Defaults to active for direct creation."),
  enabled: z.boolean().optional().describe("Alias for status: true activates, false pauses."),
};

const projectRoot =
  process.env.INVEST_AGENT_PROJECT_ROOT ||
  resolve(__dirname, "../..");
chdir(projectRoot);

const allowedTools = new Set(
  (process.env.INVEST_AGENT_MCP_ALLOWED_TOOLS || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
);

async function main() {
  const { callServiceTool, serviceToolContextFromEnv } = await import("./service-tools-core.js");
  const context = serviceToolContextFromEnv();
  const server = new McpServer({
    name: "invest-agent-service-tools",
    version: "1.0.0",
  });

  // market_watch.snapshot 已摘除（2026-08-28）：WP7 起快照写入冻结，读取只会
  // 返回 2026-07-31 前的历史行；实时行情走外部 market-data MCP。

  registerJsonTool(
    { server, callServiceTool, context },
    "research.news_search",
    "Search public financial news by keyword when structured service data or stock-specific evidence is insufficient. Returns publisher, publication time, link, fetch time, evidence level, and warnings. Treat results as secondary evidence: never use them to invent missing quotes, financial statement fields, or confirmed corporate facts.",
    {
      query: z.string().min(1).max(120),
      days: z.number().int().min(1).max(90).optional(),
      limit: z.number().int().min(1).max(10).optional(),
    }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "research.web_search",
    "Search the public web for source discovery when named market-data and finance-news tools do not cover the question. Returns ranked titles, snippets, URLs, provider, fetch time, and warnings. Prefer opening relevant results with research.web_read. For stable, low-risk taxonomy or terminology facts, several independent and version-consistent results may support a qualified cross-source conclusion when pages are unavailable, but identify them as search-index evidence and never present one snippet as primary confirmation. Dynamic market data, financial figures and corporate disclosures still require structured or page-level evidence. Start with at most 3 complementary searches and stop as soon as one complete high-quality source or two consistent independent sources cover the answer. Only when core fields or a complete requested list remain missing may you continue with necessary complementary searches; keep total search and distinct-page reads within the answer's evidence budget and reuse non-empty warning-free results instead of rephrasing the same query.",
    {
      query: z.string().min(1).max(120),
      limit: z.number().int().min(1).max(10).optional(),
    },
    { openWorldHint: true }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "research.web_read",
    "Read and sanitize a public HTTP(S) page selected from research evidence. The service rejects local/private addresses, revalidates redirects, limits response type, size and time, removes scripts/navigation, and returns text with the final URL and fetch time. Client-rendered pages can return page_text_unavailable; TLS trust failures return tls_certificate_untrusted. It cannot download arbitrary files or access internal services. If the evidence budget is exhausted or selected pages remain unreadable, stop and report the unverified fact and candidate URLs rather than continuing to search.",
    {
      url: z.string().url().max(2048),
      maxCharacters: z.number().int().min(2000).max(50000).optional(),
    },
    { openWorldHint: true }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "file.parse",
    "Parse a user-uploaded document attachment (PDF/Word/PPT/Excel/CSV/image) into Markdown text via MinerU. Pass the attachment_id shown in the attachment context of the conversation. Returns the parsed document content as Markdown. The file is uploaded to and parsed by the MinerU cloud service (servers in China). Use this instead of writing your own parsing code. If MINERU_API_TOKEN is not configured, this tool returns an error explaining it is unavailable.",
    {
      attachment_id: z.string().min(1).describe("The attachment_id from the conversation attachment context."),
      language: z.string().optional().describe("Document language for OCR accuracy, e.g. 'ch', 'en'. Defaults to 'ch'."),
    },
    { readOnlyHint: true, openWorldHint: true }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "assets.list",
    "List active user assets that are authorized for the current user, project, and instance. Use this to choose an existing table or document for an automation task; the service never accepts caller-supplied scope.",
    {
      status: z.enum(["active", "archived", "all"]).optional(),
      search: z.string().max(200).optional(),
      format: z.enum(["markdown", "html", "csv", "xlsx", "pdf", "png", "jpeg", "webp", "svg", "yaml", "jsonl"]).optional(),
      source: z.enum(["upload", "conversation", "automation", "restore", "system"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    { readOnlyHint: true }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "automation.list",
    "List automation tasks in the current service scope. Filters are optional and never change the user, project, or instance scope.",
    {
      query: z.string().max(200).optional(),
      statuses: z.array(z.enum(["paused", "active", "needs_attention", "archived"])).max(4).optional(),
      frequencies: z.array(z.enum(["daily", "trading_days", "weekdays", "weekly"])).max(4).optional(),
      deliveryModes: z.array(z.enum(["none", "wechat_summary", "wechat_on_condition"])).max(3).optional(),
      outputModes: z.array(z.enum(["none", "agent", "create", "update"])).max(4).optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    { readOnlyHint: true }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "automation.get",
    "Get one automation task in the current service scope by task id.",
    { taskId: z.string().min(1) },
    { readOnlyHint: true }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "automation.create",
    "Create and enable a complete generic automation task in one call. Existing user assets can be bound through inputs or an update output target. Set status=paused or enabled=false only when the task should remain paused. Scope is always derived from the current service context and no confirmation is required.",
    {
      taskId: z.string().min(1).max(200).optional(),
      name: z.string().min(1).max(200),
      description: z.string().max(12000).nullable().optional(),
      instruction: z.string().min(1).max(12000),
      schedule: automationScheduleSchema,
      inputs: z.array(automationAssetBindingSchema).max(8).optional(),
      output: automationOutputSchema.optional(),
      delivery: automationDeliverySchema.optional(),
      ...automationStatusFields,
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "automation.update",
    "Create a new automation revision. An active task remains active after the update unless status=paused or enabled=false is explicitly requested; no confirmation is required. Scope is always derived from the current service context.",
    {
      taskId: z.string().min(1),
      expectedRevision: z.number().int().positive().optional(),
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(12000).nullable().optional(),
      instruction: z.string().min(1).max(12000).optional(),
      schedule: automationScheduleSchema.optional(),
      inputs: z.array(automationAssetBindingSchema).max(8).optional(),
      output: automationOutputSchema.optional(),
      delivery: automationDeliverySchema.optional(),
      ...automationStatusFields,
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "automation.activate",
    "Enable an automation task in the current service scope without confirmation.",
    { taskId: z.string().min(1), expectedRevision: z.number().int().positive().optional() },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "automation.pause",
    "Pause an automation task in the current service scope without confirmation. History, revisions, and task assets are retained.",
    { taskId: z.string().min(1), expectedRevision: z.number().int().positive().optional() },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "assets.version.read",
    "Read the current or explicitly selected version of an authorized user asset. The service checks the current MCP scope and returns bytes without any filesystem path.",
    {
      assetId: z.string().min(1),
      versionId: z.string().min(1).optional(),
    },
    { readOnlyHint: true }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "assets.version.commit",
    "Submit validated bytes as a new version of an existing same-scope user asset. Pass expectedVersionId to enforce compare-and-swap. Scheduled automation calls remain bound to the injected run output target.",
    {
      assetId: z.string().min(1),
      fileName: z.string().min(1),
      mimeType: z.string().optional(),
      base64: z.string().min(1),
      expectedVersionId: z.string().nullable().optional(),
      idempotencyKey: z.string().max(500).optional(),
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "assets.conversation.save",
    "Save generated bytes to the current user, project, and instance asset library, creating an asset or adding a version when assetId is supplied. Scheduled runs remain bound to the injected run output target.",
    {
      assetId: z.string().min(1).optional(),
      name: z.string().max(200).optional(),
      fileName: z.string().min(1),
      mimeType: z.string().optional(),
      base64: z.string().min(1),
      idempotencyKey: z.string().max(500).optional(),
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "assets.attachment.save",
    "Save a current user-uploaded conversation attachment to My Files without exposing or re-encoding its bytes. Use only when the user explicitly asks to retain the attachment or asks to create an automation based on it. Pass the attachmentId from the attachment context; the service verifies current scope and expiry, then returns an assetId that can be bound in automation.create inputs or output.",
    {
      attachmentId: z.string().min(1),
      assetId: z.string().min(1).optional(),
      name: z.string().max(200).optional(),
      idempotencyKey: z.string().max(500).optional(),
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "assets.rename",
    "Rename an active same-scope user asset without changing its versions or file bytes.",
    { assetId: z.string().min(1), name: z.string().min(1).max(200) },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "assets.archive",
    "Archive a same-scope user asset. Archived assets and versions are retained but cannot receive new versions.",
    { assetId: z.string().min(1) },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "assets.delete",
    "Permanently delete a same-scope user asset and its versions after explicit user confirmation. Use confirmations.request for assets.delete first.",
    {
      assetId: z.string().min(1),
      confirmationId: z.string().min(1).max(300),
      confirmedByUser: z.literal(true),
    },
    { readOnlyHint: false, destructiveHint: true }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "portfolio.read",
    "Read active portfolio holdings, weights, cash state, and the current revision for the current user and instance. Read this before drafting portfolio changes.",
    {}
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "portfolio.apply_changes",
    "After a later explicit user confirmation, apply one complete portfolio change set. Use a single draft for holding removals/upserts, cash ratio, and explicit keep/remove decisions when a watched stock becomes a holding. Read portfolio first and pass its revision. Re-read after success.",
    {
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
    { readOnlyHint: false, destructiveHint: true }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "watchlist.read",
    "Read watchlist entries for the current user and instance.",
    {}
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "plans.read",
    "Read stock plans for the current user and instance.",
    {}
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "conversation.history",
    "Read recent canonical conversation-log messages for the current user, instance, and conversation. Use this when a short message such as '确认' or '继续' depends on missing chat context.",
    {
      conversationId: z.string().optional().describe("Conversation id to read. Defaults to the current MCP conversation context."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum messages to return, default 12."),
    }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "confirmations.pending",
    "Read pending service-owned confirmations for the current user, instance, and conversation. Use this before acting on ambiguous confirmation replies.",
    {
      conversationId: z.string().optional().describe("Conversation id to filter by. Defaults to the current MCP conversation context."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum pending confirmations to inspect, default 20."),
    }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "confirmations.request",
    "Safe pre-write step: call this in the same turn when the user asks to change durable state. It only registers an exact draft and returns a confirmationId; it does not perform the durable write. Register the draft BEFORE asking the user to confirm: a confirmation message that predates this registration is rejected by the write tool. After this call, show the draft and wait for a later explicit user confirmation before calling the matching write tool.",
    {
      operation: z.enum(["portfolio.apply_changes", "onboarding.confirm_portfolio", "onboarding.confirm_step", "watchlist.add", "plans.set", "plans.watch_conditions", "method_changes.propose", "method_changes.apply", "preferences.apply", "watch_rules.create"]),
      payload: z.record(z.string(), z.unknown()),
      summary: z.string().optional(),
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "onboarding.confirm_portfolio",
    "After explicit user confirmation, write onboarding holdings/watchlist with required six-digit stock codes and advance onboarding to style.",
    {
      confirmedByUser: z.literal(true).describe("Must be true only after the user explicitly confirmed this write."),
      confirmationId: z.string().describe("Service-issued confirmation id returned by confirmations.request for this exact payload."),
      holdings: z.array(z.object({ name: z.string(), code: z.string(), notes: z.string().optional() })).optional(),
      watchlist: z.array(z.object({ name: z.string(), code: z.string(), notes: z.string().optional() })).optional(),
      summary: z.string().optional(),
      notes: z.string().optional(),
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "onboarding.confirm_step",
    "After an explicit user confirmation in the latest user message, write the confirmed onboarding configuration and advance exactly one step. A plain Chinese confirmation such as 确认、可以、好 is valid after a displayed draft. Never call this for welcome; the first confirmed portfolio completes that transition.",
    {
      confirmedByUser: z.literal(true),
      confirmationId: z.string(),
      step: z.enum(["welcome", "portfolio", "style", "review_schedule", "market_watch_schedule", "notification", "watch_rules"]),
      summary: z.string().optional(),
      notes: z.string().optional(),
      reviewSchedule: z.record(z.string(), z.unknown()).optional(),
      marketWatchSchedule: z.record(z.string(), z.unknown()).optional(),
      notificationPreference: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      styleProfile: onboardingStyleProfileSchema.optional(),
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "onboarding.complete_watch_setup",
    "Finish the final onboarding watch-setup step without asking for another confirmation. Use branch=skip only when the latest user message explicitly skips rules. Use branch=configured with ruleIds returned by confirmed watch_rules.create calls in this conversation after all requested rules were verified.",
    {
      branch: z.enum(["skip", "configured"]),
      ruleIds: z.array(z.number().int().positive()).optional(),
      summary: z.string().optional(),
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "onboarding.draft.get",
    "Read the current onboarding draft and its next unconfirmed step. First read config/onboarding_state.yaml: if status is completed, handle ordinary investment requests without starting or resuming onboarding; only inspect this draft when onboarding state is not completed or the user explicitly requests reconfiguration.",
    {}
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "onboarding.draft.upsert_step",
    "Create or revise one onboarding draft section. This validates and stores only the draft; it does not modify workspace configuration.",
    {
      draftId: z.string().optional(),
      step: z.enum(["portfolio", "style", "review_schedule", "market_watch_schedule", "notification", "watch_rules"]),
      payload: z.record(z.string(), z.unknown()),
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "onboarding.draft.request_confirmation",
    "Bind a displayed onboarding draft section and revision to one later ordinary user confirmation. Call before asking the user to confirm that exact draft.",
    {
      draftId: z.string(),
      step: z.enum(["portfolio", "style", "review_schedule", "market_watch_schedule", "notification", "watch_rules"]),
      revision: z.number().int().positive(),
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "onboarding.draft.accept_step",
    "After explicit user confirmation, mark that exact onboarding draft revision as accepted. This only updates the service-owned draft and never writes workspace files.",
    {
      confirmedByUser: z.literal(true),
      confirmationId: z.string(),
      draftId: z.string(),
      step: z.enum(["portfolio", "style", "review_schedule", "market_watch_schedule", "notification", "watch_rules"]),
      revision: z.number().int().positive(),
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "onboarding.draft.skip_watch_rules",
    "When the current final onboarding step is optional explicit rules and the latest user message clearly declines rules, mark that skip as accepted. Then enqueue the frozen commit immediately; never ask for a completion-only confirmation.",
    { draftId: z.string() },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "onboarding.draft.enqueue_commit",
    "After every onboarding draft section is accepted, freeze the draft and queue one background commit. Reply that configuration is being completed; do not request a content-free final confirmation.",
    { draftId: z.string() },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "onboarding.draft.commit_status",
    "Read whether a frozen onboarding draft is queued, applying, completed, or retrying after a failed commit.",
    {}
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "watchlist.add",
    "After explicit user confirmation, add a stock to the current user's watchlist. Name-only inputs will be resolved by the service.",
    {
      confirmedByUser: z.literal(true),
      confirmationId: z.string(),
      name: z.string().optional(),
      code: z.string().optional(),
      reason: z.string().optional(),
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "plans.set",
    "After explicit user confirmation, create or update a stock plan with support/resistance/target/stop-loss fields.",
    {
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
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "plans.watch_conditions",
    "After explicit user confirmation, update structured watch conditions for an existing stock plan.",
    {
      confirmedByUser: z.literal(true),
      confirmationId: z.string(),
      stockCode: z.string(),
      stockName: z.string().optional(),
      conditions: z.array(z.record(z.string(), z.unknown())),
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "method_changes.propose",
    "After explicit user confirmation, create a methodology change candidate. This does not change the active strategy; ask the user whether to formally adopt it next.",
    {
      confirmedByUser: z.literal(true),
      confirmationId: z.string(),
      proposedChange: z.string(),
      reason: z.string(),
      sourceReviewId: z.string().optional(),
      sourceType: z.string().optional(),
      affectedResource: z.string().optional(),
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "method_changes.apply",
    "After a second explicit user confirmation, adopt one proposed method-change candidate into config/strategy.yaml. Pass only the exact structured strategy patch shown to the user; the service records the change, verifies the write, and publishes the strategy file artifact.",
    {
      confirmedByUser: z.literal(true),
      confirmationId: z.string(),
      candidateId: z.string(),
      expectedLastConfirmedAt: z.string().nullable().optional(),
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
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "preferences.apply",
    "After explicit user confirmation, update review times, intraday brief schedule, or notification preference after onboarding. This is a named semantic configuration write, not arbitrary YAML editing; the service validates, writes, reads back, audits, and publishes the changed config files.",
    {
      confirmedByUser: z.literal(true),
      confirmationId: z.string(),
      expectedLastConfirmedAt: z.string().datetime().nullable().optional(),
      reviewSchedule: z.record(z.string(), z.unknown()).optional(),
      marketWatchSchedule: z.record(z.string(), z.unknown()).optional(),
      notificationPreference: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      summary: z.string().optional(),
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "reviews.save",
    "Publish an Agent-authored review (daily/weekly/monthly). Preserve the full Markdown as the report, store an independent WeChat push brief (the brief must be concise WeChat-renderable Markdown: **bold** highlights, clear paragraphs, lists or short headers, no Markdown tables — WeChat renders neither tables nor raw walls of text), and optionally append Agent-authored decision/source records. Scheduled reviews do not need interactive confirmation; manual durable saves require confirmedByUser=true. For weekly/monthly, pass kind and reportKey. The reply includes an `artifact` descriptor whose `artifactId` should be embedded in the assistant reply metadata so the Portal can render it inline.",
    {
      confirmedByUser: z.literal(true).optional(),
      date: z.string().optional(),
      kind: z.enum(["daily", "weekly", "monthly"]).optional(),
      reportKey: z.string().optional(),
      content: z.string(),
      pushBrief: z.string().optional().describe("Sent to the user as a WeChat message. Concise WeChat-renderable Markdown only: **bold** highlights, clear paragraphs, lists or short headers; no Markdown tables; never one unformatted wall of text."),
      summary: z.string().optional(),
      decisionRecords: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
      sourceEvents: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
      context: z.unknown().optional(),
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "artifacts.publish",
    "Register an already-existing workspace file as a first-class artifact and return its descriptor. Use it for a Portal file delivery only when the user explicitly requests the file/link/download, or when the current turn actually created or modified that file. Do not publish files merely because you read, referenced, mentioned, or found them in the workspace or conversation history. The service rejects in-turn publishes of files whose last write predates the current turn (files left over from an earlier failed turn must not be delivered as this turn's work); when the user explicitly asks you to deliver such a pre-existing file, pass existingFileRequest=true to attest that explicit request. Ordinary chat deliverables must be written under deliveries/ and remain temporary; set saveToMyFiles only when the user explicitly asks for a formal report or asks to retain the file in My Files. reports/ is reserved for Workspace-native reports, not ordinary Portal delivery. During the internal development phase, the user's own config/ files are deliverable as raw workspace files; portfolio.apply_changes automatically publishes config/portfolio.yaml after a successful write, so do not publish that same file a second time. Do not use it for a Portal request to draw, explain, visualize, diagram, or chart something: those are handled by the Portal's inline SVG response protocol, not an artifact. Image artifacts (SVG/PNG/JPEG/WebP) published during the current turn render inline inside the Portal conversation message; Markdown, HTML, and YAML artifacts open in the Portal side-panel preview instead. Never accept absolute paths or paths outside the user's deliveries/, reports/, or config/ directory.",
    {
      relativePath: z.string().min(1).describe("Workspace-relative path under deliveries/, reports/, or config/. Use deliveries/ for normal Portal file delivery."),
      kind: z.enum(["report", "chart", "data", "document"]).optional(),
      title: z.string().max(200).optional(),
      saveToMyFiles: z.boolean().optional().describe("Set true only when the user explicitly requests a formal report or asks to retain this file in My Files. Otherwise omit it so the chat card offers Save."),
      existingFileRequest: z.boolean().optional().describe("Set true ONLY when the user explicitly asked to deliver a file that already existed before this turn; the service otherwise rejects files not written during the current turn."),
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "watch_rules.catalog",
    "Read the service-owned explicit watch-rule catalog.",
    {}
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "watch_rules.list",
    "Read explicit watch rules for the current user and instance.",
    {}
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "watch_rules.validate",
    "Validate an explicit watch-rule draft before asking the user to confirm creation.",
    {
      stockCode: z.string().optional(),
      stockName: z.string().optional(),
      ruleType: z.string().optional(),
      targetScope: z.string().optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      cooldown: z.record(z.string(), z.unknown()).optional(),
      notification: z.record(z.string(), z.unknown()).optional(),
      enabled: z.boolean().optional(),
    }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "watch_rules.create",
    "After explicit user confirmation, create an explicit deterministic watch rule.",
    {
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
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "watch_rules.dry_run",
    "Dry-run an existing explicit watch rule by id using current/latest service facts.",
    { id: z.union([z.number(), z.string()]) }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `invest-agent-service-tools MCP ready user=${context.userId} instance=${context.instanceId} root=${projectRoot}`
  );
}

function registerJsonTool(
  runtime: {
    server: McpServer;
    callServiceTool: (
      name: string,
      input: Record<string, unknown> | undefined,
      context: { userId: string; instanceId: string; workspacePath?: string; conversationId?: string }
    ) => Promise<unknown>;
    context: { userId: string; instanceId: string; workspacePath?: string; conversationId?: string };
  },
  name: string,
  description: string,
  inputSchema: z.ZodRawShape,
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } = {}
) {
  if (allowedTools.size > 0 && !allowedTools.has(name)) return;
  runtime.server.registerTool(
    name,
    {
      description,
      inputSchema,
      annotations: {
        readOnlyHint: annotations.readOnlyHint ?? true,
        destructiveHint: annotations.destructiveHint ?? false,
        openWorldHint: annotations.openWorldHint ?? false,
      },
    },
    async (input) => {
      const result = await runtime.callServiceTool(name, input as Record<string, unknown>, runtime.context);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}

main().catch((error) => {
  console.error("invest-agent-service-tools MCP failed:", error);
  process.exit(1);
});
