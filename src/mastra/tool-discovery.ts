/**
 * T-400 两段式工具发现（docs/tool-injection-strategy.md，owner 2026-08-28 裁决）：
 * 交互轮不再全量下发 90 工具（38.7k token），改为「常驻核心 + 目录 + 调度壳」
 * 的渐进式披露——参照 Anthropic Tool Search（defer_loading 无平台能力时的
 * 调用方等价物）。
 *
 * 两条轨道同一模式：
 * - 服务工具轨：核心集全量 schema + svc.catalog/svc.call；壳 delegate 到被
 *   过滤工具的原对象（scope guard / 确认流 / callServiceTool 审计全继承）。
 * - 外部 MCP 轨：mdt top5 + qsse 全部长尾化；壳 delegate 到 observer 包装后的
 *   全量 Tool（external_mcp_tool_calls 审计零新代码）。
 * 目录从 Tool 对象/TOOL_SPECS 自动生成，新工具上线即自动可见，零人工维护。
 * 授权轮（mcpAllowedTools 非空）与 automation 通道不走本模块（各自已有清单机制）。
 * 回退：INTERACTIVE_TOOL_DISCOVERY=off 一键恢复全量。
 */
import { z } from "zod/v4";
import { getMastraBindings, type MastraBindingsProvider } from "./bindings.js";
import { TOOL_SPECS } from "./tools/registry.js";

/** 交互轮服务工具常驻核心集（流程必备 13 + 高频读 5；docs §3.2）。 */
export const INTERACTIVE_CORE_SERVICE_TOOLS: readonly string[] = [
  // 确认流与会话流程（结构性依赖，频次无关）
  "confirmations.pending",
  "confirmations.request",
  "conversation.history",
  "file.parse",
  // 工作簿与交付
  "spreadsheet.create",
  "spreadsheet.transform",
  "reviews.save",
  "artifacts.publish",
  // 资产核心读写（管理类 rename/archive/delete 走目录，有确认流兜底）
  "assets.list",
  "assets.version.read",
  "assets.version.commit",
  "assets.conversation.save",
  "assets.attachment.save",
  // 高频读（W13 持仓台账 ~40% 交互 + 联网检索）
  "portfolio.read",
  "watchlist.read",
  "plans.read",
  "research.web_search",
  "research.news_search",
];

/** 外部 MCP 每 server 的常驻核心工具（30 天调用画像前五；qsse 全走目录）。 */
export const EXTERNAL_CORE_TOOLS: Record<string, readonly string[]> = {
  "market-data-tool": [
    "get_stock_news",
    "get_realtime_quote",
    "get_stock_profile",
    "get_hist_kline",
    "get_market_summary",
  ],
  "qsse-qlib": [],
};

const CATALOG_HINT = "需要清单里没有的数据或管理能力时：先调用本目录工具查看可用工具名与参数，再用同名 call 调度工具执行（name 用目录中的原始名）。";

/** 模型看到的调度工具短名（docs §3：mdt.catalog / mdt.call / qsse.catalog / qsse.call / svc.*）。 */
function serverLabel(serverId: string): string {
  if (serverId === "market-data-tool") return "mdt";
  if (serverId === "qsse-qlib") return "qsse";
  return serverId.replace(/[^a-z0-9]/gi, "");
}

export function interactiveToolDiscoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INTERACTIVE_TOOL_DISCOVERY !== "off";
}

/** 目录行摘要：描述首句（首个句号/分号/换行截断）。 */
function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const cut = [clean.indexOf("。"), clean.indexOf("; "), clean.indexOf("；"), clean.indexOf("\n")].filter((i) => i > 0);
  const end = cut.length > 0 ? Math.min(...cut) : clean.length;
  return clean.length > 90 ? `${clean.slice(0, 90)}…` : clean.slice(0, end > 90 ? 90 : end).trim();
}

function extractSchemaKeys(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (shape && typeof shape === "object") return Object.keys(shape);
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (properties && typeof properties === "object") return Object.keys(properties);
  // zod raw shape（TOOL_SPECS 形态）本身就是 {name: ZodType} 的普通对象。
  return Object.keys(schema as Record<string, unknown>);
}

function toolNameCandidates(name: string, prefixes: readonly string[]): string[] {
  const trimmed = name.trim();
  const variants = new Set([trimmed]);
  for (const prefix of prefixes) {
    const marker = `${prefix}__`;
    if (trimmed.startsWith(marker)) variants.add(trimmed.slice(marker.length));
    else variants.add(`${prefix}__${trimmed}`);
  }
  return [...variants];
}

interface ToolLike {
  id?: string;
  description?: string;
  inputSchema?: unknown;
  execute: (input: never) => Promise<unknown>;
}

function isToolLike(tool: unknown): tool is ToolLike {
  return Boolean(tool) && typeof tool === "object" && typeof (tool as { execute?: unknown }).execute === "function";
}

function buildServiceCatalogLines(): string[] {
  const core = new Set(INTERACTIVE_CORE_SERVICE_TOOLS);
  return TOOL_SPECS
    .filter((spec) => !core.has(spec.id))
    .map((spec) => `- ${spec.id}（参数：${extractSchemaKeys(spec.inputSchema).join(", ") || "无"}）：${firstSentence(spec.description)}`);
}

