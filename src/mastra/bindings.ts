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
export type MastraWorkspaceConstructor = new (options: Record<string, unknown>) => MastraWorkspaceLike;
export type MastraLocalFilesystemConstructor = new (options: Record<string, unknown>) => unknown;
export type MastraRequestContextConstructor = new () => MastraRequestContextLike;

export interface MastraWorkspaceLike {
  destroy?: () => Promise<void> | void;
}

export interface MastraRequestContextLike {
  set(key: string, value: unknown): void;
  get?(key: string): unknown;
}

export interface MastraBindings {
  Agent: MastraAgentConstructor;
  createTool?: MastraCreateTool;
  Workspace?: MastraWorkspaceConstructor;
  LocalFilesystem?: MastraLocalFilesystemConstructor;
  RequestContext?: MastraRequestContextConstructor;
  /** T-402：ToolCallFilter 构造器（@mastra/core/processors），供旧工具结果剔除。 */
  ToolCallFilter?: new (options?: { exclude?: string[]; filterAfterToolSteps?: number; preserveModelOutput?: boolean }) => unknown;
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
  const workspaceModule = await import("@mastra/core/workspace");
  const Workspace = (workspaceModule as unknown as { Workspace?: unknown }).Workspace;
  const LocalFilesystem = (workspaceModule as unknown as { LocalFilesystem?: unknown }).LocalFilesystem;
  if (typeof Workspace !== "function" || typeof LocalFilesystem !== "function") {
    throw new Error("MASTRA_BINDINGS_INVALID: @mastra/core/workspace did not export Workspace and LocalFilesystem");
  }
  const contextModule = await import("@mastra/core/request-context");
  const RequestContext = (contextModule as unknown as { RequestContext?: unknown }).RequestContext;
  if (typeof RequestContext !== "function") {
    throw new Error("MASTRA_BINDINGS_INVALID: @mastra/core/request-context did not export RequestContext");
  }
  const processorsModule = await import("@mastra/core/processors");
  const ToolCallFilter = (processorsModule as unknown as { ToolCallFilter?: unknown }).ToolCallFilter;
  // 增强能力缺失时静默降级（该 processor 不挂），不让 Agent 构造整体失败。
  return {
    Agent: Agent as MastraAgentConstructor,
    createTool: createTool as MastraCreateTool,
    Workspace: Workspace as MastraWorkspaceConstructor,
    LocalFilesystem: LocalFilesystem as MastraLocalFilesystemConstructor,
    RequestContext: RequestContext as MastraRequestContextConstructor,
    ...(typeof ToolCallFilter === "function" ? { ToolCallFilter: ToolCallFilter as MastraBindings["ToolCallFilter"] } : {}),
  };
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

/** Build a real RequestContext at the ESM boundary, never a plain browser payload. */
export async function createMastraRequestContext(values: Record<string, unknown>): Promise<MastraRequestContextLike> {
  const bindings = await getMastraBindings();
  if (!bindings.RequestContext) throw new Error("MASTRA_BINDINGS_INVALID: RequestContext is unavailable");
  const requestContext = new bindings.RequestContext();
  for (const [key, value] of Object.entries(values)) requestContext.set(key, value);
  return requestContext;
}
