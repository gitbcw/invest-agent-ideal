import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { conversationMessages, conversationSessions, onboardingDrafts, pendingSandboxConfirmations } from "../db/schema.js";
import { appendConversationMessage } from "./conversation-log.js";
import { enqueuePushJob } from "./push-queue.js";
import { createWatchRule, listWatchRules, validateWatchRule } from "./watch-rules.js";
import { applyOnboardingDraftCommit, finalizeOnboardingDraftCommit, isOnboardingStep, validateOnboardingPortfolioPayload, validateOnboardingStepPayload } from "./onboarding.js";
import { WorkspaceStore, type OnboardingStepKey } from "../lib/workspace-store.js";
import { consumeSandboxConfirmation, createSandboxConfirmation, validateSandboxConfirmation } from "../lib/sandbox-confirmation.js";
import type { SandboxContext } from "../lib/sandbox-context.js";

export type DraftStepKey = Exclude<OnboardingStepKey, "welcome">;
export type DraftStatus = "collecting" | "ready_to_commit" | "queued" | "applying" | "completed" | "failed_retryable" | "cancelled";
export type DraftStepStatus = "drafted" | "awaiting_confirmation" | "accepted" | "superseded" | "skipped";

const DRAFT_STEPS: DraftStepKey[] = ["portfolio", "style", "review_schedule", "market_watch_schedule", "notification", "watch_rules"];
const REQUIRED_STEPS: DraftStepKey[] = DRAFT_STEPS;
const APPLYING_LEASE_MS = 2 * 60 * 1000;

export interface OnboardingDraftScope {
  userId: string;
  instanceId: string;
  projectId: string;
  conversationId: string;
}

interface DraftStep {
  revision: number;
  status: DraftStepStatus;
  payload: Record<string, unknown>;
  confirmationId?: string;
  confirmedAt?: string;
  confirmedMessageId?: string;
  supersededRevisions?: Array<{ revision: number; status: DraftStepStatus; confirmationId?: string }>;
}

interface DraftSteps {
  [step: string]: DraftStep | undefined;
}

interface DraftSnapshot {
  revision: number;
  steps: DraftSteps;
}

function parseSteps(value: string): DraftSteps {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as DraftSteps : {};
  } catch {
    return {};
  }
}

function parseSnapshot(value: string | null): DraftSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as DraftSnapshot : null;
  } catch {
    return null;
  }
}

function isDraftStep(value: unknown): value is DraftStepKey {
  return typeof value === "string" && DRAFT_STEPS.includes(value as DraftStepKey);
}

function nowIso() {
  return new Date().toISOString();
}

function draftView(row: typeof onboardingDrafts.$inferSelect) {
  const steps = parseSteps(row.stepsJson);
  return {
    id: row.id,
    userId: row.userId,
    instanceId: row.instanceId,
    conversationId: row.conversationId,
    revision: row.revision,
    status: row.status as DraftStatus,
    steps,
    commitKey: row.commitKey,
    lastError: row.lastError,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt,
    nextStep: nextStep(steps),
  };
}

function nextStep(steps: DraftSteps): DraftStepKey | "ready_to_commit" {
  return REQUIRED_STEPS.find((step) => !isStepAccepted(steps[step])) ?? "ready_to_commit";
}

function isStepAccepted(step: DraftStep | undefined) {
  return step?.status === "accepted" || step?.status === "skipped";
}

function isReady(steps: DraftSteps) {
  return REQUIRED_STEPS.every((step) => isStepAccepted(steps[step]));
}

async function activeDraft(scope: Pick<OnboardingDraftScope, "userId" | "instanceId">) {
  const rows = await db.select().from(onboardingDrafts).where(and(
    eq(onboardingDrafts.userId, scope.userId),
    eq(onboardingDrafts.instanceId, scope.instanceId),
    inArray(onboardingDrafts.status, ["collecting", "ready_to_commit", "queued", "applying", "failed_retryable"]),
  )).orderBy(desc(onboardingDrafts.updatedAt)).limit(1);
  return rows[0] ?? null;
}

export async function getOnboardingDraft(scope: Pick<OnboardingDraftScope, "userId" | "instanceId">) {
  const row = await activeDraft(scope);
  return row ? draftView(row) : null;
}

