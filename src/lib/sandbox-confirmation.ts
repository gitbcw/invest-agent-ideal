import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { pendingSandboxConfirmations } from "../db/schema.js";
import type { SandboxContext } from "./sandbox-context.js";

const DEFAULT_CONFIRMATION_TTL_MS = 10 * 60 * 1000;

export interface SandboxConfirmationTarget {
  operation: string;
  resourceType: string;
  resourceId?: string;
  requestBody?: unknown;
}

export async function createSandboxConfirmation(ctx: SandboxContext, target: SandboxConfirmationTarget) {
  const now = Date.now();
  const record = {
    id: randomUUID(),
    userId: ctx.userId,
    role: ctx.role,
    channel: ctx.channel,
    backend: ctx.backend,
    conversationId: ctx.conversationId,
    requestedTokenId: ctx.tokenId,
    operation: target.operation,
    resourceType: target.resourceType,
    resourceId: target.resourceId,
    requestBody: JSON.stringify(target.requestBody ?? {}),
    status: "pending",
    expiresAt: new Date(now + DEFAULT_CONFIRMATION_TTL_MS).toISOString(),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  await db.insert(pendingSandboxConfirmations).values(record);
  return record;
}

export async function consumeSandboxConfirmation(ctx: SandboxContext, confirmationId: string, target: SandboxConfirmationTarget) {
  const [record] = await db
    .select()
    .from(pendingSandboxConfirmations)
    .where(and(eq(pendingSandboxConfirmations.id, confirmationId), eq(pendingSandboxConfirmations.status, "pending")))
    .limit(1);

  const now = new Date();
  if (!record) {
    return { ok: false as const, reason: "confirmation not found" };
  }
  if (record.userId !== ctx.userId) {
    return { ok: false as const, reason: "confirmation user mismatch" };
  }
  if ((record.conversationId ?? "") !== (ctx.conversationId ?? "")) {
    return { ok: false as const, reason: "confirmation conversation mismatch" };
  }
  if (record.operation !== target.operation || record.resourceType !== target.resourceType || (record.resourceId ?? "") !== (target.resourceId ?? "")) {
    return { ok: false as const, reason: "confirmation target mismatch" };
  }
  if (new Date(record.expiresAt).getTime() <= now.getTime()) {
    await markConfirmation(record.id, "expired", ctx.tokenId);
    return { ok: false as const, reason: "confirmation expired" };
  }
  if (record.requestedTokenId && ctx.tokenId && record.requestedTokenId === ctx.tokenId) {
    return { ok: false as const, reason: "confirmation requires a later user turn" };
  }

  await markConfirmation(record.id, "confirmed", ctx.tokenId);
  return { ok: true as const, record };
}

export async function listPendingSandboxConfirmations(ctx: SandboxContext) {
  const rows = await db
    .select()
    .from(pendingSandboxConfirmations)
    .where(and(eq(pendingSandboxConfirmations.userId, ctx.userId), eq(pendingSandboxConfirmations.status, "pending")))
    .orderBy(desc(pendingSandboxConfirmations.createdAt))
    .limit(20);
  const now = Date.now();
  return rows
    .filter((row) => new Date(row.expiresAt).getTime() > now)
    .filter((row) => (row.conversationId ?? "") === (ctx.conversationId ?? ""))
    .map((row) => ({
      confirmationId: row.id,
      operation: row.operation,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    }));
}

async function markConfirmation(id: string, status: "confirmed" | "expired", confirmedTokenId?: string) {
  await db
    .update(pendingSandboxConfirmations)
    .set({
      status,
      confirmedTokenId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(pendingSandboxConfirmations.id, id));
}
