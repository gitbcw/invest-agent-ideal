#!/usr/bin/env node

import { chdir } from "node:process";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const projectRoot =
  process.env.INVEST_AGENT_PROJECT_ROOT ||
  resolve(__dirname, "../..");
chdir(projectRoot);

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
    "market.quote",
    "Read current quotes for A-share stock codes through the service market-data facade.",
    { codes: z.array(z.string()).min(1).describe("Six-digit stock codes, for example ['002460','601058'].") }
  );

  registerJsonTool(
    { server, callServiceTool, context },
    "market.health",
    "Read market-data provider health and endpoint status from the service layer.",
    {}
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
    "After explicit user confirmation in the latest user message, mark one onboarding step complete and optionally write schedule/notification defaults. Do not call for selection/draft messages such as choosing a style pack or listing market-watch times; first ask the user to reply with an explicit confirmation phrase.",
    {
      confirmedByUser: z.literal(true),
      confirmationId: z.string(),
      step: z.enum(["welcome", "portfolio", "style", "review_schedule", "market_watch_schedule", "notification", "watch_rules"]),
      summary: z.string().optional(),
      notes: z.string().optional(),
      reviewSchedule: z.record(z.string(), z.unknown()).optional(),
      marketWatchSchedule: z.record(z.string(), z.unknown()).optional(),
      notificationPreference: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    },
    { readOnlyHint: false, destructiveHint: false }
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
    "After explicit user confirmation or scheduled review completion, save a daily review artifact and mirror it to workspace/daily plan state.",
    {
      confirmedByUser: z.literal(true),
      date: z.string().optional(),
      content: z.string(),
      summary: z.string().optional(),
      context: z.unknown().optional(),
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
        structuredContent: result as Record<string, unknown>,
      };
    }
  );
}

main().catch((error) => {
  console.error("invest-agent-service-tools MCP failed:", error);
  process.exit(1);
});
