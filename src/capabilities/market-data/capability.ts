import type { MarketDataCapabilityContract } from "./contract.js";

/**
 * Capability boundary for market-only reads. Its dependencies are explicit and
 * supplied only by the Core Service composition root.
 */
export function createMarketDataCapability(
  operations: MarketDataCapabilityContract,
): MarketDataCapabilityContract {
  return Object.freeze({ ...operations });
}
