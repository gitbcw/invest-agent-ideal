/**
 * Per-model pricing registry (E10 / D24, cost-statistics-design.md).
 *
 * Prices are product configuration data (D9): versioned in Git, changed by
 * commit. Costs are computed at trace-write time so historical rows keep the
 * price they were billed at; re-pricing is an explicit backfill decision.
 *
 * 2026-08-16 重述（用户裁决）：计价币种改为人民币（CNY）。国产模型按官方
 * 人民币牌价；GPT 系列按 OpenAI 官方美元价 × 记账汇率换算。换内核
 * （Mastra）之前的历史成本数据已归档清空，全部 trace 按本表重算。
 *
 * Rate units: price per one million tokens, CNY (元).
 *
 * Sources (2026-08-16 检索):
 *   - OpenAI pricing: gpt-5.6-sol $5/$30, terra $2/$12, luna $0.2/$1.2
 *   - DeepSeek API 官方: v4-flash 输入1元(缓存命中0.02元)/输出2元;
 *     v4-pro 输入3元(缓存命中0.025元)/输出6元（2026-08-17 起峰谷价未采用，
 *     按当前单一价记账）
 *   - 火山方舟: Doubao-Seed 主力档 输入6元/输出30元（lite/turbo 实际更低，
 *     未获官方精确牌价前按主力档保守上界记账，启用后按价格计算器校准）
 *   - 记账汇率 USD→CNY = 6.75（2026-08-16 中间价 6.7878 / 市场价 6.74 区间取整）
 *
 * Conventions (provider-aligned defaults):
 *   - thought tokens are generated tokens -> priced at the output rate
 *   - cached reads -> 10% of the input rate unless the provider publishes one
 *   - cached writes -> v1 records tokens but prices at 0 (registry slot kept)
 */

export interface ModelPriceTier {
  /** Price per 1M input tokens (CNY). */
  input: number;
  /** Price per 1M output tokens (CNY). */
  output: number;
  /** Price per 1M reasoning/thought tokens. Defaults to the output rate. */
  thought?: number;
  /** Price per 1M cached-read tokens. Defaults to input / 10. */
  cacheRead?: number;
  /** Price per 1M cached-write tokens. Defaults to 0 (recorded, not priced). */
  cacheWrite?: number;
}

export interface ModelPricingEntry {
  /** Bare model id as recorded in agent_traces.agent_model (no gateway prefix). */
  model: string;
  currency: "CNY";
  /** Single-rate tier (also the pre-cutover price for time-tiered models). */
  tier: ModelPriceTier;
  /** Peak/off-peak schedule (DeepSeek 2026-08-17 起). */
  timeTiered?: TimeTieredPricing;
}

export interface TimeTieredPricing {
  /** ISO instant the peak/off-peak schedule takes effect (Beijing 2026-08-17 00:00). */
  effectiveFrom: string;
  /** Beijing-time windows [startHour, endHour) billed at the peak rate. */
  peakWindowsUtcPlus8: Array<[number, number]>;
  peak: ModelPriceTier;
  offPeak: ModelPriceTier;
}

/** Bookkeeping FX rate for USD-listed models. Adjust by commit, not per row. */
export const USD_TO_CNY_RATE = 6.75;

const usd = (input: number, output: number): ModelPriceTier => ({
  input: Math.round(input * USD_TO_CNY_RATE * 100) / 100,
  output: Math.round(output * USD_TO_CNY_RATE * 100) / 100,
});

const GPT_5_6_TIERS: Record<"sol" | "terra" | "luna", ModelPriceTier> = {
  sol: usd(5, 30),    // ¥33.75 / ¥202.50
  terra: usd(2, 12),  // ¥13.50 / ¥81.00
  luna: usd(0.2, 1.2) // ¥1.35 / ¥8.10
};

export const MODEL_PRICING: ModelPricingEntry[] = [
  { model: "gpt-5.6-sol", currency: "CNY", tier: GPT_5_6_TIERS.sol },
  { model: "gpt-5.6-terra", currency: "CNY", tier: GPT_5_6_TIERS.terra },
  { model: "gpt-5.6-luna", currency: "CNY", tier: GPT_5_6_TIERS.luna },
  {
    model: "deepseek-v4-flash", currency: "CNY",
    tier: { input: 1, output: 2, cacheRead: 0.02 },
    timeTiered: {
      // 2026-08-17 00:00 北京时间生效；高峰 9-12 / 14-18 点，空闲价 = 高峰一半。
      effectiveFrom: "2026-08-16T16:00:00.000Z",
      peakWindowsUtcPlus8: [[9, 12], [14, 18]],
      peak: { input: 3.0, output: 9.0, cacheRead: 0.10 },
      offPeak: { input: 1.5, output: 4.5, cacheRead: 0.05 },
    },
  },
  {
    model: "deepseek-v4-pro", currency: "CNY",
    tier: { input: 3, output: 6, cacheRead: 0.025 },
    timeTiered: {
      effectiveFrom: "2026-08-16T16:00:00.000Z",
      peakWindowsUtcPlus8: [[9, 12], [14, 18]],
      peak: { input: 9.0, output: 27.0, cacheRead: 0.30 },
      offPeak: { input: 4.5, output: 13.5, cacheRead: 0.15 },
    },
  },
  { model: "doubao-seed-2-0-lite-260428", currency: "CNY", tier: { input: 6, output: 30 } },
  { model: "doubao-seed-2-1-turbo-260628", currency: "CNY", tier: { input: 6, output: 30 } },
];

