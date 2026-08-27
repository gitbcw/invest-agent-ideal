import { logger } from "../lib/logger.js";

/**
 * 共创期思考深度路由（owner 2026-08-27 裁决）：交互轮落点为 glm-5.3-flash 时，
 * 用 glm-flash(low) 作裁判模型按下面这份版本化规则集判 low/high，high 时主轮
 * 换深度别名 glm-5.3-flash-high（new-api 双渠道实现，渠道级 param_override）。
 *
 * 为什么是「裁判模型 + 规则文档」而不是写死的代码分支：渠道/长度/动词等启发式
 * 各自都有反例（微信也有复杂问题，短提示也可能是追问），owner 明确要求路由判
 * 断本身交给模型。规则集是给裁判模型读的——bad case 反哺 = 修订本规则集 +
 * 提交部署，裁判行为随之进化，代码不动。裁判成本 ~¥0.0014/次（flash low），
 * 失败一律 fail-open 回 low（宁可快，用户会追问）。
 */

export type ThinkingDepth = "low" | "high";
export interface ThinkingDepthDecision {
  depth: ThinkingDepth;
  reason: string;
}

export const THINKING_DEPTH_ROUTER_MODEL = "glm-5.3-flash";
export const THINKING_DEPTH_HIGH_MODEL = "glm-5.3-flash-high";

/** 规则集 v1（2026-08-27）：源自 14 天真实交互分类（docs/model-evaluation-2026-08-27-glm-qwen.md）。 */
export const THINKING_DEPTH_ROUTING_RULES = `你是思考深度路由器。判断这条用户消息需要哪种思考深度，只输出一个 JSON 对象：{"depth":"low"或"high","reason":"不超过20字的理由"}，不要输出其他内容。

low（默认档；执行、查询、格式化产出类）：
- 确认/取消/选项（如"确认""A""1""继续"）与纯寒暄问候
- 持仓调整等指令执行；要求发送已有的文件/公式/模板/表格
- 速查与简报：早报/盘中快报/今日关注/行情怎么样/某股票今天怎么样/总结消息
- 数据查询：查价格、资金流、筹码、持仓明细、列出数值
- 按既有模板或既定规则产出：模板化复盘、按规则选股、整理成表格
- 任务失败原因询问、要求重新生成

high（需要多步推理、权衡、推算或批判性判断）：
- 财报/基本面深度分析：现金流、存货、盈利质量、同行横向对比
- 策略设计/迭代/验证：设计规则、估算权重、版本对比、批判性质疑、假设验证
- 需要推算的技术问题：指标交叉位置预估、参数推算
- 政策/文章内容映射到行业与个股的筛选推理
- 多约束权衡的开放决策问题（该不该买卖、如何配置）需要论据链
- 用户明确要求"深入分析""仔细想想"

拿不准时选 low（宁可快，用户会追问）。`;

const ROUTER_TIMEOUT_MS = 6_000;
const ROUTER_MAX_INPUT_CHARS = 4_000;

export async function classifyThinkingDepth(input: {
  text: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<ThinkingDepthDecision> {
  const env = input.env ?? process.env;
  const doFetch = input.fetchImpl ?? fetch;
  const base = (env.MASTRA_GATEWAY_BASE_URL || env.GATEWAY_BASE_URL || env.OPENAI_BASE_URL || "").replace(/\/$/, "");
  const key = env.MASTRA_GATEWAY_API_KEY || env.GATEWAY_API_KEY || env.OPENAI_API_KEY || "";
  const text = input.text.trim();
  if (!base || !key || !text) return { depth: "low", reason: "router-skipped" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("router-timeout")), ROUTER_TIMEOUT_MS);
  try {
    const res = await doFetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: THINKING_DEPTH_ROUTER_MODEL,
        messages: [
          { role: "system", content: THINKING_DEPTH_ROUTING_RULES },
          { role: "user", content: text.slice(0, ROUTER_MAX_INPUT_CHARS) },
        ],
        max_tokens: 1024,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { depth: "low", reason: `router-http-${res.status}` };
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { depth: "low", reason: "router-unparsed" };
    const parsed = JSON.parse(match[0]) as { depth?: unknown; reason?: unknown };
    if (parsed.depth === "high" || parsed.depth === "low") {
      return { depth: parsed.depth, reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 60) : "router" };
    }
    return { depth: "low", reason: "router-unparsed-depth" };
  } catch (error) {
    return { depth: "low", reason: `router-error:${String((error as Error).message).slice(0, 40)}` };
  } finally {
    clearTimeout(timer);
  }
}
