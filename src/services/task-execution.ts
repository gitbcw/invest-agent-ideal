/** Shared execution timing and error semantics for foreground and background work. */

export type TaskErrorCategory =
  | "transient"
  | "timeout"
  | "dependency_unavailable"
  | "invalid_input"
  | "validation_failed"
  | "scope_or_permission"
  | "expired"
  | "cancelled"
  | "unknown";

export interface TaskErrorInfo {
  category: TaskErrorCategory;
  retryable: boolean;
  code: string;
  userMessage: string;
  internalReason: string;
}

export interface TaskTiming {
  acceptedAt: string;
  responseDeadlineAt: string;
  executionDeadlineAt: string;
}

export function retryableExecutionResponse(response: { data?: Record<string, unknown> } | null | undefined): boolean {
  return response?.data?.executionStatus === "failed" && response.data.executionRetryable === true;
}

export function executionResponseError(response: { data?: Record<string, unknown> } | null | undefined): TaskErrorInfo | null {
  if (response?.data?.executionStatus !== "failed") return null;
  const category = typeof response.data.executionErrorCategory === "string"
    ? response.data.executionErrorCategory as TaskErrorCategory
    : undefined;
  const retryable = response.data.executionRetryable === true;
  const code = typeof response.data.executionErrorCode === "string" ? response.data.executionErrorCode : "TASK_EXECUTION_FAILED";
  const resolvedCategory = category && ["transient", "timeout", "dependency_unavailable", "invalid_input", "validation_failed", "scope_or_permission", "expired", "cancelled", "unknown"].includes(category)
    ? category
    : retryable ? "transient" : "unknown";
  return taskError(
    resolvedCategory,
    code,
    code === "TASK_MODEL_CAPACITY"
      ? "模型服务暂时繁忙，请稍后重试。"
      : "后台任务没有完成，系统已记录这次异常。",
    code,
    retryable,
  );
}

const DEFAULT_RESPONSE_BUDGET_MS = 15_000;
export const DEFAULT_EXECUTION_BUDGET_MS = 20 * 60_000;

