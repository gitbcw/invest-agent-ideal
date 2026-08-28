/**
 * T-402 工具结果体积预算（context engineering 三层启用的第 1 层）。
 *
 * 背景（2026-08-28 生产实测）：外部 MCP 大结果工具（quant_screen_stocks 单发
 * 119,724 字符 ≈6 万 token）把之后所有 agent 步骤的上下文整体抬高——mg 8-27
 * 有轮 4 次调用烧 46.5 万 input。行业归类为 context engineering 的「工具结果
 * 累积」问题，Mastra 官方推荐处理器钩子实现（toModelOutput 仅覆盖自建工具，
 * 外部 MCP 工具走本处理器）。
 *
 * 选 processLLMRequest 钩子：只改发给模型的本次调用内容，不落任何存储——
 * external_mcp_tool_calls 审计、trace、落库拿到的仍是完整结果。
 * 阈值 TOOL_RESULT_BUDGET_CHARS 默认 20,000 字符（≈1 万 token），0 关闭。
 */

export const DEFAULT_TOOL_RESULT_BUDGET_CHARS = 20_000;

type LlmPrompt = { system?: unknown; messages: Array<{ role: string; content: unknown }> };

/** Processor 形态（duck-typed：字段名与 @mastra/core/processors 的 Processor 对齐，
 * 不 import 框架类型——CJS 输出下 ESM type-only import 需要 resolution-mode）。 */
interface ToolResultBudgetProcessor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  processLLMRequest(args: { prompt: unknown }): { prompt?: unknown } | undefined;
}

const TRUNCATION_NOTICE = "\n\n[工具结果已按体积上限截断。如需完整数据，请用更小的 limit 或更窄的日期/范围参数重新查询；截断保留了结果开头部分。]";

export function toolResultBudgetChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.TOOL_RESULT_BUDGET_CHARS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TOOL_RESULT_BUDGET_CHARS;
}

/** 序列化 tool-result 的 output 值；文本直取，结构化值 JSON 化。 */
function serializeOutput(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const record = output as { type?: string; text?: unknown; value?: unknown };
    if (record.type === "text" && typeof record.text === "string") return record.text;
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

/**
 * 纯函数核心：对 LLM prompt 中超过预算的 tool-result 输出做截断。
 * 返回新对象（浅拷贝被改的消息与 part），未超限时原样返回同一引用。
 */
export function applyToolResultBudget(prompt: LlmPrompt, budgetChars: number): LlmPrompt {
  if (budgetChars <= 0) return prompt;
  let anyChanged = false;
  const messages = prompt.messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const record = part as { type?: string; output?: unknown };
      if (record.type !== "tool-result") return part;
      const text = serializeOutput(record.output);
      if (text === null || text.length <= budgetChars) return part;
      messageChanged = true;
      anyChanged = true;
      return {
        ...record,
        output: { type: "text", text: text.slice(0, budgetChars) + TRUNCATION_NOTICE },
      };
    });
    return messageChanged ? { ...message, content } : message;
  });
  return anyChanged ? { ...prompt, messages } : prompt;
}

/** 组装 processor。形态异常（messages 缺失/非数组）一律 pass-through——
 * 截断是增强，绝不因 prompt 形态差异让整轮失败（F1a/F1b 故障演练教训）。 */
export function createToolResultBudgetProcessor(env: NodeJS.ProcessEnv = process.env): ToolResultBudgetProcessor {
  const budget = toolResultBudgetChars(env);
  const isRewritable = (value: unknown): value is LlmPrompt =>
    Boolean(value) && typeof value === "object" && Array.isArray((value as LlmPrompt).messages);
  return {
    id: "tool-result-budget",
    name: "tool-result-budget",
    description: `Truncate tool-result outputs beyond ${budget} chars before each model call (model-facing only).`,
    processLLMRequest: (args) => {
      if (budget <= 0 || !isRewritable(args.prompt)) return undefined;
      const rewritten = applyToolResultBudget(args.prompt, budget);
      return rewritten === args.prompt ? undefined : { prompt: rewritten };
    },
  };
}
