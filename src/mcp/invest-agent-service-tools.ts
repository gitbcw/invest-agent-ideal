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

  registerJsonTool(
    {
      server,
      callServiceTool,
      context,
    },
    "market.snapshot",
    "Read a service-owned market snapshot for the current user: holdings, watchlist, plans, indices, source metadata, and warnings.",
    { includeCapitalFlow: z.boolean().optional().describe("Whether to include capital-flow data when the service supports it.") }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "market_watch.snapshot",
    "Read the latest scheduler-captured market-watch facts and change marker for the current user and instance.",
    {}
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "market.quote",
    "Read current quotes for A-share stock codes through the service market-data facade.",
    { codes: z.array(z.string()).min(1).describe("Six-digit stock codes, for example ['002460','601058'].") }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "market.kline",
    "Read daily or five-minute K-line bars through the service market-data facade, including source metadata and warnings.",
    {
      code: z.string().describe("Six-digit A-share stock code."),
      period: z.enum(["day", "m5"]).optional(),
      count: z.number().int().min(1).max(500).optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "market.indices",
    "Read core market index quotes with source metadata and warnings.",
    {}
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "market.capital_flow",
    "Read supplemental capital-flow observations for A-share stock codes. Do not treat these observations as proof of institutional intent.",
    { codes: z.array(z.string()).min(1) }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "market.sector_theme",
    "Read service-owned industry, concept, and theme tags for A-share stock codes.",
    { codes: z.array(z.string()).min(1) }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "market.calendar",
    "Read the A-share trading-day and market-session report for a Beijing date.",
    { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "market.health",
    "Read market-data provider health and endpoint status from the service layer.",
    {}
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "market.stock_info",
    "Read service-owned announcements, news, and research-report evidence for named A-share stocks. Treat news and reports as supplemental evidence.",
    {
      stocks: z.array(z.object({ code: z.string(), name: z.string().optional() })).min(1),
      days: z.number().int().min(1).max(90).optional(),
    }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "market.resolve",
    "Resolve an A-share company name or alias to candidate stock codes. This is for identity resolution, not investment evidence.",
    { keyword: z.string().min(1) }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "portfolio.read",
    "Read active portfolio holdings for the current user and instance.",
    {}
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
    "Register an exact durable-write draft before asking the user to confirm it. The returned confirmationId is bound to the current conversation, operation, and payload.",
    {
      operation: z.enum(["onboarding.confirm_portfolio", "onboarding.confirm_step", "watchlist.add", "plans.set", "plans.watch_conditions", "method_changes.propose", "watch_rules.create"]),
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
    "After explicit user confirmation, create a methodology change candidate for later review/decision.",
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
    "reviews.save",
    "Publish an Agent-authored daily review. Preserve the full Markdown as the report, store an independent WeChat push brief, and optionally append Agent-authored decision/source records. Scheduled daily reviews do not need interactive confirmation; manual durable saves require confirmedByUser=true. The reply includes an `artifact` descriptor whose `artifactId` should be embedded in the assistant reply metadata so the Portal can render it inline.",
    {
      confirmedByUser: z.literal(true).optional(),
      date: z.string().optional(),
      content: z.string(),
      pushBrief: z.string().optional(),
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
    "Register an already-existing workspace file (under reports/) as a first-class artifact and return its descriptor. Use this for ad-hoc chart, table, or supplementary report files. Never accept absolute paths or paths outside the user's reports directory.",
    {
      relativePath: z.string().min(1).describe("Workspace-relative path that begins with reports/, e.g. reports/daily/2026-07-24.md."),
      kind: z.enum(["report", "chart", "data", "document"]).optional(),
      title: z.string().max(200).optional(),
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
