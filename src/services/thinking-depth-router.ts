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
 *
 * 2026-08-28 裁撤 max 档（owner 依据 Z.ai Code Bench v1.0 官方数据）：Flash
 * High→Max 准确率仅 +约1pp（28.0%→29.0%）而平均输出 token 从 ≈70K 翻到
 * ≈140K（比 GLM-5.3 Max ≈75K 还啰嗦）；实盘 8-27 上线至 8-28 max 零命中。
 * 路由收窄为两档，裁判仍输出 max 时降档收敛到 high（保留高深度意图）。
 */

export type ThinkingDepth = "low" | "high";
export interface ThinkingDepthDecision {
  depth: ThinkingDepth;
  reason: string;
}

export const THINKING_DEPTH_ROUTER_MODEL = "glm-5.3-flash";
/** 深度 → 网关模型别名（new-api 双渠道：zai / zai-high）。 */
export const THINKING_DEPTH_MODELS: Record<ThinkingDepth, string> = {
  low: "glm-5.3-flash",
  high: "glm-5.3-flash-high",
};

/** 交互轮规则集 v3（2026-08-28）：v2 基础上裁撤 max 档（Z.ai Code Bench：Flash
 * High→Max 仅 +约1pp 而 token 近乎翻倍；实盘零命中），极限深度请求归 high。
 * v2 源自 14 天真实交互分类（docs/model-evaluation-2026-08-27-glm-qwen.md）。 */
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
- 用户明说"穷尽分析""最深入""不要怕慢"等极限深度要求（也选 high）

拿不准时选 low（宁可快，用户会追问）。`;

/** 自动化任务规则集 v2（2026-08-28）：v1 基础上裁撤 max 档，研究设计类归 high。
 * judge 对象是任务指令（每轮运行重复判定，规则集修订下一次运行即生效）。
 * 核心实验教训（论文 F1）：严格表格契约类任务思考越深输出违约率越高
 * （列数/文件名错误），low 是契约任务最优解。 */
export const THINKING_DEPTH_AUTOMATION_RULES = `你是自动化任务的思考深度路由器。下面是一条自动化任务的定义（指令），判断它需要哪种思考深度，只输出一个 JSON 对象：{"depth":"low"或"high","reason":"不超过20字的理由"}，不要输出其他内容。

low（默认档；产出有严格格式契约的任务）：
- 【最高优先级条款】凡任务输出策略为 update 或 create（写入工作簿、追加表格行、产出文件或结构化 JSON）的，一律判 low——即使任务描述含「推算/加权/评分/估算」等字样：数值推算由工具完成，模型只负责调用工具与整理结果；深度思考只留给叙述型产出任务。此条款优先于其他一切条款（2026-08-27 实盘教训：控盘度复盘被判 high 后 570s 超时）
- 【显式例句·临时补丁】「持仓及重点关注股票复盘（控盘度 V1.x 逐股四因子台账）」这类逐股评分台账 → low（筹码方向/量能结构由工具数据支撑，模型只整理成行）。【本例句为临时锚定，裁判在该边界的稳定性分析见 P-33 任务】
- 结构化数据采集与表尾追加（表格类复盘、扫描表、台账）
- 按既有模板/既定规则的复盘、选股、盯盘快照
- 简报/摘要推送（早报、盘中快报、涨跌汇总）
- 实验事实：表格契约类任务思考越深，耗时越长且列数/格式违约率越高（实测 deep 思考连续违约或超时、low 一次通过）

high（产出以分析叙述为主的任务）：
- 周报/月报中的深度复盘、趋势研判、逻辑归因（有叙述性章节的）
- 策略验证报告、假设检验、多空论证类任务
- 需要跨信息源综合并给出判断依据链的任务（含多源交叉研究、复杂策略设计）

拿不准时选 low。`;

const ROUTER_TIMEOUT_MS = 6_000;
const ROUTER_MAX_INPUT_CHARS = 4_000;

export async function classifyThinkingDepth(input: {
  text: string;
  /** interactive=用户消息走交互规则集；automation=任务指令走自动化规则集。 */
  mode?: "interactive" | "automation";
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<ThinkingDepthDecision> {
  const env = input.env ?? process.env;
  const doFetch = input.fetchImpl ?? fetch;
  const base = (env.MASTRA_GATEWAY_BASE_URL || env.GATEWAY_BASE_URL || env.OPENAI_BASE_URL || "").replace(/\/$/, "");
  const key = env.MASTRA_GATEWAY_API_KEY || env.GATEWAY_API_KEY || env.OPENAI_API_KEY || "";
  const text = input.text.trim();
  if (!base || !key || !text) return { depth: "low", reason: "router-skipped" };
  const rules = input.mode === "automation" ? THINKING_DEPTH_AUTOMATION_RULES : THINKING_DEPTH_ROUTING_RULES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("router-timeout")), ROUTER_TIMEOUT_MS);
  try {
    const res = await doFetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: THINKING_DEPTH_ROUTER_MODEL,
        messages: [
          { role: "system", content: rules },
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
    // max 已裁撤（2026-08-28）：裁判违规输出 max 时降档到 high，保留高深度意图。
    if (parsed.depth === "max") {
      return { depth: "high", reason: `max-collapsed-high:${typeof parsed.reason === "string" ? parsed.reason.slice(0, 40) : "router"}` };
    }
    return { depth: "low", reason: "router-unparsed-depth" };
  } catch (error) {
    return { depth: "low", reason: `router-error:${String((error as Error).message).slice(0, 40)}` };
  } finally {
    clearTimeout(timer);
  }
}