function buildExternalCatalogLines(toolset: Record<string, unknown>, core: readonly string[], serverId: string): string[] {
  const coreSet = new Set(core);
  return Object.entries(toolset)
    .filter(([name, tool]) => !coreSet.has(name) && isToolLike(tool))
    .map(([name, tool]) => {
      const params = extractSchemaKeys((tool as { inputSchema?: unknown }).inputSchema);
      const desc = typeof (tool as { description?: unknown }).description === "string"
        ? firstSentence((tool as { description?: string }).description ?? "")
        : "";
      return `- ${name}${params.length ? `（参数：${params.join(", ")}）` : "（参数：见目录工具返回）"}${desc ? `：${desc}` : `：${serverId} 长尾工具`}`;
    });
}

async function createDiscoveryTools(bindings: MastraBindingsProvider, spec: {
  catalogText: () => string;
  delegate: (name: string) => ToolLike | undefined;
  serverLabel: string;
  prefixes: readonly string[];
}) {
  const resolved = typeof bindings === "function" ? await bindings() : await bindings;
  if (!resolved.createTool) throw new Error("MASTRA_BINDINGS_INVALID: createTool unavailable");
  const { createTool } = resolved;
  const catalog = createTool({
    id: `${spec.serverLabel}.catalog`,
    description: `${spec.serverLabel} 长尾工具目录（一次返回全部，无搜索）。${CATALOG_HINT}`,
    inputSchema: {},
    execute: async () => spec.catalogText(),
  });
  const call = createTool({
    id: `${spec.serverLabel}.call`,
    description: `${spec.serverLabel} 工具调度：name 填目录中的原始工具名，input 为该工具的参数对象。未知名称返回错误与目录提示。`,
    inputSchema: {
      name: z.string().describe("目标工具名（见 catalog 目录）"),
      input: z.record(z.string(), z.any()).optional().describe("目标工具的参数对象"),
    },
    execute: async (raw: Record<string, unknown>) => {
      const name = String(raw?.name ?? "");
      const input = (raw?.input && typeof raw.input === "object" ? raw.input : {}) as Record<string, unknown>;
      let target: ToolLike | undefined;
      for (const candidate of toolNameCandidates(name, spec.prefixes)) {
        target = spec.delegate(candidate);
        if (target) break;
      }
      if (!target) {
        return {
          error: "TOOL_NOT_IN_CATALOG",
          message: `${name} 不可用。先调用 ${spec.serverLabel}.catalog 查看可用工具名与参数，再以原始名重试。`,
        };
      }
      return await target.execute(input as never);
    },
  });
  return { catalog, call };
}

/**
 * 服务工具轨：过滤到交互核心集并注入 svc.catalog / svc.call。
 * 壳 delegate 到全量 mastraTools 中被过滤掉的原对象——scope guard、确认流、
 * callServiceTool 审计全部继承，无任何旁路。
 */
export async function applyInteractiveServiceToolDiscovery(
  tools: Record<string, unknown>,
  bindings: MastraBindingsProvider = getMastraBindings,
): Promise<Record<string, unknown>> {
  const core = new Set(INTERACTIVE_CORE_SERVICE_TOOLS);
  const fullMap = new Map<string, ToolLike>();
  const publicTools: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (isToolLike(tool)) fullMap.set(name, tool);
    if (core.has(name)) publicTools[name] = tool;
  }
  const { catalog, call } = await createDiscoveryTools(bindings, {
    catalogText: () => [`【服务工具长尾目录（经 svc.call 调用；常驻工具直接调用）】`, ...buildServiceCatalogLines()].join("\n"),
    delegate: (name) => fullMap.get(name),
    serverLabel: "svc",
    prefixes: ["svc"],
  });
  publicTools["svc.catalog"] = catalog;
  publicTools["svc.call"] = call;
  return publicTools;
}

/**
 * 外部 MCP 轨：每 server 保留核心工具，其余替换为 mdt.catalog / mdt.call
 * （serverId 保留原 id，模型看到的工具名前缀规则不变）。
 * 输入必须已经是 observer 包装后的 toolsets——壳 delegate 到其中的原对象，
 * external_mcp_tool_calls 审计自动发生。
 */
export async function applyInteractiveExternalToolDiscovery(
  observedToolsets: Record<string, unknown>,
  bindings: MastraBindingsProvider = getMastraBindings,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [serverId, toolset] of Object.entries(observedToolsets)) {
    if (!toolset || typeof toolset !== "object") {
      result[serverId] = toolset;
      continue;
    }
    const container = toolset as { tools?: Record<string, unknown> };
    const tools = container.tools && typeof container.tools === "object" ? container.tools : toolset as Record<string, unknown>;
    const core = EXTERNAL_CORE_TOOLS[serverId] ?? [];
    const coreSet = new Set(core);
    const fullMap = new Map<string, ToolLike>();
    let anyToolLike = false;
    const kept: Record<string, unknown> = {};
    for (const [name, tool] of Object.entries(tools)) {
      if (isToolLike(tool)) {
        anyToolLike = true;
        fullMap.set(name, tool);
      }
      if (coreSet.has(name)) kept[name] = tool;
    }
    if (!anyToolLike) {
      // 形态不符合（保留原样，宁可全量也不破坏运行）
      result[serverId] = toolset;
      continue;
    }
    const label = serverLabel(serverId);
    const { catalog, call } = await createDiscoveryTools(bindings, {
      catalogText: () => [`【${serverId} 长尾工具目录（经 ${label}.call 调用；常驻工具直接调用）】`, ...buildExternalCatalogLines(tools, core, serverId)].join("\n"),
      delegate: (name) => fullMap.get(name),
      serverLabel: label,
      prefixes: [serverId, label],
    });
    const merged: Record<string, unknown> = { ...kept };
    merged[`${label}.catalog`] = catalog;
    merged[`${label}.call`] = call;
    result[serverId] = container.tools ? { ...container, tools: merged } : merged;
  }
  return result;
}
