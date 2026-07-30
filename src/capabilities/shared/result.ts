export type CapabilityStatus = "complete" | "partial" | "empty";

export interface CapabilitySource {
  provider: string;
  fetchedAt: string;
  asOf?: string;
  confidence?: "high" | "medium" | "low";
}

export interface CapabilityWarning {
  code: string;
  message: string;
  provider?: string;
  retryable?: boolean;
}

/**
 * The common envelope for new capability contracts. Existing adapters may retain
 * their response shapes while they migrate to this contract.
 */
export interface CapabilityResult<T> {
  status: CapabilityStatus;
  data: T;
  sources: CapabilitySource[];
  warnings: CapabilityWarning[];
}
