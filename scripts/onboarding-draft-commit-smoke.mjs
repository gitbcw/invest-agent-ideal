#!/usr/bin/env node
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { db, initDb } from "../dist/db/index.js";
import { conversationMessages, conversationSessions, onboardingDrafts, pendingSandboxConfirmations, pushJobs } from "../dist/db/schema.js";
import { ensureWorkspace } from "../dist/lib/workspace.js";
import { WorkspaceStore } from "../dist/lib/workspace-store.js";
import { callServiceTool } from "../dist/mcp/service-tools-core.js";
import { processOnboardingDraftCommits } from "../dist/services/onboarding-drafts.js";

const USER_ID = "onboarding-draft-commit-smoke";
const INSTANCE_ID = "invest-agent-onboarding-draft-commit-smoke";
const CONVERSATION_ID = "onboarding-draft-commit-smoke-conversation";
const context = { userId: USER_ID, instanceId: INSTANCE_ID, projectId: "invest-agent", conversationId: CONVERSATION_ID };

initDb();
await ensureWorkspace({ userId: USER_ID, tenantId: USER_ID, projectId: "invest-agent" });
const store = new WorkspaceStore(USER_ID);

async function cleanup() {
  await db.delete(onboardingDrafts).where(eq(onboardingDrafts.userId, USER_ID));
  await db.delete(pendingSandboxConfirmations).where(eq(pendingSandboxConfirmations.userId, USER_ID));
  await db.delete(pushJobs).where(eq(pushJobs.userId, USER_ID));
  await db.delete(conversationMessages).where(eq(conversationMessages.userId, USER_ID));
  await db.delete(conversationSessions).where(eq(conversationSessions.userId, USER_ID));
}

async function addConfirmation(text) {
  await db.insert(conversationMessages).values({
    messageId: `draft-confirm-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    conversationId: CONVERSATION_ID,
    userId: USER_ID,
    projectId: "invest-agent",
    instanceId: INSTANCE_ID,
    assistantId: INSTANCE_ID,
    channel: "weixin-mobile",
    role: "user",
    content: text,
    status: "completed",
    metadata: "{}",
    createdAt: new Date(Date.now() + 1_000).toISOString(),
  });
}

async function addAssistantMessage(content) {
  await db.insert(conversationMessages).values({
    messageId: `draft-wait-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    conversationId: CONVERSATION_ID,
    userId: USER_ID,
    projectId: "invest-agent",
    instanceId: INSTANCE_ID,
    assistantId: INSTANCE_ID,
    channel: "weixin-mobile",
    role: "assistant",
    content,
    status: "completed",
    metadata: "{}",
    createdAt: new Date(Date.now() + 1_000).toISOString(),
  });
}

async function draftAndAccept(draftId, step, payload) {
  const upserted = await callServiceTool("onboarding.draft.upsert_step", { draftId, step, payload }, context);
  const draft = upserted.draft;
  const revision = draft.steps[step].revision;
  const requested = await callServiceTool("onboarding.draft.request_confirmation", { draftId: draft.id, step, revision }, context);
  await addConfirmation("确认");
  const accepted = await callServiceTool("onboarding.draft.accept_step", {
    confirmedByUser: true,
    confirmationId: requested.confirmationId,
    draftId: draft.id,
    step,
    revision,
  }, context);
  return accepted.draft;
}

