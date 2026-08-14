import { fail, ok } from "@/lib/http";
import type { SessionPayload } from "@/lib/auth";
import { PORTAL_TYPES, type AutomationTask, type AutomationTaskAsset, type AutomationTaskRun } from "@/lib/protocol";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

/**
 * Forward one automation command through the authenticated connector.
 *
 * This helper intentionally does not add userId/instanceId/projectId to the
 * payload. The runtime connector derives those values from its registered
 * scope; accepting browser-supplied scope here would make an ID-only request
 * a cross-user access primitive.
 */
export async function forwardAutomation<T>(
  session: SessionPayload,
  type: string,
  payload: unknown,
): Promise<{ ok: true; data: T } | { ok: false; code: string; message: string; retryable: boolean; details?: Record<string, unknown> }> {
  return sendConnectorRequest<T>(session.assistantId, type, payload);
}

/** Convert a connector result to a Portal HTTP response. */
export function automationResponse<T>(remote: Awaited<ReturnType<typeof forwardAutomation<T>>>, sanitize?: (value: T) => T) {
  if (!remote.ok) {
    return fail(remote.code, remote.message, {
      status: statusForCode(remote.code),
      retryable: remote.retryable,
      details: remote.details,
    });
  }
  return ok(sanitize ? sanitize(remote.data) : remote.data);
}

/**
 * Runtime records repeat their connector scope on every row. Remove those
 * internal columns before returning data to browser code while preserving the
 * stable task/run/asset contract.
 */
export function sanitizeAutomationTask(task: AutomationTask & Record<string, unknown>): AutomationTask {
  const { userId: _userId, instanceId: _instanceId, projectId: _projectId, revision, sourceAsset, workingAsset, ...rest } = task;
  return {
    ...rest,
    revision: sanitizeRevision(revision as AutomationTask["revision"]),
    sourceAsset: sourceAsset ? sanitizeAsset(sourceAsset as AutomationTaskAsset) : sourceAsset,
    workingAsset: workingAsset ? sanitizeAsset(workingAsset as AutomationTaskAsset) : workingAsset,
  } as AutomationTask;
}

export function sanitizeAutomationRun(run: AutomationTaskRun & Record<string, unknown>): AutomationTaskRun {
  const {
    userId: _userId,
    instanceId: _instanceId,
    projectId: _projectId,
    // Lease credentials are a service-side fencing primitive. They must never
    // cross the authenticated Portal boundary, even though a run record is
    // otherwise returned to the task owner.
    leaseToken: _leaseToken,
    leaseExpiresAt: _leaseExpiresAt,
    ...rest
  } = run;
  return rest as AutomationTaskRun;
}

export function sanitizeAutomationAsset(asset: AutomationTaskAsset & Record<string, unknown>): AutomationTaskAsset {
  return sanitizeAsset(asset);
}

function sanitizeRevision(revision: AutomationTask["revision"]) {
  const { userId: _userId, instanceId: _instanceId, projectId: _projectId, ...rest } = revision as AutomationTask["revision"] & Record<string, unknown>;
  return rest;
}

function sanitizeAsset(asset: AutomationTaskAsset) {
  const { userId: _userId, instanceId: _instanceId, projectId: _projectId, ...rest } = asset as AutomationTaskAsset & Record<string, unknown>;
  return rest;
}

export function sanitizeTaskResult<T>(value: T): T {
  if (value && typeof value === "object") {
    if ("taskId" in (value as Record<string, unknown>) && "revision" in (value as Record<string, unknown>)) {
      return sanitizeAutomationTask(value as AutomationTask & Record<string, unknown>) as T;
    }
    if ("runId" in (value as Record<string, unknown>)) {
      return sanitizeAutomationRun(value as AutomationTaskRun & Record<string, unknown>) as T;
    }
  }
  return value;
}

export { PORTAL_TYPES };
