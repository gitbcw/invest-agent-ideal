import { z } from "zod";
import { nanoid } from "nanoid";

import { getCurrentSession } from "@/lib/auth";
import { openDatabase } from "@/lib/db";
import { ConversationMirrorRepository } from "@/lib/db/conversations";
import { badRequest, notFound, ok, unauthorized } from "@/lib/http";

const LabelSchema = z.object({ name: z.string().trim().min(1).max(40) });
const UpdateSchema = LabelSchema.partial().extend({ position: z.number().int().min(0).optional() });

function owner(session: { sub: string; assistantId: string }) {
  return { userId: session.sub, assistantId: session.assistantId };
}

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const repo = new ConversationMirrorRepository(openDatabase());
  return ok({ items: repo.listLabels(owner(session)) });
}

export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try { body = await request.json(); } catch { return badRequest("请求格式错误"); }
  const parsed = LabelSchema.safeParse(body);
  if (!parsed.success) return badRequest("标签名称无效");
  const repo = new ConversationMirrorRepository(openDatabase());
  try {
    return ok(repo.createLabel({ labelId: `label_${nanoid(12)}`, ...owner(session), name: parsed.data.name }));
  } catch (error) {
    if (String(error).includes("UNIQUE")) return badRequest("标签名称已存在");
    throw error;
  }
}

export async function PATCH(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return badRequest("缺少标签 id");
  let body: unknown;
  try { body = await request.json(); } catch { return badRequest("请求格式错误"); }
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success || (parsed.data.name === undefined && parsed.data.position === undefined)) return badRequest("参数无效");
  const repo = new ConversationMirrorRepository(openDatabase());
  const label = repo.updateLabel({ labelId: id, ...owner(session), ...parsed.data });
  if (!label) return notFound("标签不存在");
  return ok(label);
}

export async function DELETE(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return badRequest("缺少标签 id");
  const repo = new ConversationMirrorRepository(openDatabase());
  if (!repo.deleteLabel({ labelId: id, ...owner(session) })) return notFound("标签不存在");
  return ok({ labelId: id, deleted: true });
}