await cleanup();
try {
  const sessionNow = new Date().toISOString();
  await db.insert(conversationSessions).values({
    conversationId: CONVERSATION_ID,
    userId: USER_ID,
    projectId: "invest-agent",
    instanceId: INSTANCE_ID,
    assistantId: INSTANCE_ID,
    channel: "weixin-mobile",
    title: "onboarding draft smoke",
    status: "active",
    metadata: "{}",
    messageCount: 0,
    createdAt: sessionNow,
    updatedAt: sessionNow,
  });
  await store.writeOnboardingState({ version: 1, status: "not_started", current_step: "welcome", steps: {}, completed_at: null, updated_at: null, notes: "" });
  await store.writePortfolio({ holdings: [], watchlist: [], accounts: [] });
  const beforePortfolio = JSON.stringify(await store.readPortfolio());
  const beforeState = JSON.stringify(await store.readOnboardingState());

  let draft = await draftAndAccept(undefined, "portfolio", {
    holdings: [{ name: "招商银行", code: "600036", notes: "成本42.1元；仓位30%" }],
    watchlist: [{ name: "赣锋锂业", code: "002460" }],
    cash: { allocationPercent: 40 },
  });
  assert.equal(JSON.stringify(await store.readPortfolio()), beforePortfolio, "accepted draft portfolio must not write workspace");
  assert.equal(JSON.stringify(await store.readOnboardingState()), beforeState, "accepted draft must not advance workspace onboarding state");

  const changed = await callServiceTool("onboarding.draft.upsert_step", {
    draftId: draft.id,
    step: "portfolio",
    payload: { holdings: [{ name: "招商银行", code: "600036", cost: 43.2 }], watchlist: [{ name: "赣锋锂业", code: "002460" }] },
  }, context);
  const previousAccepted = draft.steps.portfolio;
  assert.equal(changed.draft.steps.portfolio.status, "drafted", "editing accepted content creates an unconfirmed revision");
  assert.ok(changed.draft.steps.portfolio.revision > previousAccepted.revision, "editing increments revision");
  assert.equal(changed.draft.steps.portfolio.supersededRevisions[0].revision, previousAccepted.revision, "editing only supersedes the previous portfolio revision");
  const [supersededConfirmation] = await db.select().from(pendingSandboxConfirmations).where(eq(pendingSandboxConfirmations.id, previousAccepted.confirmationId)).limit(1);
  assert.equal(supersededConfirmation.status, "superseded", "editing a draft retires only its prior confirmation revision");
  draft = await draftAndAccept(changed.draft.id, "portfolio", changed.draft.steps.portfolio.payload);
  assert.equal(draft.steps.portfolio.payload.cash.allocationPercent, 40, "editing one portfolio field retains the accepted cash draft");
  draft = await draftAndAccept(draft.id, "style", { styleProfile: { style: "中期趋势", notes: "基本面决定底仓，技术面决定加减仓节奏" } });
  draft = await draftAndAccept(draft.id, "review_schedule", { time: "19:30" });
  draft = await draftAndAccept(draft.id, "market_watch_schedule", { default_windows: ["09:50", "11:20", "14:30"] });
  draft = await draftAndAccept(draft.id, "notification", { notificationPreference: "low_disturbance" });
  draft = await draftAndAccept(draft.id, "watch_rules", { skip: true });
  assert.equal(draft.status, "ready_to_commit", "all accepted sections make draft committable");

  const queued = await callServiceTool("onboarding.draft.enqueue_commit", { draftId: draft.id }, context);
  assert.equal(queued.draft.status, "queued", "final step queues async commit");
  assert.equal(JSON.stringify(await store.readPortfolio()), beforePortfolio, "queue acknowledgement returns before workspace writes");

  await processOnboardingDraftCommits({ limit: 2 });
  assert.equal((await db.select().from(onboardingDrafts).where(eq(onboardingDrafts.id, draft.id)).limit(1))[0].status, "queued", "worker must wait for the user-visible handoff to be persisted");
  assert.equal(JSON.stringify(await store.readPortfolio()), beforePortfolio, "worker must not write workspace before the wait notice");
  await addAssistantMessage("好的，我会继续处理。");
  await processOnboardingDraftCommits({ limit: 2 });
  assert.equal((await db.select().from(onboardingDrafts).where(eq(onboardingDrafts.id, draft.id)).limit(1))[0].status, "queued", "unrelated assistant output must not release the commit worker");
  await addAssistantMessage("信息已全部确认。我现在会统一完成初始配置，这可能需要一点时间；完成后我会通知你。");

  const frozen = (await db.select().from(onboardingDrafts).where(eq(onboardingDrafts.id, draft.id)).limit(1))[0];
  const frozenSnapshot = frozen.commitSnapshotJson;
  await processOnboardingDraftCommits({ limit: 2 });
  const completed = (await db.select().from(onboardingDrafts).where(eq(onboardingDrafts.id, draft.id)).limit(1))[0];
  assert.equal(completed.status, "completed", "worker completes frozen draft");
  assert.equal(completed.commitSnapshotJson, frozenSnapshot, "worker commits the frozen snapshot");
  assert.equal((await store.readOnboardingState()).status, "completed", "onboarding completes only after workspace verification");
  assert.equal((await store.readPortfolio()).holdings[0].cost, 43.2, "latest accepted revision is persisted");
  assert.equal((await store.readPortfolio()).holdings[0].weight, 30, "cost and weight embedded in natural draft content are normalized");
  assert.equal((await store.readPortfolio()).cash.ratio_percent, 40, "cash position supplied in the draft is retained");
  assert.equal((await store.readNotification()).preference.mode, "low_disturbance", "notification is persisted in batch");
  assert.deepEqual((await store.readSchedules()).market_watch.default_windows, ["09:50", "11:20", "14:30"], "schedule is merged once from the draft");
  assert.equal((await store.readSchedules()).daily_review.default_time, "19:30", "flat review-time drafts are retained");

  await processOnboardingDraftCommits({ limit: 2 });
  const completionPushes = await db.select().from(pushJobs).where(and(eq(pushJobs.userId, USER_ID), eq(pushJobs.source, "onboarding_commit")));
  assert.equal(completionPushes.length, 1, "retry/worker rerun does not duplicate completion notification");
  console.log("✓ onboarding draft commit smoke passed");
} finally {
  await cleanup();
}
