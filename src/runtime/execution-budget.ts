export function resolveTurnExecutionBudget(input: {
  executionDeadlineMs: number;
  configuredTimeoutMs?: number;
  firstTokenTimeoutMs: number;
  nowMs?: number;
}): { expired: boolean; remainingMs?: number; timeoutMs?: number; firstTokenTimeoutMs: number } {
  const nowMs = input.nowMs ?? Date.now();
  const remainingMs = Number.isFinite(input.executionDeadlineMs)
    ? Math.max(0, input.executionDeadlineMs - nowMs)
    : undefined;
  const expired = remainingMs !== undefined && remainingMs <= 0;
  const timeoutMs = remainingMs === undefined
    ? input.configuredTimeoutMs
    : Math.max(1, Math.min(input.configuredTimeoutMs ?? remainingMs, remainingMs));
  return {
    expired,
    ...(remainingMs !== undefined ? { remainingMs } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    firstTokenTimeoutMs: Math.max(1, Math.min(input.firstTokenTimeoutMs, timeoutMs ?? input.firstTokenTimeoutMs)),
  };
}

export function hasExecutionBudgetForFallback(input: {
  executionDeadlineMs: number;
  minimumRemainingMs: number;
  nowMs?: number;
}): boolean {
  if (!Number.isFinite(input.executionDeadlineMs)) return true;
  return input.executionDeadlineMs - (input.nowMs ?? Date.now()) >= input.minimumRemainingMs;
}
