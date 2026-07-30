import type { ResearchCapabilityContract } from "./contract.js";

/** Research operations are supplied by the Core Service composition root only. */
export function createResearchCapability(operations: ResearchCapabilityContract): ResearchCapabilityContract {
  return Object.freeze({ ...operations });
}
