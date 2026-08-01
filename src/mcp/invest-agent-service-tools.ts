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
    { server, callServiceTool, context },
    "market_watch.snapshot",
    "Read the latest scheduler-captured market-watch facts and change marker for the current user and instance.",
    {}
  );

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
    "Safe pre-write step: call this in the same turn when the user asks to change durable state. It only registers an exact draft and returns a confirmationId; it does not perform the durable write. After this call, show the draft and wait for a later explicit user confirmation before calling the matching write tool.",
    {
      operation: z.enum(["portfolio.apply_changes", "onboarding.confirm_portfolio", "onboarding.confirm_step", "watchlist.add", "plans.set", "plans.watch_conditions", "method_changes.propose", "watch_rules.create"]),
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
    "Publish an Agent-authored review (daily/weekly/monthly). Preserve the full Markdown as the report, store an independent WeChat push brief, and optionally append Agent-authored decision/source records. Scheduled reviews do not need interactive confirmation; manual durable saves require confirmedByUser=true. For weekly/monthly, pass kind and reportKey. The reply includes an `artifact` descriptor whose `artifactId` should be embedded in the assistant reply metadata so the Portal can render it inline.",
    {
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
    { readOnlyHint: false, destructiveHint: false }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "artifacts.publish",
    "Register an already-existing workspace file (under reports/) as a first-class artifact and return its descriptor. Use this only when the user explicitly requests a file, report, download, or saved workspace output. For an explicitly requested standalone webpage report, write a static self-contained HTML file under reports/html/ and call artifacts.publish in the same turn; do not claim that the report is available unless this tool returns successfully. Existing semantic reports may remain under reports/daily, reports/weekly, reports/monthly, or reports/company even when their format is HTML. Do not use it for a Portal request to draw, explain, visualize, diagram, or chart something: those are handled by the Portal's inline SVG response protocol, not an artifact. Image artifacts (SVG/PNG/JPEG/WebP) published during the current turn render inline inside the Portal conversation message; Markdown and HTML artifacts open in the Portal side-panel preview instead. Never accept absolute paths or paths outside the user's reports directory.",
    {
      relativePath: z.string().min(1).describe("Workspace-relative path that begins with reports/, e.g. reports/daily/2026-07-24.md or reports/html/2026-07-24-portfolio-risk.html."),
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
