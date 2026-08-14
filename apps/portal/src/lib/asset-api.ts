import { fail, ok } from "@/lib/http";
import type { SessionPayload } from "@/lib/auth";
import { PORTAL_TYPES, type UserAsset, type UserAssetReferencesResult, type UserAssetVersion, type UserAssetVersionPayload } from "@/lib/protocol";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

export async function forwardAsset<T>(session: SessionPayload, type: string, payload: unknown) {
  return sendConnectorRequest<T>(session.assistantId, type, payload);
}

export function assetResponse<T>(remote: Awaited<ReturnType<typeof forwardAsset<T>>>, sanitize?: (value: T) => T) {
  if (!remote.ok) {
    return fail(remote.code, remote.message, {
      status: statusForCode(remote.code),
      retryable: remote.retryable,
      details: remote.details,
    });
  }
  return ok(sanitize ? sanitize(remote.data) : remote.data);
}

export function sanitizeAsset(asset: UserAsset & Record<string, unknown>): UserAsset {
  const { userId: _userId, instanceId: _instanceId, projectId: _projectId, currentVersion, ...rest } = asset;
  return {
    ...rest,
    currentVersion: currentVersion ? sanitizeVersion(currentVersion as UserAssetVersion & Record<string, unknown>) : null,
  } as UserAsset;
}

export function sanitizeVersion(version: UserAssetVersion & Record<string, unknown>): UserAssetVersion {
  const { userId: _userId, instanceId: _instanceId, projectId: _projectId, storagePath: _storagePath, ...rest } = version;
  return rest as UserAssetVersion;
}

export function sanitizeVersionPayload(version: UserAssetVersionPayload & Record<string, unknown>): UserAssetVersionPayload {
  return { ...sanitizeVersion(version), base64: version.base64 };
}

export function sanitizeReferences(value: UserAssetReferencesResult): UserAssetReferencesResult {
  return {
    taskBindings: value.taskBindings,
    provenance: value.provenance.map((item) => sanitizeVersion(item as UserAssetVersion & Record<string, unknown>)),
  };
}

export { PORTAL_TYPES };
