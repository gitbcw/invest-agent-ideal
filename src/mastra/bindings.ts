/**
 * The only module allowed to know how Mastra is loaded.
 *
 * @mastra/core is ESM-first while this project emits Node16/CommonJS output.
 * A dynamic import keeps package loading out of static TypeScript interop and
 * lets tests supply a fake Agent constructor without loading the real package.
 */

import type { MastraAgentLike } from "./types.js";

export type MastraAgentConstructor = new (options: Record<string, unknown>) => MastraAgentLike;
export type MastraCreateTool = (options: Record<string, unknown>) => unknown;

export interface MastraBindings {
  Agent: MastraAgentConstructor;
  createTool?: MastraCreateTool;
}

export type MastraBindingsProvider =
  | MastraBindings
  | PromiseLike<MastraBindings>
  | (() => MastraBindings | PromiseLike<MastraBindings>);

let defaultBindingsPromise: Promise<MastraBindings> | undefined;

async function loadDefaultBindings(): Promise<MastraBindings> {
  const module = await import("@mastra/core/agent");
  const Agent = (module as unknown as { Agent?: unknown }).Agent;
  if (typeof Agent !== "function") {
    throw new Error("MASTRA_BINDINGS_INVALID: @mastra/core/agent did not export Agent");
  }
  const toolsModule = await import("@mastra/core/tools");
  const createTool = (toolsModule as unknown as { createTool?: unknown }).createTool;
  if (typeof createTool !== "function") {
    throw new Error("MASTRA_BINDINGS_INVALID: @mastra/core/tools did not export createTool");
  }
  return { Agent: Agent as MastraAgentConstructor, createTool: createTool as MastraCreateTool };
}

/** Load real Mastra bindings lazily and cache only the package import. */
export function getMastraBindings(): Promise<MastraBindings> {
  if (!defaultBindingsPromise) defaultBindingsPromise = loadDefaultBindings();
  return defaultBindingsPromise;
}

/** Resolve an injected binding without touching the real Mastra package. */
export async function resolveMastraBindings(provider?: MastraBindingsProvider): Promise<MastraBindings> {
  if (provider === undefined) return getMastraBindings();
  if (typeof provider === "function") return provider();
  return provider;
}

/** Test-only cache reset; no production caller uses it. */
export function resetMastraBindingsForTest(): void {
  defaultBindingsPromise = undefined;
}
