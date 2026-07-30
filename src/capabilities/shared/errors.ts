export type CapabilityErrorCode =
  | "invalid_input"
  | "rate_limited"
  | "permission_denied"
  | "network_error"
  | "timeout"
  | "internal_error";

export class CapabilityError extends Error {
  constructor(
    public readonly code: CapabilityErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}
