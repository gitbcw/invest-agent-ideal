/**
 * 工具结果暂存与分片读取（2026-10-09 owner 裁决：截断升级为「预览 + 引用」）。
 *
 * 此前 tool-result-budget 对超预算结果是「全量丢弃 + 要求缩小重查」——预览
 * 都不给，模型只能盲重查一次（浪费步数与调用）。行业对照（Anthropic 上下文
 * 工程 just-in-time 检索 / MCP reference-URI 模式 / Claude Code head-tail）：
 * 保留头部预览，全量数据放上下文外按需分片拉取。
 *
 * 本模块提供进程内暂存库：外部 MCP observer 包装层（external-mcp.ts）在审计
 * 记录全量后，把超阈值结果改写为「预览 + result_ref」；模型用 toolresult.read
 * 按分片读取。条目按 scope 绑定（userId/instanceId/conversationId），跨会话
 * 不可读——这是安全边界，不是优化项。
 *
 * 进程内存储（非持久化）是有意选择：全量结果本就随轮次历史存在于内存与
 * trace，暂存只为「本轮与同会话短窗内」的分片复读；TTL 过期后模型按指引
 * 缩小查询重取，行为与升级前一致。
 */
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { logger } from "../lib/logger.js";
import { getMastraBindings } from "./bindings.js";

const MAX_ENTRIES = 150;
const ENTRY_TTL_MS = 2 * 60 * 60 * 1000;
const PREVIEW_CHARS = 2_400;
const READ_MAX_CHARS = 20_000;

/** 合成工具组 id：分片读取工具以常驻形式直挂，不进目录/调度壳。 */
export const TOOLRESULT_SERVER_ID = "toolresult";
export const TOOLRESULT_READ_TOOL_NAME = "toolresult.read";

export interface ToolResultOffloadScope {
  userId: string;
  projectId: string;
  instanceId: string;
  conversationId?: string;
}

interface OffloadEntry {
  ref: string;
  scope: ToolResultOffloadScope;
  serverId: string;
  toolName: string;
  content: string;
  createdAt: number;
  lastReadAt: number;
}

const store = new Map<string, OffloadEntry>();

function sweep(now: number): void {
  for (const [ref, entry] of store) {
    if (now - entry.lastReadAt > ENTRY_TTL_MS) store.delete(ref);
  }
  while (store.size > MAX_ENTRIES) {
    let oldest: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [ref, entry] of store) {
      if (entry.lastReadAt < oldestAt) {
        oldestAt = entry.lastReadAt;
        oldest = ref;
      }
    }
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function scopeMatches(entry: OffloadEntry, scope: ToolResultOffloadScope): boolean {
  if (entry.scope.userId !== scope.userId || entry.scope.instanceId !== scope.instanceId) return false;
  return !entry.scope.conversationId || !scope.conversationId || entry.scope.conversationId === scope.conversationId;
}

export function registerToolResultOffload(
  scope: ToolResultOffloadScope,
  serverId: string,
  toolName: string,
  content: string,
): string {
  const now = Date.now();
  const ref = `tr-${createHash("sha256").update(`${now}:${serverId}:${toolName}:${content.length}`).digest("hex").slice(0, 12)}`;
  store.set(ref, { ref, scope, serverId, toolName, content, createdAt: now, lastReadAt: now });
  sweep(now);
  return ref;
}

export interface OffloadReadResult {
  result_ref: string;
  offset_chars: number;
  chars: number;
  total_chars: number;
  remaining_chars: number;
  content: string;
}

export function readToolResultOffload(
  scope: ToolResultOffloadScope,
  ref: string,
  offsetChars: number,
  maxChars: number,
): OffloadReadResult | { error: string; message: string } {
  const entry = store.get(ref);
  if (!entry || Date.now() - entry.lastReadAt > ENTRY_TTL_MS) {
    return { error: "TOOL_RESULT_REF_NOT_FOUND", message: `${ref} 不存在或已过期（暂存约 2 小时内有效）。请缩小查询范围重新获取数据。` };
  }
  if (!scopeMatches(entry, scope)) {
    return { error: "TOOL_RESULT_REF_FORBIDDEN", message: "该结果引用不属于当前会话，不能读取。请缩小查询范围重新获取数据。" };
  }
  const offset = Math.max(0, Math.floor(offsetChars));
  const limit = Math.min(READ_MAX_CHARS, Math.max(200, Math.floor(maxChars)));
  if (offset >= entry.content.length) {
    return { result_ref: ref, offset_chars: offset, chars: 0, total_chars: entry.content.length, remaining_chars: 0, content: "" };
  }
  entry.lastReadAt = Date.now();
  const content = entry.content.slice(offset, offset + limit);
  return {
    result_ref: ref,
    offset_chars: offset,
    chars: content.length,
    total_chars: entry.content.length,
    remaining_chars: Math.max(0, entry.content.length - offset - content.length),
    content,
  };
}

/** 序列化工具输出为文本（MCP content 块优先，与 screening-preparation 同口径）。 */
function serializeOutputText(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const record = output as { type?: string; text?: unknown; value?: unknown; content?: unknown };
    if (record.type === "text" && typeof record.text === "string") return record.text;
    // MCP execute 返回形态：{content: [{type: "text", text}]}。
    if (Array.isArray(record.content)) {
      const text = record.content
        .filter((block): block is { type?: string; text?: unknown } => Boolean(block) && typeof block === "object")
        .find((block) => block.type === "text" && typeof block.text === "string");
      if (text) return text.text as string;
    }
    if (record.value !== undefined) {
      try {
        return JSON.stringify(record.value);
      } catch {
        return null;
      }
    }
    try {
      return JSON.stringify(output);
    } catch {
      return null;
    }
  }
  return null;
}

