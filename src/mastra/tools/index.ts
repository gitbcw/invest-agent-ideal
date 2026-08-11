import { z } from "zod/v4";
import { callServiceTool as defaultCallServiceTool, type ServiceToolContext } from "../../mcp/service-tools-core.js";
import { TOOL_SPECS, type ToolSpec } from "./registry.js";
import { checkToolScope, scopeDeniedResult, type MastraToolContext } from "./scope-guard.js";

export interface InProcessTool {
  id: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  execute(input: Record<string, unknown> | undefined, context?: unknown): Promise<unknown>;
}

export interface InProcessToolsetOptions {
  specs?: readonly ToolSpec[];
  callServiceTool?: typeof defaultCallServiceTool;
  /** Bound per request when the Mastra runtime does not expose execute context. */
  context?: MastraToolContext;
}

export function createInProcessToolset(options: InProcessToolsetOptions = {}): readonly InProcessTool[] {
  const call = options.callServiceTool ?? defaultCallServiceTool;
  return (options.specs ?? TOOL_SPECS).map((spec) => ({
    id: spec.id,
    description: spec.description,
    inputSchema: z.object(spec.inputSchema),
    async execute(input: Record<string, unknown> | undefined, context?: unknown): Promise<unknown> {
      const requestContext = context ?? options.context;
      const decision = checkToolScope(spec.id, requestContext);
      if (!decision.allowed) return scopeDeniedResult(spec.id, decision.reason ?? "scope denied");
      const parsed = this.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        return { ok: false, error: "invalid_tool_input", tool: spec.id, message: parsed.error.message };
      }
      // Context is an in-memory request object. It is never serialized into a token file.
      return call(spec.id, parsed.data as Record<string, unknown>, requestContext as ServiceToolContext);
    },
  }));
}

export function findInProcessTool(toolName: string, options: InProcessToolsetOptions = {}): InProcessTool | undefined {
  return createInProcessToolset(options).find((tool) => tool.id === toolName);
}

export function summarizeToolCall(toolName: string, input: unknown, output: unknown): { toolName: string; inputChars?: number; outputChars?: number } {
  const size = (value: unknown) => {
    try { return JSON.stringify(value)?.length; } catch { return undefined; }
  };
  return { toolName, ...(size(input) !== undefined ? { inputChars: size(input) } : {}), ...(size(output) !== undefined ? { outputChars: size(output) } : {}) };
}

export * from "./registry.js";
export * from "./scope-guard.js";
