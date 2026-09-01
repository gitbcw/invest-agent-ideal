#!/usr/bin/env node

import { chdir } from "node:process";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ALL_SERVICE_TOOL_SPECS, type ToolSpec } from "../mastra/tools/tool-specs.js";

// StdioServerTransport owns stdout for JSON-RPC. Shared service code uses
// console.log through the application logger (for example after reviews.save),
// so route ordinary diagnostics to stderr before loading that code.
console.log = (...args: unknown[]) => console.error(...args);

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

// spreadsheet 桥接对服务 Mastra 面的 workbook 工作流（assets.version.read
// stage → spreadsheet.transform → assets.version.commit），不属于外部 MCP
// 通道的工具面；排除以保持 MCP 暴露集合与收敛前一致（T-451）。
const MCP_EXCLUDED_TOOLS = new Set(["spreadsheet.create", "spreadsheet.transform"]);

async function main() {
  const { callServiceTool, serviceToolContextFromEnv } = await import("./service-tools-core.js");
  const context = serviceToolContextFromEnv();
  const server = new McpServer({
    name: "invest-agent-service-tools",
    version: "1.0.0",
  });

  // market_watch.snapshot 已摘除（2026-08-28）：WP7 起快照写入冻结，读取只会
  // 返回 2026-07-31 前的历史行；实时行情走外部 market-data MCP。

  for (const spec of ALL_SERVICE_TOOL_SPECS) {
    if (MCP_EXCLUDED_TOOLS.has(spec.id)) continue;
    registerJsonTool({ server, callServiceTool, context }, spec);
  }

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
  spec: ToolSpec
) {
  if (allowedTools.size > 0 && !allowedTools.has(spec.id)) return;
  runtime.server.registerTool(
    spec.id,
    {
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: {
        readOnlyHint: spec.annotations?.readOnlyHint ?? true,
        destructiveHint: spec.annotations?.destructiveHint ?? false,
        openWorldHint: spec.annotations?.openWorldHint ?? false,
      },
    },
    async (input) => {
      const result = await runtime.callServiceTool(spec.id, input as Record<string, unknown>, runtime.context);
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
