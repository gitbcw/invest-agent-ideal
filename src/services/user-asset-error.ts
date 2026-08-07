export class UserAssetError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code + ":" + message);
    this.name = "UserAssetError";
    this.code = code;
    this.details = details;
  }
}