/**
 * 网关侧自定义变体（-none / -max 后缀）没有独立官方牌价，按其基础型号
 * 同档计价；真正未知的新型号仍走 DEFAULT_TIER 并在聚合层计 unpricedCalls。
 */
const MODEL_ALIASES: Record<string, string> = {
  "deepseek-v4-flash-none": "deepseek-v4-flash",
  "deepseek-v4-flash-max": "deepseek-v4-flash",
  "deepseek-v4-pro-none": "deepseek-v4-pro",
  "deepseek-v4-pro-max": "deepseek-v4-pro",
};

/** Fallback for models absent from the registry (flagged, never silent). */
export const DEFAULT_TIER: ModelPriceTier = GPT_5_6_TIERS.terra;

export type CostSource = "gateway" | "priced" | "priced-fallback";

export interface ModelCostResult {
  amount: number;
  currency: "CNY";
  /** "gateway" = provider-reported actual; "priced" = registry hit; "priced-fallback" = DEFAULT_TIER. */
  source: CostSource;
}

function resolveRegistryModel(normalized: string): string {
  return MODEL_ALIASES[normalized] ?? normalized;
}

const PRICING_BY_MODEL = new Map(MODEL_PRICING.map((entry) => [entry.model, entry]));

export function normalizeModelId(model: string | undefined | null): string {
  const bare = (model ?? "").trim().replace(/^[^/]+\//, "");
  return bare;
}

export function isPricedModel(model: string | undefined | null): boolean {
  return PRICING_BY_MODEL.has(resolveRegistryModel(normalizeModelId(model)));
}

/** Beijing-time peak check for time-tiered providers (UTC+8, hour windows). */
export function isBeijingPeakHour(at: Date, windows: Array<[number, number]>): boolean {
  const beijingHour = (((at.getUTCHours() + 8) % 24) + 24) % 24;
  return windows.some(([start, end]) => beijingHour >= start && beijingHour < end);
}

function tierFor(model: string | undefined | null, at?: Date): { tier: ModelPriceTier; source: CostSource } {
  const normalized = normalizeModelId(model);
  const entry = PRICING_BY_MODEL.get(resolveRegistryModel(normalized));
  if (entry) {
    const when = at ?? new Date();
    if (entry.timeTiered && when.getTime() >= Date.parse(entry.timeTiered.effectiveFrom)) {
      const tier = isBeijingPeakHour(when, entry.timeTiered.peakWindowsUtcPlus8) ? entry.timeTiered.peak : entry.timeTiered.offPeak;
      return { tier, source: "priced" };
    }
    return { tier: entry.tier, source: "priced" };
  }
  return { tier: DEFAULT_TIER, source: "priced-fallback" };
}

/** Registry summary for API surfaces (admin cost view rate badges). */
export function pricingSummary(): {
  currency: "CNY";
  models: Array<{ model: string; tier: Required<ModelPriceTier>; timeTiered?: { effectiveFrom: string; peak: Required<ModelPriceTier>; offPeak: Required<ModelPriceTier>; peakWindowsUtcPlus8: Array<[number, number]> } }>;
  defaultTier: Required<ModelPriceTier>;
} {
  const expand = (tier: ModelPriceTier): Required<ModelPriceTier> => ({
    input: tier.input,
    output: tier.output,
    thought: tier.thought ?? tier.output,
    cacheRead: tier.cacheRead ?? tier.input / 10,
    cacheWrite: tier.cacheWrite ?? 0,
  });
  return {
    currency: "CNY",
    models: MODEL_PRICING.map((entry) => ({
      model: entry.model,
      tier: expand(entry.tier),
      ...(entry.timeTiered ? {
        timeTiered: {
          effectiveFrom: entry.timeTiered.effectiveFrom,
          peak: expand(entry.timeTiered.peak),
          offPeak: expand(entry.timeTiered.offPeak),
          peakWindowsUtcPlus8: entry.timeTiered.peakWindowsUtcPlus8,
        },
      } : {}),
    })),
    defaultTier: expand(DEFAULT_TIER),
  };
}

/**
 * Price one turn's usage. Provider-reported cost (gateway passthrough)
 * always wins when present; otherwise compute from the registry. `at`
 * selects peak/off-peak for time-tiered models (write time by default;
 * backfill passes the row's created_at).
 */
export function computeModelCost(
  model: string | undefined | null,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    thoughtTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    costAmount?: number;
  },
  options?: { at?: Date | string | number },
): ModelCostResult {
  if (typeof usage.costAmount === "number" && Number.isFinite(usage.costAmount) && usage.costAmount > 0) {
    return { amount: usage.costAmount, currency: "CNY", source: "gateway" };
  }
  const when = options?.at === undefined ? new Date() : new Date(options.at);
  const { tier, source } = tierFor(model, Number.isNaN(when.getTime()) ? undefined : when);
  const perM = (tokens: number | undefined, rate: number) => (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? (tokens / 1_000_000) * rate : 0);
  const amount =
    perM(usage.inputTokens, tier.input)
    + perM(usage.outputTokens, tier.output)
    + perM(usage.thoughtTokens, tier.thought ?? tier.output)
    + perM(usage.cachedReadTokens, tier.cacheRead ?? tier.input / 10)
    + perM(usage.cachedWriteTokens, tier.cacheWrite ?? 0);
  return { amount: Math.max(0, Math.round(amount * 1e6) / 1e6), currency: "CNY", source };
}
