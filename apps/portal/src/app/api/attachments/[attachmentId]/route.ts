import { getCurrentSession } from "@/lib/auth";
import { badRequest, fail, ok, unauthorized } from "@/lib/http";
import {
  PORTAL_TYPES,
  type AttachmentGetRequest,
  type AttachmentGetResult
} from "@/lib/protocol";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

type Params = { params: { attachmentId: string } };

/**
 * GET /api/attachments/:attachmentId
 *
 * Reads a user upload (Portal/WeChat image or document) by id. Scope
 * (userId/instanceId) is injected by the connector; the browser only submits
 * the attachmentId, never a raw path. Active reads return base64 bytes; the
 * client verifies the checksum against decoded bytes exactly like artifact
 * reads. Expired / deleted reads return only metadata so the card can render
 * the right state without a perpetual spinner.
 */
export async function GET(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const attachmentId = params.attachmentId?.trim();
  if (!attachmentId) return badRequest("缺少 attachmentId");

  const payload: AttachmentGetRequest = { attachmentId };
  const remote = await sendConnectorRequest<AttachmentGetResult>(
    session.assistantId,
    PORTAL_TYPES.ATTACHMENT_GET,
    payload
  );
  if (!remote.ok) {
    return fail(remote.code, remote.message, {
      status: statusForCode(remote.code),
      retryable: remote.retryable,
      details: remote.details
    });
  }
  return ok(remote.data);
}