function buildPreview(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text;
  const head = text.slice(0, PREVIEW_CHARS);
  const cut = head.lastIndexOf("\n");
  return cut > PREVIEW_CHARS / 2 ? head.slice(0, cut) : head;
}

export interface OffloadEnvelope {
  status: "data_truncated_preview";
  result_ref: string;
  tool: string;
  original_chars: number;
  preview_chars: number;
  preview: string;
  instruction: string;
}

const OFFLOAD_INSTRUCTION = "全量结果已暂存（本会话约 2 小时内有效）。需要后续数据用 toolresult.read 按 result_ref 分片读取（offset_chars 起读、max_chars 每片上限）；预览只是开头，禁止据此判断全量覆盖。也可以缩小查询范围重新获取小结果。";

/**
 * 超阈值结果改写为「预览 + result_ref」信封，保持原返回值形态
 * （string / {type:"text"} / 内容块数组 / {value}）。未超阈值或形态
 * 不可识别时原样返回同一引用——改写是增强，不改变未命中路径。
 */
export function maybeOffloadToolResult(
  result: unknown,
  scope: ToolResultOffloadScope,
  serverId: string,
  toolName: string,
  thresholdChars: number,
): unknown {
  const text = serializeOutputText(result);
  if (text === null || thresholdChars <= 0 || text.length <= thresholdChars) return result;
  const preview = buildPreview(text);
  const envelope: OffloadEnvelope = {
    status: "data_truncated_preview",
    result_ref: registerToolResultOffload(scope, serverId, toolName, text),
    tool: `${serverId}.${toolName}`,
    original_chars: text.length,
    preview_chars: preview.length,
    preview,
    instruction: OFFLOAD_INSTRUCTION,
  };
  logger.info(`工具结果超预算改写为预览+引用 tool=${serverId}.${toolName} 原始=${text.length}字符 预览=${preview.length}字符 ref=${envelope.result_ref} 会话=${scope.conversationId ?? "-"}`);
  const envelopeText = JSON.stringify(envelope);
  if (typeof result === "string") return envelopeText;
  if (result && typeof result === "object") {
    const record = result as { type?: string; text?: unknown; value?: unknown; content?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      return { ...record, text: envelopeText };
    }
    if (Array.isArray(result)) {
      return result.map((block) =>
        block && typeof block === "object" && (block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string"
          ? { ...(block as Record<string, unknown>), text: envelopeText }
          : block,
      );
    }
    // MCP execute 返回形态：{content: [{type: "text", text}]}——只替换文本块。
    if (Array.isArray(record.content)) {
      return {
        ...record,
        content: record.content.map((block) =>
          block && typeof block === "object" && (block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string"
            ? { ...(block as Record<string, unknown>), text: envelopeText }
            : block,
        ),
      };
    }
    if (record.value !== undefined) {
      return { ...record, value: envelope };
    }
    // structuredContent 形态（@mastra/mcp 对带结构化输出的工具直接返回解析后
    // 的普通对象，如 {columns, rows, meta}）：整体替换为信封对象。模型侧由
    // Mastra 序列化为 JSON 文本；程序化消费方按 status 字段识别并经暂存库
    // 解包全文（screening-preparation.parseToolText）。
    return envelope;
  }
  return result;
}

/** 模型侧分片读取工具（常驻；scope 由注入点闭包绑定）。 */
export async function createToolResultReadTool(scope: ToolResultOffloadScope): Promise<unknown> {
  const bindings = await getMastraBindings();
  if (!bindings.createTool) throw new Error("MASTRA_BINDINGS_INVALID: createTool unavailable");
  return bindings.createTool({
    id: "toolresult.read",
    description: "读取被截断暂存的工具结果分片。超预算的外部数据工具结果只返回预览与 result_ref；用本工具按 offset_chars/max_chars 分片读取全量（本会话内有效）。先用小分片定位，再按需续读。",
    inputSchema: z.object({
      result_ref: z.string().describe("截断结果信封里的 result_ref（tr- 开头）"),
      offset_chars: z.number().int().min(0).default(0).describe("起始字符偏移，从 0 开始"),
      max_chars: z.number().int().min(200).max(READ_MAX_CHARS).default(8_000).describe("本片字符数上限"),
    }),
    execute: async (raw: Record<string, unknown>) => {
      const ref = String(raw?.result_ref ?? "");
      if (!ref.startsWith("tr-")) {
        return { error: "TOOL_RESULT_REF_INVALID", message: "result_ref 应为截断结果信封里 tr- 开头的引用。" };
      }
      return readToolResultOffload(scope, ref, Number(raw?.offset_chars ?? 0), Number(raw?.max_chars ?? 8_000));
    },
  });
}

/** 服务端全文读取（程序化消费方解包用，非模型面）：scope 校验同分片读取。 */
export function readFullToolResultOffload(
  scope: ToolResultOffloadScope,
  ref: string,
): string | null {
  const entry = store.get(ref);
  if (!entry || Date.now() - entry.lastReadAt > ENTRY_TTL_MS) return null;
  if (!scopeMatches(entry, scope)) return null;
  entry.lastReadAt = Date.now();
  return entry.content;
}

/** Test hook：清空暂存库。 */
export function __resetToolResultOffloadForTest(): void {
  store.clear();
}

/** Test hook：当前条目数。 */
export function __toolResultOffloadSizeForTest(): number {
  return store.size;
}
