/**
 * DeepSeek 思考模式 reasoning_content 回传兼容（2026-09-18 生产事故）。
 *
 * 事故链：DeepSeek 网关对流式请求校验——历史 assistant 消息带 tool_calls 时必须
 * 携带 reasoning_content 字段（空串/空格即可），字段缺失直接 400
 * invalid_request_error: "The `reasoning_content` in the thinking mode must be
 * passed back to the API."。而 @ai-sdk/openai-compatible 序列化 assistant 消息时
 * 只在 reasoning 文本非空时才输出该字段，deepseek-flash 默认开思考但并非每轮都
 * 输出思考文本：某轮空思考 → 字段缺失 → 下一轮工具结果回传请求必炸（探针是单轮
 * 永远测不出，通道会以健康身份反复被选中）。2026-09-15 mg、2026-09-18 111 的
 * daily-review 两次失败同源。
 *
 * 修复：processLLMRequest 阶段（prompt 已转为 LanguageModelV2Prompt、发出前最后
 * 一站）给「带 tool-call part 且无有效 reasoning part」的 assistant 消息补一个
 * 占位 reasoning part。占位文本须非空——序列化条件是 reasoning.length > 0，空串
 * 仍不输出字段；单空格已在生产网关实测通过（2026-09-18 诊断实验 F2/F3）。仿
 * @mastra/core ProviderHistoryCompat 的 cerebras 规则（方向相反：cerebras 要求剥、
 * deepseek 要求补），改写只作用于出站请求，持久化消息/审计不受影响。
 */

const PLACEHOLDER_REASONING_TEXT = " ";

interface PromptPart {
  type?: unknown;
  text?: unknown;
  [key: string]: unknown;
}

interface PromptMessage {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

/** 钩子的 model 参数可能是 undefined/字符串/描述符对象/数组，防御性提取可识别文本。 */
function modelIdentifier(model: unknown): string {
  if (model == null) return "";
  if (typeof model === "string") return model;
  if (Array.isArray(model)) return model.map((entry) => modelIdentifier(entry)).join(" ");
  if (typeof model === "object") {
    const record = model as Record<string, unknown>;
    for (const key of ["id", "modelId", "name"]) {
      const value = record[key];
      if (typeof value === "string") return value;
    }
    if ("model" in record) return modelIdentifier(record.model);
  }
  return "";
}

export function isDeepseekModel(model: unknown): boolean {
  return modelIdentifier(model).toLowerCase().includes("deepseek");
}

function isUsableReasoningText(text: unknown): boolean {
  return typeof text === "string" && text.trim().length > 0;
}

/**
 * 给缺有效思考文本的 tool-call assistant 消息补占位 reasoning part。
 * 无需改写时返回 undefined（保持引用相等，处理器链零开销跳过）。
 */
export function ensureDeepseekReasoningPlaceholders(prompt: unknown): unknown[] | undefined {
  if (!Array.isArray(prompt)) return undefined;
  let mutated = false;
  const next = prompt.map((message) => {
    if (message === null || typeof message !== "object") return message;
    const { role, content } = message as PromptMessage;
    if (role !== "assistant" || !Array.isArray(content)) return message;
    const parts = content as PromptPart[];
    const hasToolCall = parts.some((part) => part?.type === "tool-call");
    if (!hasToolCall) return message;
    const reasoningIndexes = parts
      .map((part, index) => (part?.type === "reasoning" ? index : -1))
      .filter((index) => index >= 0);
    if (reasoningIndexes.some((index) => isUsableReasoningText(parts[index]?.text))) return message;
    mutated = true;
    if (reasoningIndexes.length > 0) {
      // 已有空文本 reasoning part：补成占位文本即可让序列化输出字段。
      const patched = [...parts];
      const first = reasoningIndexes[0];
      patched[first] = { ...patched[first], text: PLACEHOLDER_REASONING_TEXT };
      return { ...message, content: patched };
    }
    return { ...message, content: [{ type: "reasoning", text: PLACEHOLDER_REASONING_TEXT }, ...parts] };
  });
  return mutated ? next : undefined;
}

/** 挂在 agent inputProcessors 上；非 deepseek 模型零改写。 */
export class DeepseekReasoningCompatProcessor {
  readonly id = "deepseek-reasoning-compat";
  readonly name = "Deepseek Reasoning Compat";

  processLLMRequest(args: { prompt?: unknown; model?: unknown }): { prompt: unknown[] } | undefined {
    if (!isDeepseekModel(args.model)) return undefined;
    const patched = ensureDeepseekReasoningPlaceholders(args.prompt);
    return patched ? { prompt: patched } : undefined;
  }
}
