import { z } from "zod";

import { getCurrentSession } from "@/lib/auth";
import { badRequest, fail, ok, unauthorized } from "@/lib/http";
import {
  PORTAL_TYPES,
  type ArtifactPublishLegacyRequest,
  type ArtifactPublishLegacyResult
} from "@/lib/protocol";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

const Body = z.object({
  relativePath: z.string().trim().min(1).max(512),
  conversationId: z.string().trim().min(1).max(128).optional()
});

/**
 * Resolves a legacy `/home/claude/.../reports/...` or relative `reports/...`
 * path to a stable descriptor for the current session. Required so the chat
 * can keep using old workspace report links without forcing users to refresh
 * the conversation once the underlying file is republished.
 */
export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return badRequest("参数错误", { issues: parsed.error.issues });

  const payload: ArtifactPublishLegacyRequest = {
    relativePath: parsed.data.relativePath,
    conversationId: parsed.data.conversationId
  };
  const remote = await sendConnectorRequest<ArtifactPublishLegacyResult>(
    session.assistantId,
    PORTAL_TYPES.ARTIFACT_PUBLISH_LEGACY,
    payload
  );
  if (!remote.ok) {
    return fail(remote.code, remote.message, {
      status: statusForCode(remote.code),
      retryable: remote.retryable,
      details: remote.details
    });
  }
  const data = remote.data;
  return ok({
    artifactId: data.artifactId,
    title: data.title,
    fileName: data.fileName,
    mimeType: data.mimeType,
    sizeBytes: data.sizeBytes,
    kind: data.kind,
    previewMode: data.previewMode,
    createdAt: data.createdAt,
    checksum: data.checksum
  });
}
