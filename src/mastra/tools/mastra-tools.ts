import { getMastraBindings, type MastraBindingsProvider } from "../bindings.js";
import { createInProcessToolset } from "./index.js";
import type { MastraToolContext } from "./scope-guard.js";

/** Build genuine Mastra Tool instances, closing only over the in-memory request scope. */
export async function createMastraToolMap(
  context: MastraToolContext,
  bindings: MastraBindingsProvider = getMastraBindings,
): Promise<Record<string, unknown>> {
  const resolved = typeof bindings === "function" ? await bindings() : await bindings;
  if (!resolved.createTool) throw new Error("MASTRA_BINDINGS_INVALID: createTool unavailable");
  return Object.fromEntries(createInProcessToolset({ context }).map((tool) => [tool.id, resolved.createTool!({
    id: tool.id,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: (input: Record<string, unknown>) => tool.execute(input),
  })]));
}