export async function upsertOnboardingDraftStep(scope: OnboardingDraftScope, input: { draftId?: string; step: DraftStepKey; payload: Record<string, unknown> }) {
  if (!isDraftStep(input.step)) throw new Error("invalid onboarding draft step");
  const now = nowIso();
  let row = input.draftId
    ? (await db.select().from(onboardingDrafts).where(and(eq(onboardingDrafts.id, input.draftId), eq(onboardingDrafts.userId, scope.userId), eq(onboardingDrafts.instanceId, scope.instanceId))).limit(1))[0] ?? null
    : await activeDraft(scope);
  if (row && ["queued", "applying"].includes(row.status)) throw new Error("初始配置正在统一提交，当前草稿不能修改");
  if (!row || ["completed", "cancelled"].includes(row.status)) {
    const id = randomUUID();
    await db.insert(onboardingDrafts).values({
      id,
      userId: scope.userId,
      projectId: scope.projectId,
      instanceId: scope.instanceId,
      conversationId: scope.conversationId,
      revision: 0,
      status: "collecting",
      stepsJson: "{}",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    row = (await db.select().from(onboardingDrafts).where(eq(onboardingDrafts.id, id)).limit(1))[0]!;
  }
  const steps = parseSteps(row.stepsJson);
  const previous = steps[input.step];
  const payload = mergeDraftPayload(input.step, previous?.payload ?? {}, input.payload);
  validateDraftPayload(input.step, payload);
  if (previous?.confirmationId) {
    await db.update(pendingSandboxConfirmations).set({ status: "superseded", updatedAt: now }).where(eq(pendingSandboxConfirmations.id, previous.confirmationId));
  }
  const nextRevision = row.revision + 1;
  steps[input.step] = {
    revision: nextRevision,
    status: "drafted",
    payload,
    supersededRevisions: previous
      ? [...(previous.supersededRevisions ?? []), { revision: previous.revision, status: previous.status, confirmationId: previous.confirmationId }]
      : [],
  };
  await db.update(onboardingDrafts).set({
    conversationId: scope.conversationId,
    revision: nextRevision,
    status: "collecting",
    stepsJson: JSON.stringify(steps),
    commitSnapshotJson: null,
    commitKey: null,
    lastError: null,
    queuedAt: null,
    startedAt: null,
    updatedAt: now,
  }).where(eq(onboardingDrafts.id, row.id));
  const updated = (await db.select().from(onboardingDrafts).where(eq(onboardingDrafts.id, row.id)).limit(1))[0]!;
  return draftView(updated);
}

export async function requestOnboardingDraftConfirmation(scope: OnboardingDraftScope, input: { draftId: string; step: DraftStepKey; revision: number; sandbox: SandboxContext }) {
  const row = await scopedDraft(scope, input.draftId);
  const steps = parseSteps(row.stepsJson);
  const step = steps[input.step];
  if (!step || step.revision !== input.revision || step.status !== "drafted") throw new Error("当前草稿版本不可确认");
  const pending = await createSandboxConfirmation(input.sandbox, {
    operation: "onboarding.draft.accept_step",
    resourceType: "onboarding_draft_step",
    resourceId: `${row.id}:${input.step}:${input.revision}`,
    requestBody: { draftId: row.id, step: input.step, revision: input.revision, payload: step.payload },
  });
  steps[input.step] = { ...step, status: "awaiting_confirmation", confirmationId: pending.id };
  await db.update(onboardingDrafts).set({ stepsJson: JSON.stringify(steps), updatedAt: nowIso() }).where(eq(onboardingDrafts.id, row.id));
  return { draftId: row.id, step: input.step, revision: input.revision, confirmationId: pending.id, expiresAt: pending.expiresAt };
}

export async function acceptOnboardingDraftStep(scope: OnboardingDraftScope, input: { draftId: string; step: DraftStepKey; revision: number; confirmationId: string; sandbox: SandboxContext }) {
  const row = await scopedDraft(scope, input.draftId);
  const steps = parseSteps(row.stepsJson);
  const step = steps[input.step];
  if (!step || step.revision !== input.revision || step.status !== "awaiting_confirmation" || step.confirmationId !== input.confirmationId) {
    throw new Error("确认不属于当前草稿版本");
  }
  const target = {
    operation: "onboarding.draft.accept_step",
    resourceType: "onboarding_draft_step",
    resourceId: `${row.id}:${input.step}:${input.revision}`,
    requestBody: { draftId: row.id, step: input.step, revision: input.revision, payload: step.payload },
  };
  const confirmationMessage = await requireRecentConfirmation(scope, input.confirmationId);
  const valid = await validateSandboxConfirmation(input.sandbox, input.confirmationId, target);
  if (!valid.ok) throw new Error(`confirmation invalid: ${valid.reason}`);
  await consumeSandboxConfirmation(input.sandbox, input.confirmationId, target);
  const now = nowIso();
  steps[input.step] = {
    ...step,
    status: input.step === "watch_rules" && step.payload.skip === true ? "skipped" : "accepted",
    confirmedAt: now,
    confirmedMessageId: confirmationMessage.messageId,
  };
  const status: DraftStatus = isReady(steps) ? "ready_to_commit" : "collecting";
  await db.update(onboardingDrafts).set({ status, stepsJson: JSON.stringify(steps), updatedAt: now }).where(eq(onboardingDrafts.id, row.id));
  const updated = (await db.select().from(onboardingDrafts).where(eq(onboardingDrafts.id, row.id)).limit(1))[0]!;
  return draftView(updated);
}

export async function enqueueOnboardingDraftCommit(scope: OnboardingDraftScope, draftId: string) {
  const row = await scopedDraft(scope, draftId);
  const steps = parseSteps(row.stepsJson);
  if (!isReady(steps)) throw new Error("仍有初始配置草稿等待确认");
  if (row.status === "queued" || row.status === "applying") return draftView(row);
  if (row.status !== "ready_to_commit" && row.status !== "failed_retryable") throw new Error("当前草稿不能提交");
  const now = nowIso();
  const commitKey = `${row.id}:${row.revision}`;
  const snapshot: DraftSnapshot = { revision: row.revision, steps };
  await db.update(onboardingDrafts).set({
    status: "queued",
    commitSnapshotJson: JSON.stringify(snapshot),
    commitKey,
    queuedAt: now,
    startedAt: null,
    lastError: null,
    updatedAt: now,
  }).where(eq(onboardingDrafts.id, row.id));
  const updated = (await db.select().from(onboardingDrafts).where(eq(onboardingDrafts.id, row.id)).limit(1))[0]!;
  return draftView(updated);
}

export async function processOnboardingDraftCommits(options: { limit?: number } = {}) {
  const now = new Date();
  const expiredLease = new Date(now.getTime() - APPLYING_LEASE_MS).toISOString();
  const retryReadyAt = new Date(now.getTime() - 5_000).toISOString();
  const candidates = await db.select().from(onboardingDrafts).where(or(
    eq(onboardingDrafts.status, "queued"),
    and(eq(onboardingDrafts.status, "applying"), lte(onboardingDrafts.startedAt, expiredLease)),
    and(eq(onboardingDrafts.status, "failed_retryable"), lt(onboardingDrafts.attempts, 3), lte(onboardingDrafts.updatedAt, retryReadyAt)),
  )).orderBy(onboardingDrafts.queuedAt).limit(options.limit ?? 3);
  let completed = 0;
  let failed = 0;
  for (const candidate of candidates) {
    if (!await hasPersistedWaitNotice(candidate)) continue;
    const startedAt = nowIso();
    const claimEligibility = candidate.status === "queued"
      ? eq(onboardingDrafts.status, "queued")
      : candidate.status === "applying"
        ? and(eq(onboardingDrafts.status, "applying"), lte(onboardingDrafts.startedAt, expiredLease))
        : and(eq(onboardingDrafts.status, "failed_retryable"), lt(onboardingDrafts.attempts, 3), lte(onboardingDrafts.updatedAt, retryReadyAt));
    const claimed = await db.update(onboardingDrafts).set({
      status: "applying",
      attempts: candidate.attempts + 1,
      startedAt,
      updatedAt: startedAt,
    }).where(and(
      eq(onboardingDrafts.id, candidate.id),
      claimEligibility,
    ));
    if (claimed.changes === 0) continue;
    try {
      await commitDraft(candidate.id);
      completed += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      await db.update(onboardingDrafts).set({ status: "failed_retryable", lastError: message.slice(0, 1200), updatedAt: nowIso() }).where(eq(onboardingDrafts.id, candidate.id));
      await notifyDraftResult(candidate, false, message);
    }
  }
  const notificationRetries = await db.select().from(onboardingDrafts).where(and(
    eq(onboardingDrafts.status, "completed"),
    isNull(onboardingDrafts.notifiedAt),
  )).orderBy(onboardingDrafts.completedAt).limit(options.limit ?? 3);
  for (const draft of notificationRetries) {
    try {
      await notifyDraftResult(draft, true);
    } catch {
      // Notification retry is intentionally independent from an already verified commit.
    }
  }
  return { processed: candidates.length, completed, failed };
}

async function commitDraft(id: string) {
  const row = (await db.select().from(onboardingDrafts).where(eq(onboardingDrafts.id, id)).limit(1))[0];
  if (!row) throw new Error("onboarding draft not found");
  const snapshot = parseSnapshot(row.commitSnapshotJson);
  if (!snapshot || !isReady(snapshot.steps)) throw new Error("frozen onboarding draft is incomplete");
  const stepPayloads = Object.fromEntries(Object.entries(snapshot.steps).map(([key, value]) => [key, value?.payload ?? {}])) as Partial<Record<OnboardingStepKey, Record<string, unknown>>>;
  const store = new WorkspaceStore(row.userId);
  const finalState = await applyOnboardingDraftCommit({ store, steps: stepPayloads });
  await commitDraftRules(row, snapshot);
  await finalizeOnboardingDraftCommit({
    store,
    state: finalState,
    commitKey: row.commitKey ?? `${row.id}:${snapshot.revision}`,
    steps: Object.keys(stepPayloads),
  });
  const completedAt = nowIso();
  await db.update(onboardingDrafts).set({ status: "completed", completedAt, lastError: null, updatedAt: completedAt }).where(eq(onboardingDrafts.id, row.id));
}

async function commitDraftRules(row: typeof onboardingDrafts.$inferSelect, snapshot: DraftSnapshot) {
  const rules = Array.isArray(snapshot.steps.watch_rules?.payload.rules) ? snapshot.steps.watch_rules?.payload.rules as Record<string, unknown>[] : [];
  if (rules.length === 0) return;
  const existing = await listWatchRules(row.userId, row.instanceId);
  for (const [index, raw] of rules.entries()) {
    const source = { kind: "onboarding_draft", onboarding_draft_commit_key: row.commitKey, onboarding_draft_rule_index: index };
    const alreadyCreated = existing.some((item) => {
      const itemSource = item.source as Record<string, unknown>;
      return itemSource?.onboarding_draft_commit_key === row.commitKey && itemSource?.onboarding_draft_rule_index === index;
    });
    if (alreadyCreated) continue;
    const input = { ...raw, userId: row.userId, instanceId: row.instanceId, source } as any;
    const validated = await validateWatchRule(input);
    if (!validated.ok) throw new Error(`草稿规则 ${index + 1} 无法创建: ${validated.errors.join("；")}`);
    await createWatchRule(input);
  }
}

async function notifyDraftResult(row: typeof onboardingDrafts.$inferSelect, success: boolean, error?: string) {
  const current = (await db.select().from(onboardingDrafts).where(eq(onboardingDrafts.id, row.id)).limit(1))[0] ?? row;
  if (success && current.notifiedAt) return;
  const commitKey = current.commitKey ?? `${current.id}:${current.revision}`;
  const content = success
    ? "初始配置已经完成：持仓与观察仓、投资方法、复盘安排、盘中简报和通知偏好均已生效。你现在可以直接说“今日复盘”或“看看我的持仓风险”。"
    : "初始配置暂未完成，我保留了已确认草稿，会继续重试；配置在完成前不会被标记为生效。";
  const [session] = await db.select({
    userId: conversationSessions.userId,
    projectId: conversationSessions.projectId,
    instanceId: conversationSessions.instanceId,
    assistantId: conversationSessions.assistantId,
  }).from(conversationSessions).where(eq(conversationSessions.conversationId, current.conversationId)).limit(1);
  const deliveryScope = {
    userId: session?.userId ?? current.userId,
    projectId: session?.projectId ?? current.projectId,
    instanceId: session?.instanceId ?? current.instanceId,
    assistantId: session?.assistantId ?? current.instanceId,
  };
  appendConversationMessage({
    scope: deliveryScope,
    conversationId: current.conversationId,
    channel: "weixin-mobile",
    role: "assistant",
    content,
    idempotencyKey: `onboarding-draft:${commitKey}:${success ? "completed" : "failed"}`,
    metadata: { kind: "onboarding_draft_commit", success, error: success ? undefined : error },
  });
  await enqueuePushJob({
    userId: deliveryScope.userId,
    projectId: deliveryScope.projectId,
    instanceId: deliveryScope.instanceId,
    source: "onboarding_commit",
    idempotencyKey: `onboarding-draft:${commitKey}:${success ? "completed" : "failed"}`,
    message: content,
  });
  if (success) {
    await db.update(onboardingDrafts).set({ notifiedAt: nowIso(), updatedAt: nowIso() }).where(eq(onboardingDrafts.id, current.id));
  }
}

async function hasPersistedWaitNotice(row: typeof onboardingDrafts.$inferSelect) {
  if (!row.queuedAt) return false;
  const [notice] = await db.select({ content: conversationMessages.content }).from(conversationMessages).where(and(
    eq(conversationMessages.conversationId, row.conversationId),
    eq(conversationMessages.userId, row.userId),
    eq(conversationMessages.instanceId, row.instanceId),
    eq(conversationMessages.role, "assistant"),
    gt(conversationMessages.createdAt, row.queuedAt),
  )).orderBy(desc(conversationMessages.createdAt)).limit(1);
  // The workspace must not change until the user-visible asynchronous handoff
  // has been recorded by the same conversation turn.
  return Boolean(notice) && /(信息|初始配置)已全部确认[\s\S]{0,80}(正在|会)统一完成/.test(notice.content);
}

async function scopedDraft(scope: Pick<OnboardingDraftScope, "userId" | "instanceId">, id: string) {
  const [row] = await db.select().from(onboardingDrafts).where(and(
    eq(onboardingDrafts.id, id),
    eq(onboardingDrafts.userId, scope.userId),
    eq(onboardingDrafts.instanceId, scope.instanceId),
  )).limit(1);
  if (!row) throw new Error("onboarding draft not found in current scope");
  return row;
}

function validateDraftPayload(step: DraftStepKey, payload: Record<string, unknown>) {
  if (step === "portfolio") return validateOnboardingPortfolioPayload(payload);
  if (step === "watch_rules") {
    if (payload.skip === true || Array.isArray(payload.rules)) return;
    throw new Error("规则步骤需要明确跳过或提供规则草稿");
  }
  if (!isOnboardingStep(step)) throw new Error("invalid onboarding step");
  validateOnboardingStepPayload(step, payload);
}

function mergeDraftPayload(step: DraftStepKey, previous: Record<string, unknown>, next: Record<string, unknown>) {
  if (step !== "portfolio") return { ...previous, ...next };
  const mergeAssets = (oldValue: unknown, nextValue: unknown) => {
    if (!Array.isArray(nextValue)) return oldValue;
    const oldItems = Array.isArray(oldValue) ? oldValue.filter(isRecord) : [];
    return nextValue.filter(isRecord).map((item) => {
      const old = oldItems.find((candidate) => candidate.code === item.code || candidate.name === item.name) ?? {};
      return { ...old, ...item };
    });
  };
  return {
    ...previous,
    ...next,
    ...(next.holdings === undefined ? {} : { holdings: mergeAssets(previous.holdings, next.holdings) }),
    ...(next.watchlist === undefined ? {} : { watchlist: mergeAssets(previous.watchlist, next.watchlist) }),
    ...(isRecord(previous.cash) || isRecord(next.cash) ? { cash: { ...(isRecord(previous.cash) ? previous.cash : {}), ...(isRecord(next.cash) ? next.cash : {}) } } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function requireRecentConfirmation(scope: OnboardingDraftScope, confirmationId: string) {
  const [confirmation] = await db.select({ createdAt: pendingSandboxConfirmations.createdAt }).from(pendingSandboxConfirmations).where(and(
    eq(pendingSandboxConfirmations.id, confirmationId),
    eq(pendingSandboxConfirmations.userId, scope.userId),
    eq(pendingSandboxConfirmations.instanceId, scope.instanceId),
    eq(pendingSandboxConfirmations.conversationId, scope.conversationId),
    eq(pendingSandboxConfirmations.status, "pending"),
  )).limit(1);
  if (!confirmation) throw new Error("pending draft confirmation is unavailable");
  const [latest] = await db.select({ content: conversationMessages.content, createdAt: conversationMessages.createdAt, messageId: conversationMessages.messageId }).from(conversationMessages).where(and(
    eq(conversationMessages.userId, scope.userId),
    eq(conversationMessages.instanceId, scope.instanceId),
    eq(conversationMessages.conversationId, scope.conversationId),
    eq(conversationMessages.role, "user"),
  )).orderBy(desc(conversationMessages.createdAt)).limit(1);
  const text = latest?.content?.trim() || "";
  if (!latest || !text || new Date(latest.createdAt).getTime() <= new Date(confirmation.createdAt).getTime() || !isExplicitConfirmation(text)) {
    throw new Error("recent user message is not an explicit draft confirmation");
  }
  return { messageId: latest.messageId };
}

function isExplicitConfirmation(text: string) {
  const normalized = text.replace(/\s+/g, "");
  return /^(确认|确认保存|确认写入|可以|可以的|就这样|就这个|保存|同意|没问题|ok|OK|Ok|好|好的)$/.test(normalized) || (/确认/.test(normalized) && normalized.length <= 20);
}
