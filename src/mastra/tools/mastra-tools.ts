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

/**
 * 2026-08-27（mg 行业复盘 glm 卡死定性）：带服务层 mcpAllowedTools 授权的轮次
 * （通用自动化等）此前把全部 ~49 个服务工具的 schema 都下发给模型（叠加外部
 * MCP 共 90 工具 / 38.7k token 输入），执行时拦截虽在，清单膨胀本身就是主要
 * 成本——思考型模型每步思考 4 分钟，多步必穿 8 分钟单次尝试窗口。授权即清单：
 * 只保留 grant 内的服务工具。外部 MCP 只读数据面与 workspace/skill 工具不在
 * 此过滤范围（数据来源与暂存文件流可能依赖）。
 */
export function filterServiceToolsByGrant(
  tools: Record<string, unknown>,
  grant: string[] | undefined,
): Record<string, unknown> {
  if (!grant || grant.length === 0) return tools;
  const allowed = new Set(grant);
  return Object.fromEntries(Object.entries(tools).filter(([name]) => allowed.has(name)));
}
