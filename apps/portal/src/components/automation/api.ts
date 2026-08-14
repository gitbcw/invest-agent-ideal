"use client";

import type {
  AutomationAssetGetResult,
  AutomationAssetUpload,
  AutomationContinueInChatResult,
  AutomationCreateRequest,
  AutomationBatchActionRequest,
  AutomationBatchActionResult,
  AutomationListQuery,
  AutomationListResult,
  AutomationRunNowResult,
  AutomationRunsListRequest,
  AutomationRunsListResult,
  AutomationSchedule,
  AutomationTask,
  AutomationTaskRun,
  AutomationUpdateRequest,
} from "@/lib/protocol";
import { AUTOMATION_TIMEZONE, isSupportedAutomationFileName } from "@/lib/automation-schemas";

export { AUTOMATION_FILE_ACCEPT, AUTOMATION_FILE_EXTENSIONS, AUTOMATION_TIMEZONE } from "@/lib/automation-schemas";

export class AutomationApiError extends Error {
  constructor(
    message: string,
    readonly code = "INTERNAL_ERROR",
    readonly status = 500,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AutomationApiError";
  }
}

type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: { code?: string; message?: string; retryable?: boolean } };

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "same-origin", ...init });
  } catch {
    throw new AutomationApiError("自动化服务暂时不可用", "CONNECTOR_OFFLINE", 503, true);
  }
  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new AutomationApiError("自动化服务返回格式错误", "INTERNAL_ERROR", response.status);
  }
  if (!envelope.ok) {
    throw new AutomationApiError(
      envelope.error?.message ?? "自动化请求失败",
      envelope.error?.code ?? "INTERNAL_ERROR",
      response.status,
      Boolean(envelope.error?.retryable),
    );
  }
  return envelope.data;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export async function fetchAutomations(query: AutomationListQuery = {}): Promise<AutomationListResult> {
  const params = new URLSearchParams();
  if (query.query) params.set("query", query.query);
  if (query.statuses?.length) params.set("statuses", query.statuses.join(","));
  if (query.frequencies?.length) params.set("frequencies", query.frequencies.join(","));
  if (query.deliveryModes?.length) params.set("deliveryModes", query.deliveryModes.join(","));
  if (query.outputModes?.length) params.set("outputModes", query.outputModes.join(","));
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  const suffix = params.toString();
  return requestJson<AutomationListResult>(`/api/automations${suffix ? `?${suffix}` : ""}`);
}

export async function fetchAutomation(taskId: string): Promise<AutomationTask> {
  return requestJson<AutomationTask>(`/api/automations/${encodeURIComponent(taskId)}`);
}

export async function createAutomation(input: AutomationCreateRequest): Promise<AutomationTask> {
  return requestJson<AutomationTask>("/api/automations", json({
    ...input,
    schedule: normalizeAutomationSchedule(input.schedule),
  }));
}

export async function updateAutomation(taskId: string, input: Omit<AutomationUpdateRequest, "taskId">): Promise<AutomationTask> {
  const schedule = input.schedule ? normalizeAutomationSchedule(input.schedule) : undefined;
  return requestJson<AutomationTask>(`/api/automations/${encodeURIComponent(taskId)}`, {
    ...json({ ...input, ...(schedule ? { schedule } : {}) }),
    method: "PATCH",
  });
}

export async function activateAutomation(taskId: string, expectedRevision?: number): Promise<AutomationTask> {
  return requestJson<AutomationTask>(`/api/automations/${encodeURIComponent(taskId)}/activate`, json(expectedRevision === undefined ? {} : { expectedRevision }));
}

export async function pauseAutomation(taskId: string, expectedRevision?: number): Promise<AutomationTask> {
  return requestJson<AutomationTask>(`/api/automations/${encodeURIComponent(taskId)}/pause`, json(expectedRevision === undefined ? {} : { expectedRevision }));
}

export async function archiveAutomation(taskId: string, expectedRevision?: number): Promise<AutomationTask> {
  return requestJson<AutomationTask>(`/api/automations/${encodeURIComponent(taskId)}/archive`, json(expectedRevision === undefined ? {} : { expectedRevision }));
}

export async function runAutomationNow(taskId: string): Promise<AutomationRunNowResult> {
  return requestJson<AutomationRunNowResult>(`/api/automations/${encodeURIComponent(taskId)}/run-now`, json({ idempotencyKey: `portal:${taskId}:${Date.now()}` }));
}

export async function fetchAutomationRuns(taskId: string, limit?: number): Promise<AutomationTaskRun[]>;
export async function fetchAutomationRuns(query?: AutomationRunsListRequest): Promise<AutomationRunsListResult>;
export async function fetchAutomationRuns(taskOrQuery?: string | AutomationRunsListRequest, limit = 50): Promise<AutomationTaskRun[] | AutomationRunsListResult> {
  if (typeof taskOrQuery === "string") {
    const params = new URLSearchParams({ taskId: taskOrQuery, limit: String(limit) });
    const data = await requestJson<AutomationRunsListResult>(`/api/automations/runs?${params}`);
    return data.items;
  }
  const query = taskOrQuery ?? {};
  const params = new URLSearchParams();
  if (query.taskId) params.set("taskId", query.taskId);
  if (query.query) params.set("query", query.query);
  if (query.statuses?.length) params.set("statuses", query.statuses.join(","));
  if (query.origins?.length) params.set("origins", query.origins.join(","));
  if (query.deliveryStatuses?.length) params.set("deliveryStatuses", query.deliveryStatuses.join(","));
  if (query.hasOutput !== undefined) params.set("hasOutput", query.hasOutput ? "true" : "false");
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  const suffix = params.toString();
  return requestJson<AutomationRunsListResult>(`/api/automations/runs${suffix ? `?${suffix}` : ""}`);
}

export async function fetchAutomationRunList(query: AutomationRunsListRequest = {}): Promise<AutomationRunsListResult> {
  return fetchAutomationRuns(query);
}

export async function batchAutomationAction(input: AutomationBatchActionRequest): Promise<AutomationBatchActionResult> {
  return requestJson<AutomationBatchActionResult>("/api/automations/batch-action", json(input));
}

export async function fetchAutomationRun(runId: string): Promise<AutomationTaskRun> {
  return requestJson<AutomationTaskRun>(`/api/automations/runs/${encodeURIComponent(runId)}`);
}

export async function fetchAutomationAsset(assetId: string): Promise<AutomationAssetGetResult> {
  return requestJson<AutomationAssetGetResult>(`/api/automations/assets/${encodeURIComponent(assetId)}`);
}

export async function continueAutomationInChat(runId: string): Promise<AutomationContinueInChatResult> {
  return requestJson<AutomationContinueInChatResult>(`/api/automations/runs/${encodeURIComponent(runId)}/continue`, json({}));
}

export function fileToAutomationAsset(file: File): Promise<AutomationAssetUpload> {
  return new Promise((resolve, reject) => {
    if (!isSupportedAutomationFileName(file.name)) {
      reject(new Error("仅支持 CSV 或 XLSX（Excel）文件"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve({
        fileName: file.name,
        mimeType: file.type || undefined,
        base64: comma >= 0 ? result.slice(comma + 1) : result,
      });
    };
    reader.readAsDataURL(file);
  });
}

export function normalizeAutomationSchedule(schedule: AutomationSchedule): AutomationSchedule {
  return { ...schedule, timezone: AUTOMATION_TIMEZONE };
}

export function downloadAutomationBytes(data: AutomationAssetGetResult): void {
  const raw = atob(data.base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  const blob = new Blob([bytes], { type: data.mimeType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = data.fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export type { AutomationSchedule };
