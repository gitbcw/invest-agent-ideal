import { fail, ok } from "@/lib/http";
import type { SessionPayload } from "@/lib/auth";
import { PORTAL_TYPES } from "@/lib/protocol/envelope";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

/**
 * Workspace methods & skills forwarding (T-538).
 *
 * 与 automation-api 同一纪律：浏览器载荷永远不携带 userId/instanceId/
 * projectId——scope 由 runtime connector 从注册 scope 派生；schema 层用
 * strict() 拒绝多余字段（见 lib/workspace-schemas.ts）。
 */

export interface MethodAgentBindingView {
  agentId: string;
  agentName: string;
  versionPolicy: string;
  pinnedVersionId: string | null;
  pinnedVersionNumber: string | null;
}

export interface MethodCardView {
  methodId: string;
  name: string;
  description: string | null;
  status: string;
  currentVersionId: string | null;
  currentVersionNumber: number | null;
  currentVersionApprovedAt: string | null;
  currentVersionConstraints: string[];
  pendingDraft: { versionId: string; versionNumber: number; adoptionNote: string | null; createdAt: string } | null;
  versionCount: number;
  taskBindingCount: number;
  agentBindings: MethodAgentBindingView[];
  assetId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MethodAssetCardView {
  assetId: string;
  name: string;
  fileName: string;
  format: string;
  sizeBytes: number;
  source: string;
  updatedAt: string;
  status: string;
  folderName: string;
  currentVersionId: string | null;
  /** 服务端工作副本（未发布修改）存在时非空。 */
  workingCopyUpdatedAt: string | null;
  workingCopyBaseVersionId: string | null;
}

/** method.working_copy.get 的返回：exists=false 时其余字段缺省。 */
export interface MethodWorkingCopyView {
  exists: boolean;
  assetId: string;
  draftText?: string;
  baseVersionId?: string | null;
  updatedAt?: string;
}

export interface MethodVersionMetaView {
  versionId: string;
  versionNumber: number;
  status: string;
  adoptionNote: string | null;
  adoptionConstraints: string[];
  approvedBy: string | null;
  approvedAt: string | null;
  supersedesVersionNumber: number | null;
  createdAt: string;
}

export interface MethodTaskUsageView {
  taskId: string;
  taskName: string | null;
  taskStatus: string | null;
  versionPolicy: string;
  pinnedVersionId: string | null;
  pinnedVersionNumber: number | null;
}

export interface MethodDetailView {
  method: MethodCardView;
  versions: MethodVersionMetaView[];
  taskUsage: MethodTaskUsageView[];
  content: { versionId: string; versionNumber: number; text: string } | null;
}

export interface MethodVersionTextView {
  versionId: string;
  versionNumber: number;
  text: string;
}

export interface MethodDiffView {
  identical: boolean;
  from: MethodVersionTextView | null;
  to: MethodVersionTextView | null;
}

export interface SkillVersionMetaView {
  versionId: string;
  versionNumber: number;
  status: string;
  origin: string;
  approvedBy: string | null;
  approvedAt: string | null;
  supersedesVersionNumber: number | null;
  derivedFromVersionNumber: number | null;
  createdAt: string;
}

export interface SkillInstallationView {
  installationId: string;
  agentId: string;
  agentName: string;
  source: "release" | "private";
  releaseId: string | null;
  releaseVersion: string | null;
  versionId: string;
  versionNumber: number;
  installedAt: string;
}

export interface SkillUpgradeOptionView {
  kind: "release" | "private";
  releaseId: string | null;
  releaseVersion: string | null;
  versionId: string;
  versionNumber: number;
  publishedAt: string | null;
}

export interface PrivateSkillCardView {
  skillId: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  currentVersionId: string | null;
  currentVersionNumber: number | null;
  currentVersionApprovedAt: string | null;
  pendingDraft: { versionId: string; versionNumber: number; createdAt: string } | null;
  versionCount: number;
  derivedFromReleaseId: string | null;
  installation: SkillInstallationView | null;
  availableUpgrade: SkillUpgradeOptionView | null;
  taskBindingCount: number;
  assetId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstalledSkillCardView {
  installationId: string;
  skillId: string;
  slug: string;
  name: string;
  description: string | null;
  status: "installed" | "disabled";
  source: "release" | "private";
  releaseId: string | null;
  releaseVersion: string | null;
  versionId: string;
  versionNumber: number;
  installedAt: string;
  availableUpgrade: SkillUpgradeOptionView | null;
  isPrivateSkill: boolean;
  taskBindingCount: number;
}

export interface CatalogSkillCardView {
  skillId: string;
  slug: string;
  name: string;
  description: string | null;
  releaseId: string | null;
  releaseVersion: string | null;
  versionId: string;
  source: "release" | "private";
}

export interface ProjectSkillPreviewView {
  slug: string;
  name: string;
  description: string;
  text: string;
}

export interface SkillDetailView {
  skill: PrivateSkillCardView;
  versions: SkillVersionMetaView[];
  installations: SkillInstallationView[];
  taskUsage: Array<{ taskId: string; taskName: string | null; taskStatus: string | null }>;
  relatedMethodIds: Array<{ methodId: string; name: string }>;
  content: { versionId: string; versionNumber: number; text: string } | null;
}

export interface WorkspaceUsageForAssetView {
  methods: Array<{ methodId: string; name: string }>;
  skills: Array<{ skillId: string; name: string }>;
}

export async function forwardWorkspace<T>(
  session: SessionPayload,
  type: string,
  payload: unknown,
): Promise<{ ok: true; data: T } | { ok: false; code: string; message: string; retryable: boolean; details?: Record<string, unknown> }> {
  return sendConnectorRequest<T>(session.assistantId, type, payload);
}

export function workspaceResponse<T>(
  remote: Awaited<ReturnType<typeof forwardWorkspace<T>>>,
): ReturnType<typeof ok<T>> | ReturnType<typeof fail> {
  if (!remote.ok) {
    return fail(remote.code, remote.message, {
      status: statusForCode(remote.code),
      retryable: remote.retryable,
      details: remote.details,
    });
  }
  return ok(remote.data);
}

export { PORTAL_TYPES };
