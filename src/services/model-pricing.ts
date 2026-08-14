/**
 * Per-model pricing registry (E10 / D24, cost-statistics-design.md).
 *
 * Prices are product configuration data (D9): versioned in Git, changed by
 * commit. Costs are computed at trace-write time so historical rows keep the
 * price they were billed at; re-pricing is an explicit backfill decision.
 *
 * Rate units: price per one million tokens. Provisional values (2026-08-15)
 * from public GPT-5.6 pricing coverage; the owner finalizes the card —
 * swapping values here only affects future turns and explicit re-pricing.
 *
 * Conventions (provider-aligned defaults):
 *   - thought tokens are generated tokens -> priced at the output rate
 *   - cached reads -> 10% of the input rate
 *   - cached writes -> v1 records tokens but prices at 0 (registry slot kept)
 */

export interface ModelPriceTier {
  /** Price per 1M input tokens. */
  input: number;
  /** Price per 1M output tokens. */
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
  currency: "USD";
  tier: ModelPriceTier;
}

const GPT_5_6_TIERS: Record<"sol" | "terra" | "luna", ModelPriceTier> = {
  sol: { input: 5, output: 30 },
  terra: { input: 2, output: 12 },
  luna: { input: 0.2, output: 1.2 },
};

export const MODEL_PRICING: ModelPricingEntry[] = [
  { model: "gpt-5.6-sol", currency: "USD", tier: GPT_5_6_TIERS.sol },
  { model: "gpt-5.6-terra", currency: "USD", tier: GPT_5_6_TIERS.terra },
  { model: "gpt-5.6-luna", currency: "USD", tier: GPT_5_6_TIERS.luna },
];

/** Fallback for models absent from the registry (flagged, never silent). */
export const DEFAULT_TIER: ModelPriceTier = GPT_5_6_TIERS.terra;

export type CostSource = "gateway" | "priced" | "priced-fallback";

export interface ModelCostResult {
  amount: number;
  currency: "USD";
  /** "gateway" = provider-reported actual; "priced" = registry hit; "priced-fallback" = DEFAULT_TIER. */
  source: CostSource;
}

const PRICING_BY_MODEL = new Map(MODEL_PRICING.map((entry) => [entry.model, entry]));

export function normalizeModelId(model: string | undefined | null): string {
  const bare = (model ?? "").trim().replace(/^[^/]+\//, "");
  return bare;
}

export function isPricedModel(model: string | undefined | null): boolean {
  return PRICING_BY_MODEL.has(normalizeModelId(model));
}

function tierFor(model: string | undefined | null): { tier: ModelPriceTier; source: CostSource } {
  const normalized = normalizeModelId(model);
  const entry = PRICING_BY_MODEL.get(normalized);
  if (entry) return { tier: entry.tier, source: "priced" };
  return { tier: DEFAULT_TIER, source: "priced-fallback" };
}

/** Registry summary for API surfaces (admin cost view rate badges). */
export function pricingSummary(): { currency: "USD"; models: Array<{ model: string; tier: Required<ModelPriceTier> }> ; defaultTier: Required<ModelPriceTier> } {
  const expand = (tier: ModelPriceTier): Required<ModelPriceTier> => ({
    input: tier.input,
    output: tier.output,
    thought: tier.thought ?? tier.output,
    cacheRead: tier.cacheRead ?? tier.input / 10,
    cacheWrite: tier.cacheWrite ?? 0,
  });
  return {
    currency: "USD",
    models: MODEL_PRICING.map((entry) => ({ model: entry.model, tier: expand(entry.tier) })),
    defaultTier: expand(DEFAULT_TIER),
  };
}

/**
 * Price one turn's usage. Provider-reported cost (gateway passthrough)
 * always wins when present; otherwise compute from the registry.
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
): ModelCostResult {
  if (typeof usage.costAmount === "number" && Number.isFinite(usage.costAmount) && usage.costAmount > 0) {
    return { amount: usage.costAmount, currency: "USD", source: "gateway" };
  }
  const { tier, source } = tierFor(model);
  const perM = (tokens: number | undefined, rate: number) => (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? (tokens / 1_000_000) * rate : 0);
  const amount =
    perM(usage.inputTokens, tier.input)
    + perM(usage.outputTokens, tier.output)
    + perM(usage.thoughtTokens, tier.thought ?? tier.output)
    + perM(usage.cachedReadTokens, tier.cacheRead ?? tier.input / 10)
    + perM(usage.cachedWriteTokens, tier.cacheWrite ?? 0);
  return { amount: Math.max(0, Math.round(amount * 1e6) / 1e6), currency: "USD", source };
}
