import { z } from "zod";

import { getCurrentSession } from "@/lib/auth";
import { badRequest, fail, ok, unauthorized } from "@/lib/http";
import {
  PORTAL_TYPES,
  type ArtifactDeleteConfirmRequest,
  type ArtifactDeleteConfirmResult
} from "@/lib/protocol";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

type Params = { params: { artifactId: string } };

const Body = z.object({
  tokenId: z.string().trim().min(1).max(128)
});

/**
 * POST /api/artifacts/:artifactId/delete/confirm   { tokenId }
 *
 * Step 2 of the two-step delete flow. Consumes the single-use token, moves the
 * underlying file into the hidden 30-day trash area, tombstones every
 * same-path version, and returns the recovery metadata. A replayed / expired
 * / forged token fails deterministically; the modal should re-prepare on
 * ARTIFACT_DELETE_CONFIRMATION_EXPIRED and surface ARTIFACT_DELETE_CONFLICT
 * as "文件已变更，请重新确认".
 *
 * The path param is informational only — the token already binds the
 * artifact, path and checksum — but we keep it in the URL for log clarity.
 */
export async function POST(request: Request, { params }: Params) {
  return new Response(JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message: "网页端不支持删除 workspace 文件" } }), {
    status: 405,
    headers: { "content-type": "application/json" }
  });
}
