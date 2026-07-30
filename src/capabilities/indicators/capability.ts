import type { IndicatorCapabilityContract } from "./contract.js";

/** Pure L1 algorithms are explicitly composed without workspace or network access. */
export function createIndicatorCapability(operations: IndicatorCapabilityContract): IndicatorCapabilityContract {
  return Object.freeze({ ...operations });
}