export async function executeWithRetryPolicy<T>(
  operation: () => Promise<T>,
  options: {
    executionBudgetMs?: number;
    isRetryableResult?: (result: T) => boolean;
    /** 结果可重试时的退避等待（T-395）：返回 0 立即重试（旧行为）；busy 类必须
     * 退避——立即重试时相邻 turn 仍在占用，必败。退避裁剪到剩余预算，预算耗尽
     * 直接按超时抛出，不再空跑 operation。异常路径（throw）不退避。 */
    retryDelayForResult?: (result: T) => number;
    sleepImpl?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const deadlineAt = resolveTaskTiming({ executionBudgetMs: options.executionBudgetMs }).executionDeadlineAt;
  const sleep = options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;
  while (true) {
    let delayMs = 0;
    try {
      const result = await awaitWithExecutionDeadline(operation, deadlineAt);
      if (attempt >= 1 || !options.isRetryableResult?.(result)) return result;
      attempt += 1;
      delayMs = options.retryDelayForResult?.(result) ?? 0;
    } catch (error) {
      const classified = classifyTaskError(error);
      if (attempt >= 1 || !classified.retryable) throw error;
      attempt += 1;
    }
    if (delayMs > 0) {
      const remainingMs = Date.parse(deadlineAt) - Date.now();
      if (remainingMs <= 0) {
        // 退避本身会耗尽预算：直接按超时抛出，不再空跑一次 operation。
        throw new Error("TASK_EXECUTION_TIMEOUT");
      }
      await sleep(Math.min(delayMs, remainingMs));
    }
  }
}

async function awaitWithExecutionDeadline<T>(operation: () => Promise<T>, deadlineAt: string): Promise<T> {
  const remainingMs = Date.parse(deadlineAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new Error("TASK_EXECUTION_TIMEOUT");
  const operationPromise = operation();
  operationPromise.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("TASK_EXECUTION_TIMEOUT")), remainingMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operationPromise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function resolveTaskTiming(input: {
  now?: Date;
  responseBudgetMs?: number;
  executionBudgetMs?: number;
} = {}): TaskTiming {
  const now = input.now ?? new Date();
  const responseBudgetMs = positiveBudget(input.responseBudgetMs, DEFAULT_RESPONSE_BUDGET_MS);
  const executionBudgetMs = positiveBudget(input.executionBudgetMs, DEFAULT_EXECUTION_BUDGET_MS);
  return {
    acceptedAt: now.toISOString(),
    responseDeadlineAt: new Date(now.getTime() + responseBudgetMs).toISOString(),
    executionDeadlineAt: new Date(now.getTime() + executionBudgetMs).toISOString(),
  };
}

export function isPastDeadline(deadlineAt: string | null | undefined, now = new Date()): boolean {
  if (!deadlineAt) return false;
  const timestamp = Date.parse(deadlineAt);
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}

export function classifyTaskError(error: unknown): TaskErrorInfo {
  const internalReason = error instanceof Error ? error.message : String(error);
  const normalized = internalReason.toLowerCase();
  if (
    normalized.includes("server_overloaded")
    || normalized.includes("model is at capacity")
    || normalized.includes("selected model is at capacity")
  ) {
    return taskError("transient", "TASK_MODEL_CAPACITY", "模型服务暂时繁忙，请稍后重试。", internalReason, true);
  }
  if (normalized.includes("expired") || normalized.includes("deadline")) {
    return taskError("expired", "TASK_EXPIRED", "这项任务已超过有效处理时间，未继续执行。", internalReason, false);
  }
  if (normalized.includes("cancel")) {
    return taskError("cancelled", "TASK_CANCELLED", "这项任务已停止，没有继续产生新的结果。", internalReason, false);
  }
  if (normalized.includes("scope") || normalized.includes("permission") || normalized.includes("forbidden") || normalized.includes("path_escape")) {
    return taskError("scope_or_permission", "TASK_SCOPE_OR_PERMISSION", "这项任务因权限或数据范围限制未完成。", internalReason, false);
  }
  if (normalized.includes("invalid") || normalized.includes("required") || normalized.includes("not found")) {
    return taskError("invalid_input", "TASK_INVALID_INPUT", "这项任务缺少有效输入或目标，暂时无法完成。", internalReason, false);
  }
  if (normalized.includes("validation") || normalized.includes("malformed") || normalized.includes("checksum")) {
    return taskError("validation_failed", "TASK_OUTPUT_VALIDATION_FAILED", "任务生成的结果没有通过格式校验，因此没有提交。", internalReason, false);
  }
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("超时")) {
    return taskError("timeout", "TASK_TIMEOUT", "任务处理时间较长，系统会在有效期内自动尝试恢复。", internalReason, true);
  }
  if (normalized.includes("api") || normalized.includes("provider") || normalized.includes("credential") || normalized.includes("token") || normalized.includes("not configured")) {
    return taskError("dependency_unavailable", "TASK_DEPENDENCY_UNAVAILABLE", "当前依赖服务暂时不可用，任务没有完成。", internalReason, false);
  }
  if (normalized.includes("network") || normalized.includes("fetch") || normalized.includes("429") || normalized.includes("502") || normalized.includes("503") || normalized.includes("504")) {
    return taskError("transient", "TASK_TRANSIENT_FAILURE", "依赖服务出现暂时性问题，系统会自动尝试恢复。", internalReason, true);
  }
  return taskError("unknown", "TASK_UNKNOWN_FAILURE", "任务没有完成，系统已记录这次异常。", internalReason, true);
}

export function terminalTaskError(error: TaskErrorInfo): TaskErrorInfo {
  if (!error.retryable) return error;
  return {
    ...error,
    retryable: false,
    userMessage: error.category === "timeout"
      ? "任务已超过本次有效处理时间，未能完成。"
      : "任务遇到暂时性故障，自动重试后仍未恢复，本次没有完成。",
  };
}

function positiveBudget(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function taskError(
  category: TaskErrorCategory,
  code: string,
  userMessage: string,
  internalReason: string,
  retryable: boolean,
): TaskErrorInfo {
  return { category, code, userMessage, internalReason: internalReason.slice(0, 2_000), retryable };
}
