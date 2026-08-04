import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { alertRules, conversationMessages, pendingSandboxConfirmations, sandboxAuditLogs } from "../db/schema.js";
import { publishConversationArtifact, type ConversationArtifact } from "../services/conversation-artifacts.js";
import { isWorkspaceBackend, planBackend, portfolioBackend, watchlistBackend } from "../lib/data-backend.js";
import { recordSandboxAudit } from "../lib/sandbox-audit.js";
import { consumeSandboxConfirmation, createSandboxConfirmation, validateSandboxConfirmation } from "../lib/sandbox-confirmation.js";
import type { SandboxContext } from "../lib/sandbox-context.js";
import { DEFAULT_PROJECT_ID, defaultInstanceIdForUser, normalizeUserId } from "../lib/user-context.js";
import {
  WorkspaceStore,
  type OnboardingStateYaml,
  type PortfolioHolding,
  type PortfolioWatchItem,
  type PortfolioYaml,
  type StrategyYaml,
} from "../lib/workspace-store.js";
import { localDateString, saveSkillDailyReview, saveSkillPeriodicReview } from "../handlers/review.js";
import { setPlanWatchConditions, type PlanWatchConditionInput } from "../handlers/plan-conditions.js";
import { researchReadCapability } from "../services/external-evidence-search.js";
import { createWatchRule, dryRunWatchRuleById, listWatchRuleCatalog, listWatchRules, validateWatchRule } from "../services/watch-rules.js";
import { methodChangeBackend } from "../lib/method-change-backend.js";
import { latestMarketWatchSnapshot } from "../services/market-watch-snapshot.js";
import { parseAttachmentWithMineru, isMineruAvailable } from "../services/mineru-parse.js";
import { readAttachmentBytes } from "../services/file-retention.js";
import {
  applyConfirmedOnboardingStep,
  isOnboardingStep as isSharedOnboardingStep,
  normalizeOnboardingState as normalizeSharedOnboardingState,
  validateOnboardingStepPayload,
} from "../services/onboarding.js";
import {
  acceptOnboardingDraftStep,
  enqueueOnboardingDraftCommit,
  getOnboardingDraft,
  requestOnboardingDraftConfirmation,
  skipOnboardingDraftWatchRules,
  upsertOnboardingDraftStep,
  type DraftStepKey,
} from "../services/onboarding-drafts.js";
import { mutationResourceKeysForOperation } from "../services/mutation-resource-keys.js";
import { withResourceMutationLock } from "../services/resource-mutation-lock.js";
import { applyUserPreferenceChange, planUserPreferenceChange, type UserPreferenceChangeInput } from "../services/user-preferences.js";

export interface ServiceToolContext {
  userId: string;
  instanceId: string;
  workspacePath?: string;
  projectId?: string;
  conversationId?: string;
  expectedReviewKind?: "daily" | "weekly" | "monthly";
  expectedReviewKey?: string;
}

export interface ServiceToolFailureInjection {
  artifactPublish?: (relativePath: string) => Error | undefined;
}

let serviceToolFailureInjection: ServiceToolFailureInjection = {};

export function __setServiceToolFailureInjection(injection: ServiceToolFailureInjection = {}): void {
  serviceToolFailureInjection = injection;
}

export function serviceToolContextFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceToolContext {
  const userId = normalizeUserId(env.INVEST_AGENT_MCP_USER_ID);
  const instanceId = (env.INVEST_AGENT_MCP_INSTANCE_ID || defaultInstanceIdForUser(userId)).trim();
  const workspacePath = env.INVEST_AGENT_MCP_WORKSPACE_PATH?.trim() || undefined;
  const conversationId = env.INVEST_AGENT_MCP_CONVERSATION_ID?.trim() || undefined;
  const rawExpectedKind = env.INVEST_AGENT_MCP_EXPECTED_REVIEW_KIND?.trim();
  const expectedReviewKind = rawExpectedKind === "daily" || rawExpectedKind === "weekly" || rawExpectedKind === "monthly"
    ? rawExpectedKind
    : undefined;
  const expectedReviewKey = env.INVEST_AGENT_MCP_EXPECTED_REVIEW_KEY?.trim() || undefined;
  return {
    userId,
    instanceId,
    workspacePath,
    projectId: DEFAULT_PROJECT_ID,
    conversationId,
    expectedReviewKind,
    expectedReviewKey,
  };
}

export function assertScheduledReviewTarget(
  context: ServiceToolContext,
  kind: "daily" | "weekly" | "monthly",
  requestedKey: string,
): void {
  if (!context.expectedReviewKind || !context.expectedReviewKey) {
    throw new Error("scheduled reviews.save missing service-enforced publication target");
  }
  if (kind !== context.expectedReviewKind || requestedKey !== context.expectedReviewKey) {
    throw new Error(
      `scheduled reviews.save target mismatch: expected ${context.expectedReviewKind}/${context.expectedReviewKey}, got ${kind}/${requestedKey}`,
    );
  }
}

export async function callServiceTool(
  name: string,
  input: Record<string, unknown> | undefined,
  context: ServiceToolContext
): Promise<unknown> {
  try {
    const resourceKeys = mutationResourceKeysForOperation(name, input);
    return resourceKeys.length > 0
      ? await withResourceMutationLock(context, resourceKeys, () => dispatchServiceTool(name, input, context))
      : await dispatchServiceTool(name, input, context);
  } catch (error) {
    if (CONFIRMED_WRITE_OPERATIONS.has(name) || DRAFT_OPERATIONS.has(name) || name === "confirmations.request" || name === "onboarding.complete_watch_setup" || name === "reviews.save" || name === "artifacts.publish" || name === "research.web_search" || name === "research.web_read") {
      await audit(context, {
        operation: name,
        resourceType: "service_tool",
        resourceId: name === "research.web_read"
          ? redactUrlForAudit(stringInput(input?.url))
          : stringInput(input?.step ?? input?.stockCode ?? input?.code),
        requestBody: name === "research.web_read"
          ? { url: redactUrlForAudit(stringInput(input?.url)), maxCharacters: input?.maxCharacters }
          : input,
        resultSummary: error instanceof Error ? error.message : String(error),
        status: "error",
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function dispatchServiceTool(
  name: string,
  input: Record<string, unknown> | undefined,
  context: ServiceToolContext
): Promise<unknown> {
  switch (name) {
    case "file.parse": {
      const attachmentId = stringInput(input?.attachment_id);
      if (!attachmentId) throw new Error("attachment_id is required");
      const language = stringInput(input?.language) || "ch";
      if (!isMineruAvailable()) {
        throw new Error("file.parse 不可用:MINERU_API_TOKEN 未配置。请让用户通过其他方式提供文件内容,或联系运营配置 MinerU。");
      }
      // 读附件字节 (scope 绑定 userId/instanceId,防越权读取)
      const { bytes, record } = await readAttachmentBytes({
        attachmentId,
        userId: context.userId,
        instanceId: context.instanceId,
      });
      const result = await parseAttachmentWithMineru({
        attachmentId,
        userId: context.userId,
        instanceId: context.instanceId,
        fileName: record.fileName || `${attachmentId}.pdf`,
        bytes,
        language,
      });
      await audit(context, {
        operation: "file.parse",
        resourceType: "attachment",
        resourceId: attachmentId,
        requestBody: { attachmentId, language, fileName: record.fileName },
        resultSummary: `chars=${result.markdown.length}; taskId=${result.taskId}`,
      });
      return {
        ok: true,
        userId: context.userId,
        instanceId: context.instanceId,
        attachmentId,
        fileName: record.fileName,
        markdown: result.markdown,
        taskId: result.taskId,
      };
    }
    case "market_watch.snapshot": {
      const result = await latestMarketWatchSnapshot(context.userId, context.instanceId);
      await audit(context, {
        operation: "market_watch.snapshot",
        resourceType: "market_watch_snapshot",
        resourceId: result?.id,
        resultSummary: result
          ? `window=${result.windowKey}; capturedAt=${result.capturedAt}`
          : "no scheduler snapshot available",
      });
      return { ok: true, userId: context.userId, instanceId: context.instanceId, result };
    }
    case "research.news_search": {
      const query = stringInput(input?.query);
      if (!query) throw new Error("query is required");
      const days = clampInteger(input?.days, 1, 90, 14);
      const limit = clampInteger(input?.limit, 1, 10, 8);
      const result = await researchReadCapability.newsSearch({ query, days, limit, userId: context.userId });
      await audit(context, {
        operation: "research.news_search",
        resourceType: "external_evidence",
        requestBody: { query, days, limit },
        resultSummary: `count=${result.items.length}; warnings=${result.source.warnings.length}`,
      });
      return { ok: true, userId: context.userId, instanceId: context.instanceId, result };
    }
    case "research.web_search": {
      const query = stringInput(input?.query);
      if (!query) throw new Error("query is required");
      const limit = clampInteger(input?.limit, 1, 10, 8);
      const result = await researchReadCapability.webSearch({ query, limit, userId: context.userId });
      await audit(context, {
        operation: "research.web_search",
        resourceType: "external_evidence",
        requestBody: { query, limit },
        resultSummary: `provider=${result.source.provider}; count=${result.items.length}; warnings=${result.source.warnings.length}`,
      });
      return { ok: true, userId: context.userId, instanceId: context.instanceId, result };
    }
    case "research.web_read": {
      const url = stringInput(input?.url);
      if (!url) throw new Error("url is required");
      const maxCharacters = clampInteger(input?.maxCharacters, 2_000, 50_000, 20_000);
      const result = await researchReadCapability.webRead({ url, maxCharacters, userId: context.userId });
      await audit(context, {
        operation: "research.web_read",
        resourceType: "external_evidence",
        resourceId: redactUrlForAudit(result.page?.url || result.requestedUrl),
        requestBody: { url: redactUrlForAudit(url), maxCharacters },
        resultSummary: result.page
          ? `contentType=${result.page.contentType}; characters=${result.page.text.length}; warnings=${result.source.warnings.length}`
          : `page_unavailable; warnings=${result.source.warnings.length}`,
      });
      return { ok: true, userId: context.userId, instanceId: context.instanceId, result };
    }
    case "portfolio.read": {
      const rows = await portfolioBackend.listActive(context.userId, context.instanceId);
      const portfolio = await new WorkspaceStore(context.userId).readPortfolio();
      await audit(context, {
        operation: "portfolio.read",
        resourceType: "portfolio",
        resourceId: context.instanceId,
        resultSummary: `holdings=${rows.length}; revision=${portfolio?.last_confirmed_at ?? "null"}`,
      });
      return {
        ok: true,
        userId: context.userId,
        instanceId: context.instanceId,
        count: rows.length,
        revision: portfolio?.last_confirmed_at ?? null,
        cash: portfolio?.cash ?? null,
        items: rows.map((row) => {
          const holding = portfolio?.holdings?.find((item) => item.code === row.code);
          return {
            id: row.rowId ?? null,
            stockCode: row.code,
            stockName: row.name,
            buyDate: row.buyDate,
            costPrice: holding?.cost ?? row.costPrice ?? null,
            shares: holding?.shares ?? null,
            weight: holding?.weight ?? null,
            notes: holding?.notes ?? null,
            sellPrice: row.sellPrice ?? null,
            sellDate: row.sellDate ?? null,
            status: row.status,
          };
        }),
      };
    }
    case "watchlist.read": {
      const rows = await watchlistBackend.list(context.userId, context.instanceId);
      await audit(context, {
        operation: "watchlist.read",
        resourceType: "watchlist",
        resourceId: context.instanceId,
        resultSummary: `watchlist=${rows.length}`,
      });
      return {
        ok: true,
        userId: context.userId,
        instanceId: context.instanceId,
        count: rows.length,
        items: rows.map((row) => ({
          id: row.rowId ?? null,
          stockCode: row.code,
          stockName: row.name,
          addedAt: row.addedAt ?? null,
          reason: row.reason ?? null,
          source: row.source ?? "manual",
        })),
      };
    }
    case "plans.read": {
      const rows = await planBackend.list(context.userId, context.instanceId);
      await audit(context, {
        operation: "plans.read",
        resourceType: "stock_plans",
        resourceId: context.instanceId,
        resultSummary: `plans=${rows.length}`,
      });
      return {
        ok: true,
        userId: context.userId,
        instanceId: context.instanceId,
        count: rows.length,
        items: rows.map((row) => ({
          id: row.rowId ?? null,
          stockCode: row.code,
          stockName: row.name,
          support: row.support ?? null,
          resistance: row.resistance ?? null,
          targetPrice: row.targetPrice ?? null,
          stopLoss: row.stopLoss ?? null,
          notes: row.notes ?? null,
          planType: row.planType ?? "manual",
          strategyKey: row.strategyKey ?? null,
          updatedAt: row.updatedAt,
        })),
      };
    }
    case "conversation.history":
      return readConversationHistory(input, context);
    case "confirmations.pending":
      return readPendingConfirmations(input, context);
    case "confirmations.request":
      return requestConfirmation(input, context);
    case "portfolio.apply_changes":
      return applyPortfolioChanges(input, context);
    case "onboarding.confirm_portfolio":
      return confirmOnboardingPortfolio(input, context);
    case "onboarding.confirm_step":
      return confirmOnboardingStep(input, context);
    case "onboarding.complete_watch_setup":
      return completeOnboardingWatchSetup(input, context);
    case "onboarding.draft.get":
      return readOnboardingDraft(context);
    case "onboarding.draft.upsert_step":
      return upsertOnboardingDraft(input, context);
    case "onboarding.draft.request_confirmation":
      return requestOnboardingDraftStepConfirmation(input, context);
    case "onboarding.draft.accept_step":
      return acceptOnboardingDraft(input, context);
    case "onboarding.draft.skip_watch_rules":
      return skipOnboardingDraftRules(input, context);
    case "onboarding.draft.enqueue_commit":
      return enqueueOnboardingDraft(input, context);
    case "onboarding.draft.commit_status":
      return readOnboardingDraft(context);
    case "watchlist.add":
      return addWatchlist(input, context);
    case "plans.set":
      return setPlan(input, context);
    case "plans.watch_conditions":
      return setPlanConditions(input, context);
    case "method_changes.propose":
      return proposeMethodChange(input, context);
    case "method_changes.apply":
      return applyMethodChange(input, context);
    case "preferences.apply":
      return applyUserPreferences(input, context);
    case "reviews.save":
      return saveReview(input, context);
    case "artifacts.publish":
      return publishArtifact(input, context);
    case "watch_rules.catalog":
      return { ok: true, userId: context.userId, instanceId: context.instanceId, items: listWatchRuleCatalog() };
    case "watch_rules.list":
      return { ok: true, userId: context.userId, instanceId: context.instanceId, items: await listWatchRules(context.userId, context.instanceId) };
    case "watch_rules.validate": {
      const validation = await validateWatchRule({
        ...input,
        userId: context.userId,
        instanceId: context.instanceId,
      });
      return { ok: validation.ok, userId: context.userId, instanceId: context.instanceId, validation, errors: validation.errors };
    }
    case "watch_rules.create": {
      const confirmation = await prepareBoundConfirmation(input, context, "watch_rules.create");
      const rule = await createWatchRule({
        ...(input as any),
        userId: context.userId,
        instanceId: context.instanceId,
        source: { kind: "mcp_tool", actor: "workspace_codex" },
      });
      await confirmation.consume();
      await audit(context, {
        operation: "watch_rules.create",
        resourceType: "watch_rule",
        resourceId: String(rule.id),
        requestBody: input,
        resultSummary: `created ${rule.ruleType} ${rule.stockCode}`,
      });
      return { ok: true, userId: context.userId, instanceId: context.instanceId, rule };
    }
    case "watch_rules.dry_run": {
      const id = requirePositiveInteger(input?.id, "id");
      const result = await dryRunWatchRuleById(id, context.userId, context.instanceId);
      return { ok: true, userId: context.userId, instanceId: context.instanceId, result };
    }
    default:
      throw new Error(`Unknown service tool: ${name}`);
  }
}

async function readConversationHistory(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const conversationId = stringInput(input?.conversationId) || context.conversationId;
  if (!conversationId) {
    return {
      ok: false,
      userId: context.userId,
      instanceId: context.instanceId,
      reason: "conversationId is unavailable",
      messages: [],
    };
  }
  const limit = clampInteger(input?.limit, 1, 50, 12);
  const rows = await db
    .select()
    .from(conversationMessages)
    .where(and(
      eq(conversationMessages.userId, context.userId),
      eq(conversationMessages.instanceId, context.instanceId),
      eq(conversationMessages.conversationId, conversationId)
    ))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(limit);
  return {
    ok: true,
    userId: context.userId,
    instanceId: context.instanceId,
    conversationId,
    count: rows.length,
    messages: rows.reverse().map((row) => ({
      role: row.role,
      content: compactToolText(row.content),
      createdAt: row.createdAt,
    })),
  };
}

async function readPendingConfirmations(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const conversationId = stringInput(input?.conversationId) || context.conversationId;
  const limit = clampInteger(input?.limit, 1, 50, 20);
  const rows = await db
    .select()
    .from(pendingSandboxConfirmations)
    .where(and(
      eq(pendingSandboxConfirmations.userId, context.userId),
      eq(pendingSandboxConfirmations.instanceId, context.instanceId),
      eq(pendingSandboxConfirmations.status, "pending")
    ))
    .orderBy(desc(pendingSandboxConfirmations.createdAt))
    .limit(limit);
  const now = Date.now();
  const confirmations = rows
    .filter((row) => new Date(row.expiresAt).getTime() > now)
    .filter((row) => !conversationId || (row.conversationId ?? "") === conversationId)
    .map((row) => ({
      confirmationId: row.id,
      operation: row.operation,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      requestBody: safeJson(row.requestBody),
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    }));
  return {
    ok: true,
    userId: context.userId,
    instanceId: context.instanceId,
    conversationId: conversationId || null,
    count: confirmations.length,
    confirmations,
  };
}

async function confirmOnboardingPortfolio(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const confirmation = await prepareBoundConfirmation(input, context, "onboarding.confirm_portfolio");
  const holdingInputs = normalizeOnboardingAssetList(input?.holdings);
  const watchInputs = normalizeOnboardingAssetList(input?.watchlist);
  if (!holdingInputs.length && !watchInputs.length) throw new Error("至少需要一个持仓或观察仓标的");
  const missingCodes = [
    ...findOnboardingAssetsMissingCode("holding", holdingInputs),
    ...findOnboardingAssetsMissingCode("watchlist", watchInputs),
  ];
  if (missingCodes.length > 0) {
    throw new Error(`持仓和观察仓写入前必须补齐 6 位证券代码: ${JSON.stringify(missingCodes)}`);
  }

  const now = new Date().toISOString();
  const store = new WorkspaceStore(context.userId);
  const portfolio = (await store.readPortfolio()) ?? { holdings: [], watchlist: [], accounts: [] };
  const holdings = Array.isArray(portfolio.holdings) ? [...portfolio.holdings] : [];
  const watchItems = Array.isArray(portfolio.watchlist) ? [...portfolio.watchlist] : [];

  for (const item of holdingInputs) {
    const idx = holdings.findIndex((existing: any) => existing.code === item.code || existing.name === item.name);
    const next = {
      ...(idx >= 0 ? holdings[idx] : {}),
      name: item.name,
      code: item.code,
      asset_type: idx >= 0 ? (holdings[idx] as any).asset_type ?? null : null,
      market: idx >= 0 ? (holdings[idx] as any).market ?? null : null,
      account: idx >= 0 ? (holdings[idx] as any).account ?? null : null,
      currency: idx >= 0 ? (holdings[idx] as any).currency ?? "CNY" : "CNY",
      cost: idx >= 0 ? (holdings[idx] as any).cost ?? null : null,
      shares: idx >= 0 ? (holdings[idx] as any).shares ?? null : null,
      market_value: idx >= 0 ? (holdings[idx] as any).market_value ?? null : null,
      weight: idx >= 0 ? (holdings[idx] as any).weight ?? null : null,
      notes: item.notes || (idx >= 0 ? (holdings[idx] as any).notes : "") || "User confirmed holding name only; details can be completed later.",
    };
    if (idx >= 0) holdings[idx] = next as any;
    else holdings.push(next as any);
  }

  for (const item of watchInputs) {
    const idx = watchItems.findIndex((existing: any) => existing.code === item.code || existing.name === item.name);
    const next = {
      ...(idx >= 0 ? watchItems[idx] : {}),
      name: item.name,
      code: item.code,
      asset_type: idx >= 0 ? (watchItems[idx] as any).asset_type ?? null : null,
      market: idx >= 0 ? (watchItems[idx] as any).market ?? null : null,
      trigger: idx >= 0 ? (watchItems[idx] as any).trigger ?? "" : "",
      evidence_needed: Array.isArray(idx >= 0 ? (watchItems[idx] as any).evidence_needed : null)
        ? (watchItems[idx] as any).evidence_needed
        : [],
      notes: item.notes || (idx >= 0 ? (watchItems[idx] as any).notes : "") || "User confirmed watch name only; trigger can be completed later.",
    };
    if (idx >= 0) watchItems[idx] = next as any;
    else watchItems.push(next as any);
  }

  await store.writePortfolio({
    ...portfolio,
    holdings: holdings as any,
    watchlist: watchItems as any,
    accounts: Array.isArray(portfolio.accounts) ? portfolio.accounts : [],
    last_confirmed_at: now,
    last_confirmed_by: "user",
  });
  const state = normalizeSharedOnboardingState(await store.readOnboardingState());
  const steps = { ...(state.steps ?? {}) };
  steps.welcome = { done: true, completed_at: steps.welcome?.completed_at ?? now };
  steps.portfolio = { done: true, completed_at: steps.portfolio?.completed_at ?? now };
  const nextState: OnboardingStateYaml = {
    ...state,
    status: "in_progress",
    current_step: "style",
    steps,
    updated_at: now,
    notes: stringInput(input?.notes) ?? state.notes ?? "",
  };
  await store.writeOnboardingState(nextState);
  await store.appendChangeLog({
    ts: now,
    source: "mcp",
    type: "onboarding_portfolio_confirmed",
    summary: stringInput(input?.summary) || "用户确认 onboarding 持仓和观察仓",
    details: {
      holding_names: holdingInputs.map((item) => item.name),
      watch_names: watchInputs.map((item) => item.name),
      current_step: nextState.current_step,
    },
  });
  await confirmation.consume();
  await audit(context, {
    operation: "onboarding.confirm_portfolio",
    resourceType: "onboarding_state",
    resourceId: "portfolio",
    requestBody: input,
    resultSummary: `confirmed portfolio holdings=${holdingInputs.length}; watchlist=${watchInputs.length}; current=style`,
  });
  const publication = await publishWorkspaceArtifacts(
    context,
    [
      { relativePath: "config/portfolio.yaml", kind: "data", title: "当前持仓配置" },
      { relativePath: "config/onboarding_state.yaml", kind: "data", title: "初始配置状态" },
    ],
    "onboarding.confirm_portfolio",
  );
  return {
    ok: true,
    userId: context.userId,
    instanceId: context.instanceId,
    state: nextState,
    holdings,
    watchlist: watchItems,
    ...artifactPublicationFields(publication),
  };
}

const DRAFT_OPERATIONS = new Set([
  "onboarding.draft.get",
  "onboarding.draft.upsert_step",
  "onboarding.draft.request_confirmation",
  "onboarding.draft.accept_step",
  "onboarding.draft.skip_watch_rules",
  "onboarding.draft.enqueue_commit",
  "onboarding.draft.commit_status",
]);

function requireDraftConversation(context: ServiceToolContext) {
  if (!context.conversationId) throw new Error("conversationId is required for onboarding drafts");
  return {
    userId: context.userId,
    instanceId: context.instanceId,
    projectId: context.projectId || DEFAULT_PROJECT_ID,
    conversationId: context.conversationId,
  };
}

function draftStep(input: Record<string, unknown> | undefined): DraftStepKey {
  const step = stringInput(input?.step);
  if (step !== "portfolio" && step !== "style" && step !== "review_schedule" && step !== "market_watch_schedule" && step !== "notification" && step !== "watch_rules") {
    throw new Error(`非法 onboarding 草稿步骤: ${String(step ?? "")}`);
  }
  return step;
}

async function readOnboardingDraft(context: ServiceToolContext) {
  const draft = await getOnboardingDraft(context);
  return { ok: true, userId: context.userId, instanceId: context.instanceId, draft };
}

async function upsertOnboardingDraft(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const scope = requireDraftConversation(context);
  const payload = asRecord(input?.payload);
  const draft = await upsertOnboardingDraftStep(scope, {
    draftId: stringInput(input?.draftId),
    step: draftStep(input),
    payload,
  });
  await audit(context, {
    operation: "onboarding.draft.upsert_step",
    resourceType: "onboarding_draft",
    resourceId: draft.id,
    requestBody: input,
    resultSummary: `draft=${draft.id}; step=${String(input?.step)}; revision=${draft.revision}`,
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, draft };
}

async function requestOnboardingDraftStepConfirmation(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const scope = requireDraftConversation(context);
  const draftId = stringInput(input?.draftId);
  if (!draftId) throw new Error("draftId is required");
  const requested = await requestOnboardingDraftConfirmation(scope, {
    draftId,
    step: draftStep(input),
    revision: Number(input?.revision),
    sandbox: mcpSandboxContext(context, `mcp-onboarding-draft-request:${Date.now()}`),
  });
  await audit(context, {
    operation: "onboarding.draft.request_confirmation",
    resourceType: "onboarding_draft_step",
    resourceId: `${requested.draftId}:${requested.step}:${requested.revision}`,
    requestBody: input,
    resultSummary: `draft confirmation requested step=${requested.step}; revision=${requested.revision}`,
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, ...requested };
}

async function acceptOnboardingDraft(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  requireConfirmed(input);
  const scope = requireDraftConversation(context);
  const confirmationId = stringInput(input?.confirmationId);
  const draftId = stringInput(input?.draftId);
  if (!confirmationId) throw new Error("confirmationId is required after requesting confirmation");
  if (!draftId) throw new Error("draftId is required");
  const draft = await acceptOnboardingDraftStep(scope, {
    draftId,
    step: draftStep(input),
    revision: Number(input?.revision),
    confirmationId,
    sandbox: mcpSandboxContext(context, `mcp-onboarding-draft-accept:${Date.now()}`),
  });
  await audit(context, {
    operation: "onboarding.draft.accept_step",
    resourceType: "onboarding_draft_step",
    resourceId: `${draft.id}:${String(input?.step)}:${Number(input?.revision)}`,
    requestBody: input,
    resultSummary: `draft step accepted; status=${draft.status}; next=${draft.nextStep}`,
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, draft, readyToCommit: draft.status === "ready_to_commit" };
}

async function skipOnboardingDraftRules(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const scope = requireDraftConversation(context);
  const draftId = stringInput(input?.draftId);
  if (!draftId) throw new Error("draftId is required");
  const draft = await skipOnboardingDraftWatchRules(scope, { draftId });
  await audit(context, {
    operation: "onboarding.draft.skip_watch_rules",
    resourceType: "onboarding_draft_step",
    resourceId: `${draft.id}:watch_rules:${draft.revision}`,
    requestBody: input,
    resultSummary: `draft watch rules skipped; status=${draft.status}`,
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, draft, readyToCommit: true };
}

async function enqueueOnboardingDraft(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const scope = requireDraftConversation(context);
  const draftId = stringInput(input?.draftId);
  if (!draftId) throw new Error("draftId is required");
  const draft = await enqueueOnboardingDraftCommit(scope, draftId);
  await audit(context, {
    operation: "onboarding.draft.enqueue_commit",
    resourceType: "onboarding_draft",
    resourceId: draft.id,
    requestBody: input,
    resultSummary: `draft commit queued key=${draft.commitKey ?? "-"}`,
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, draft, message: "信息已全部确认，正在统一完成初始配置。" };
}

async function confirmOnboardingStep(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const step = stringInput(input?.step);
  if (!isSharedOnboardingStep(step)) throw new Error(`非法 onboarding step: ${String(step ?? "")}`);
  const confirmation = await prepareBoundConfirmation(input, context, "onboarding.confirm_step");
  const now = new Date().toISOString();
  const store = new WorkspaceStore(context.userId);
  const nextState = await applyConfirmedOnboardingStep({ store, step, body: input ?? {}, now });
  await store.appendChangeLog({
    ts: now,
    source: "mcp",
    type: `onboarding_${step}_confirmed`,
    summary: stringInput(input?.summary) || `用户确认 onboarding 步骤: ${step}`,
    details: { step, status: nextState.status, current_step: nextState.current_step },
  });
  await confirmation.consume();
  await audit(context, {
    operation: "onboarding.confirm_step",
    resourceType: "onboarding_state",
    resourceId: step,
    requestBody: input,
    resultSummary: `confirmed ${step}; status=${nextState.status}`,
  });
  const publication = await publishWorkspaceArtifacts(context, onboardingArtifactSpecs(step), "onboarding.confirm_step");
  return {
    ok: true,
    userId: context.userId,
    instanceId: context.instanceId,
    state: nextState,
    message: nextState.status === "completed" ? "新手引导已完成" : `已确认 ${step}`,
    ...artifactPublicationFields(publication),
  };
}

async function completeOnboardingWatchSetup(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const branch = stringInput(input?.branch);
  if (branch !== "skip" && branch !== "configured") throw new Error("branch must be skip or configured");
  if (!context.conversationId) throw new Error("conversationId is required to complete onboarding watch setup");

  const store = new WorkspaceStore(context.userId);
  const current = normalizeSharedOnboardingState(await store.readOnboardingState());
  if (current.status === "completed") {
    return { ok: true, userId: context.userId, instanceId: context.instanceId, state: current, branch, ruleIds: [] };
  }
  if (current.current_step !== "watch_rules") {
    throw new Error(`watch setup can only complete from current_step=watch_rules; current=${current.current_step}`);
  }

  const pendingRuleDrafts = await db.select().from(pendingSandboxConfirmations).where(and(
    eq(pendingSandboxConfirmations.userId, context.userId),
    eq(pendingSandboxConfirmations.instanceId, context.instanceId),
    eq(pendingSandboxConfirmations.conversationId, context.conversationId),
    eq(pendingSandboxConfirmations.operation, "watch_rules.create"),
    eq(pendingSandboxConfirmations.status, "pending")
  ));
  const activePending = pendingRuleDrafts.filter((row) => new Date(row.expiresAt).getTime() > Date.now());
  if (activePending.length > 0) throw new Error("仍有待确认的明确规则草案，不能结束初始配置");
  const expiredDraftIds = pendingRuleDrafts.filter((row) => new Date(row.expiresAt).getTime() <= Date.now()).map((row) => row.id);
  if (expiredDraftIds.length > 0) {
    await db.update(pendingSandboxConfirmations).set({
      status: "expired",
      updatedAt: new Date().toISOString(),
    }).where(inArray(pendingSandboxConfirmations.id, expiredDraftIds));
  }

  let ruleIds: number[] = [];
  if (branch === "skip") {
    const [latestUserMessage] = await db.select({ content: conversationMessages.content })
      .from(conversationMessages)
      .where(and(
        eq(conversationMessages.userId, context.userId),
        eq(conversationMessages.instanceId, context.instanceId),
        eq(conversationMessages.conversationId, context.conversationId),
        eq(conversationMessages.role, "user")
      ))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(1);
    if (!isExplicitWatchSetupSkipText(latestUserMessage?.content ?? "")) {
      throw new Error("skip branch requires the latest user message to explicitly skip watch-rule setup");
    }
  } else {
    ruleIds = normalizePositiveIds(input?.ruleIds);
    if (ruleIds.length === 0) throw new Error("configured branch requires at least one ruleId");
    const scopedRules = await db.select({ id: alertRules.id }).from(alertRules).where(and(
      eq(alertRules.userId, context.userId),
      eq(alertRules.instanceId, context.instanceId),
      inArray(alertRules.id, ruleIds)
    ));
    const scopedIds = new Set(scopedRules.map((row) => row.id));
    const missingRules = ruleIds.filter((id) => !scopedIds.has(id));
    if (missingRules.length > 0) throw new Error(`configured watch rules are missing or out of scope: ${missingRules.join(",")}`);

    const creationAudits = await db.select({ resourceId: sandboxAuditLogs.resourceId }).from(sandboxAuditLogs).where(and(
      eq(sandboxAuditLogs.userId, context.userId),
      eq(sandboxAuditLogs.instanceId, context.instanceId),
      eq(sandboxAuditLogs.conversationId, context.conversationId),
      eq(sandboxAuditLogs.operation, "watch_rules.create"),
      eq(sandboxAuditLogs.status, "success"),
      inArray(sandboxAuditLogs.resourceId, ruleIds.map(String))
    ));
    const auditedIds = new Set(creationAudits.map((row) => Number(row.resourceId)));
    const unauditedRules = ruleIds.filter((id) => !auditedIds.has(id));
    if (unauditedRules.length > 0) throw new Error(`configured watch rules lack confirmed creation audit: ${unauditedRules.join(",")}`);
  }

  const now = new Date().toISOString();
  const nextState = await applyConfirmedOnboardingStep({
    store,
    step: "watch_rules",
    body: {
      summary: stringInput(input?.summary) || (branch === "skip" ? "用户暂不设置明确规则" : `已确认并创建 ${ruleIds.length} 条明确规则`),
    },
    now,
  });
  await db.update(pendingSandboxConfirmations).set({
    status: "superseded",
    updatedAt: now,
  }).where(and(
    eq(pendingSandboxConfirmations.userId, context.userId),
    eq(pendingSandboxConfirmations.instanceId, context.instanceId),
    eq(pendingSandboxConfirmations.conversationId, context.conversationId),
    eq(pendingSandboxConfirmations.operation, "onboarding.confirm_step"),
    eq(pendingSandboxConfirmations.resourceId, "watch_rules"),
    eq(pendingSandboxConfirmations.status, "pending")
  ));
  await store.appendChangeLog({
    ts: now,
    source: "mcp",
    type: "onboarding_watch_setup_completed",
    summary: stringInput(input?.summary) || (branch === "skip" ? "用户暂不设置明确规则" : `已创建并核对 ${ruleIds.length} 条明确规则`),
    details: { branch, rule_ids: ruleIds, status: nextState.status },
  });
  await audit(context, {
    operation: "onboarding.complete_watch_setup",
    resourceType: "onboarding_state",
    resourceId: "watch_rules",
    requestBody: { branch, ruleIds, summary: input?.summary },
    resultSummary: `completed watch setup branch=${branch}; rules=${ruleIds.length}`,
  });
  const publication = await publishWorkspaceArtifacts(context, onboardingArtifactSpecs("watch_rules"), "onboarding.complete_watch_setup");
  return {
    ok: true,
    userId: context.userId,
    instanceId: context.instanceId,
    state: nextState,
    branch,
    ruleIds,
    ...artifactPublicationFields(publication),
  };
}

async function addWatchlist(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const confirmation = await prepareBoundConfirmation(input, context, "watchlist.add");
  const name = stringInput(input?.name ?? input?.stockName);
  const code = stringInput(input?.code ?? input?.stockCode);
  if (!code) throw new Error("缺少 6 位股票代码；请先通过外部数据 MCP 或用户确认完成代码解析");
  if (!/^\d{6}$/.test(code)) throw new Error("stockCode 必须是 6 位数字代码（如 600519），不带 sh/sz 前缀");
  const stockCode = code;
  const existing = await watchlistBackend.find(context.userId, context.instanceId, stockCode);
  if (existing) {
    await confirmation.consume();
    return { ok: false, error: `${existing.name}(${stockCode}) 已在自选池中`, userId: context.userId };
  }
  const stockName = name || stockCode;
  await watchlistBackend.add(context.userId, context.instanceId, {
    code: stockCode,
    name: stockName,
    reason: normalizeWatchlistReason(stringInput(input?.reason) || "AI 助手根据对话加入"),
    source: "ai_conversation",
  });
  await confirmation.consume();
  await audit(context, {
    operation: "watchlist.add",
    resourceType: "watchlist",
    resourceId: stockCode,
    requestBody: input,
    resultSummary: `added ${stockName}(${stockCode})`,
  });
  const publication: WorkspaceArtifactPublication = isWorkspaceBackend()
    ? await publishWorkspaceArtifacts(
      context,
      [{ relativePath: "config/portfolio.yaml", kind: "data", title: "当前持仓配置" }],
      "watchlist.add",
    )
    : { artifacts: [], failures: [] };
  return {
    ok: true,
    userId: context.userId,
    instanceId: context.instanceId,
    message: `已添加 ${stockName}(${stockCode}) 到自选池`,
    stockCode,
    stockName,
    ...artifactPublicationFields(publication),
  };
}

async function setPlan(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const confirmation = await prepareBoundConfirmation(input, context, "plans.set");
  const stockCode = stringInput(input?.stockCode ?? input?.code);
  if (!stockCode) throw new Error("缺少股票代码");
  if (!/^\d{6}$/.test(stockCode)) throw new Error("stockCode 必须是 6 位数字代码（如 600519），不带 sh/sz 前缀");
  const stockName = stringInput(input?.stockName ?? input?.name) || stockCode;
  const existing = await planBackend.find(context.userId, context.instanceId, stockCode);
  await planBackend.upsert(context.userId, context.instanceId, {
    code: stockCode,
    name: stockName,
    support: numberOrExisting(input?.support, existing?.support),
    resistance: numberOrExisting(input?.resistance, existing?.resistance),
    targetPrice: numberOrExisting(input?.targetPrice, existing?.targetPrice),
    stopLoss: numberOrExisting(input?.stopLoss, existing?.stopLoss),
    notes: input?.notes !== undefined ? stringInput(input.notes) ?? null : existing?.notes ?? null,
    watchConditions: Array.isArray(input?.watchConditions) ? input.watchConditions as any : existing?.watchConditions,
    linkedAlertRuleIds: Array.isArray(input?.linkedAlertRuleIds) ? input.linkedAlertRuleIds.map(String) : existing?.linkedAlertRuleIds,
    planType: stringInput(input?.planType) || existing?.planType || "manual",
    strategyKey: input?.strategyKey !== undefined ? stringInput(input.strategyKey) : existing?.strategyKey ?? null,
  });
  await confirmation.consume();
  await audit(context, {
    operation: "plans.set",
    resourceType: "stock_plan",
    resourceId: stockCode,
    requestBody: input,
    resultSummary: `${existing ? "updated" : "created"} ${stockName}(${stockCode})`,
  });
  const publication: WorkspaceArtifactPublication = isWorkspaceBackend()
    ? await publishWorkspaceArtifacts(
      context,
      [{ relativePath: "config/portfolio.yaml", kind: "data", title: "当前持仓配置" }],
      "plans.set",
    )
    : { artifacts: [], failures: [] };
  return {
    ok: true,
    userId: context.userId,
    instanceId: context.instanceId,
    message: `${stockName}(${stockCode}) 预案已${existing ? "更新" : "创建"}`,
    ...artifactPublicationFields(publication),
  };
}

async function setPlanConditions(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const confirmation = await prepareBoundConfirmation(input, context, "plans.watch_conditions");
  const stockCode = stringInput(input?.stockCode ?? input?.code);
  if (!stockCode) throw new Error("缺少股票代码");
  if (!Array.isArray(input?.conditions)) throw new Error("conditions 必须是数组");
  const result = await setPlanWatchConditions({
    userId: context.userId,
    instanceId: context.instanceId,
    stockCode,
    stockName: stringInput(input?.stockName ?? input?.name),
    conditions: input.conditions as PlanWatchConditionInput[],
  });
  await confirmation.consume();
  await audit(context, {
    operation: "plans.watch_conditions",
    resourceType: "stock_plan",
    resourceId: stockCode,
    requestBody: input,
    resultSummary: `updated ${result.conditionCount} conditions for ${result.stockName}(${result.stockCode})`,
  });
  const publication: WorkspaceArtifactPublication = isWorkspaceBackend()
    ? await publishWorkspaceArtifacts(
      context,
      [{ relativePath: "config/portfolio.yaml", kind: "data", title: "当前持仓配置" }],
      "plans.watch_conditions",
    )
    : { artifacts: [], failures: [] };
  return { ok: true, userId: context.userId, instanceId: context.instanceId, ...result, ...artifactPublicationFields(publication) };
}

async function proposeMethodChange(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const confirmation = await prepareBoundConfirmation(input, context, "method_changes.propose");
  const proposedChange = stringInput(input?.proposedChange);
  const reason = stringInput(input?.reason);
  if (!proposedChange || !reason) throw new Error("缺少 proposedChange 或 reason");
  const created = await methodChangeBackend.propose({
    userId: context.userId,
    instanceId: context.instanceId,
    sourceReviewId: stringInput(input?.sourceReviewId),
    sourceType: stringInput(input?.sourceType) || "review",
    proposedChange,
    reason,
    affectedResource: stringInput(input?.affectedResource) || "methodology_profile",
  });
  await confirmation.consume();
  await audit(context, {
    operation: "method_changes.propose",
    resourceType: "method_change_candidate",
    resourceId: String(created.id),
    requestBody: input,
    resultSummary: "proposed method change",
  });
  const strategy = isWorkspaceBackend() ? await new WorkspaceStore(context.userId).readStrategy() : null;
  return {
    ok: true,
    userId: context.userId,
    instanceId: context.instanceId,
    candidate: created,
    strategyRevision: strategy?.last_confirmed_at ?? null,
  };
}

type StrategyPatch = {
  profile?: NonNullable<StrategyYaml["profile"]>;
  allocation?: Record<string, unknown>;
  position_roles?: Record<string, unknown>;
  buy_rules?: unknown[];
  sell_rules?: unknown[];
  rebalance_rules?: unknown[];
  risk_rules?: unknown[];
  do_not_do_rules?: string[];
  decision_boundaries?: Record<string, unknown>;
  notes?: string;
};

const STRATEGY_PATCH_KEYS = new Set([
  "profile",
  "allocation",
  "positionRoles",
  "buyRules",
  "sellRules",
  "rebalanceRules",
  "riskRules",
  "doNotDoRules",
  "decisionBoundaries",
  "notes",
]);

const STRATEGY_PROFILE_INPUT_KEYS: Record<string, string> = {
  style: "style",
  selectedStylePack: "selected_style_pack",
  customStyleEnabled: "custom_style_enabled",
  riskPreference: "risk_preference",
  investmentHorizon: "investment_horizon",
  markets: "markets",
  userMode: "user_mode",
  investorSegment: "investor_segment",
  decisionCadence: "decision_cadence",
  preferredAssets: "preferred_assets",
};

function strategyPatchRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`strategyPatch.${field} 必须是对象`);
  }
  return { ...(value as Record<string, unknown>) };
}

function strategyPatchArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`strategyPatch.${field} 必须是数组`);
  return [...value];
}

function normalizeStrategyPatch(value: unknown): StrategyPatch {
  const raw = asRecord(value);
  const unknownKeys = Object.keys(raw).filter((key) => !STRATEGY_PATCH_KEYS.has(key));
  if (unknownKeys.length > 0) throw new Error(`strategyPatch 包含不支持的字段: ${unknownKeys.join(", ")}`);
  if (Object.keys(raw).length === 0) throw new Error("strategyPatch 不能为空");

  const patch: StrategyPatch = {};
  if (raw.profile !== undefined) {
    const profile = strategyPatchRecord(raw.profile, "profile");
    const unknownProfileKeys = Object.keys(profile).filter((key) => !STRATEGY_PROFILE_INPUT_KEYS[key]);
    if (unknownProfileKeys.length > 0) {
      throw new Error(`strategyPatch.profile 包含不支持的字段: ${unknownProfileKeys.join(", ")}`);
    }
    patch.profile = Object.fromEntries(
      Object.entries(profile).map(([key, item]) => [STRATEGY_PROFILE_INPUT_KEYS[key], item]),
    ) as NonNullable<StrategyYaml["profile"]>;
  }
  if (raw.allocation !== undefined) patch.allocation = strategyPatchRecord(raw.allocation, "allocation");
  if (raw.positionRoles !== undefined) patch.position_roles = strategyPatchRecord(raw.positionRoles, "positionRoles");
  if (raw.buyRules !== undefined) patch.buy_rules = strategyPatchArray(raw.buyRules, "buyRules");
  if (raw.sellRules !== undefined) patch.sell_rules = strategyPatchArray(raw.sellRules, "sellRules");
  if (raw.rebalanceRules !== undefined) patch.rebalance_rules = strategyPatchArray(raw.rebalanceRules, "rebalanceRules");
  if (raw.riskRules !== undefined) patch.risk_rules = strategyPatchArray(raw.riskRules, "riskRules");
  if (raw.doNotDoRules !== undefined) {
    const rules = strategyPatchArray(raw.doNotDoRules, "doNotDoRules");
    if (!rules.every((item) => typeof item === "string")) throw new Error("strategyPatch.doNotDoRules 必须是字符串数组");
    patch.do_not_do_rules = rules as string[];
  }
  if (raw.decisionBoundaries !== undefined) {
    patch.decision_boundaries = strategyPatchRecord(raw.decisionBoundaries, "decisionBoundaries");
  }
  if (raw.notes !== undefined) {
    if (typeof raw.notes !== "string") throw new Error("strategyPatch.notes 必须是字符串");
    patch.notes = raw.notes;
  }
  return patch;
}

function mergeStrategyPatch(
  existing: StrategyYaml,
  patch: StrategyPatch,
  now: string,
  confirmationId: string,
  candidateId: string,
): StrategyYaml {
  const next: StrategyYaml = {
    ...existing,
    last_confirmed_at: now,
    last_confirmed_by: "user",
    last_confirmation_id: confirmationId,
    last_method_change_candidate_id: candidateId,
  };
  if (patch.profile) next.profile = { ...(existing.profile ?? {}), ...patch.profile };
  if (patch.allocation) next.allocation = { ...(existing.allocation ?? {}), ...patch.allocation };
  if (patch.position_roles) next.position_roles = { ...(existing.position_roles ?? {}), ...patch.position_roles };
  if (patch.buy_rules) next.buy_rules = patch.buy_rules;
  if (patch.sell_rules) next.sell_rules = patch.sell_rules;
  if (patch.rebalance_rules) next.rebalance_rules = patch.rebalance_rules;
  if (patch.risk_rules) next.risk_rules = patch.risk_rules;
  if (patch.do_not_do_rules) next.do_not_do_rules = patch.do_not_do_rules;
  if (patch.decision_boundaries) {
    next.decision_boundaries = { ...(existing.decision_boundaries ?? {}), ...patch.decision_boundaries };
  }
  if (patch.notes !== undefined) next.notes = patch.notes;
  return next;
}

async function planMethodChangeApplication(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  if (!isWorkspaceBackend()) throw new Error("method_changes.apply 目前只支持 Workspace 策略后端");
  const candidateId = stringInput(input?.candidateId);
  if (!candidateId) throw new Error("candidateId 是必填项");
  const candidate = await methodChangeBackend.get(context.userId, context.instanceId, candidateId);
  if (!candidate) throw new Error("方法变更候选不存在");

  const store = new WorkspaceStore(context.userId);
  const current = await store.readStrategy();
  if (!current) throw new Error("当前策略配置不存在，无法采用方法变更");
  const patch = normalizeStrategyPatch(input?.strategyPatch);
  const confirmationId = stringInput(input?.confirmationId);
  if (candidate.status === "confirmed") {
    if (
      current.last_method_change_candidate_id === candidateId
      && current.last_confirmation_id === confirmationId
    ) {
      return { candidate, current, patch, changedFields: Object.keys(patch), alreadyApplied: true };
    }
    throw new Error(`方法变更候选当前状态为 ${candidate.status}，不能重复采用`);
  }
  if (candidate.status !== "proposed") throw new Error(`方法变更候选当前状态为 ${candidate.status}，不能重复采用`);
  const expectedRevision = input?.expectedLastConfirmedAt;
  if (expectedRevision !== undefined && (expectedRevision ?? null) !== (current.last_confirmed_at ?? null)) {
    throw new Error("策略配置已发生变化，请重新读取策略并生成采用草案");
  }
  return { candidate, current, patch, changedFields: Object.keys(patch), alreadyApplied: false };
}

async function applyMethodChange(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const confirmation = await prepareBoundConfirmation(input, context, "method_changes.apply");
  const plan = await planMethodChangeApplication(input, context);
  const candidateId = plan.candidate.id;
  const now = new Date().toISOString();
  const store = new WorkspaceStore(context.userId);
  let saved = plan.current;
  let confirmedCandidate = plan.candidate;
  if (!plan.alreadyApplied) {
    const next = mergeStrategyPatch(plan.current, plan.patch, now, confirmation.confirmationId, candidateId);
    await store.writeStrategy(next);
    const savedStrategy = await store.readStrategy();
    if (
      savedStrategy?.last_confirmed_at !== now
      || savedStrategy.last_confirmation_id !== confirmation.confirmationId
      || savedStrategy.last_method_change_candidate_id !== candidateId
    ) {
      await store.writeStrategy(plan.current);
      throw new Error("策略写入后回读校验失败，已恢复原策略");
    }
    saved = savedStrategy;

    try {
      const decidedCandidate = await methodChangeBackend.decide({
        userId: context.userId,
        instanceId: context.instanceId,
        id: candidateId,
        status: "confirmed",
        decisionNote: stringInput(input?.decisionNote) || "已采用并写入 config/strategy.yaml",
      });
      if (!decidedCandidate) throw new Error("方法变更候选不存在");
      confirmedCandidate = decidedCandidate;
    } catch (error) {
      await store.writeStrategy(plan.current);
      throw error;
    }
  }

  const appliedRevision = saved.last_confirmed_at ?? now;
  await store.appendChangeLogOnce({
    ts: appliedRevision,
    source: "mcp",
    type: "method_change_applied",
    summary: stringInput(input?.summary) || "用户确认采用方法变更",
    details: {
      candidate_id: candidateId,
      operation_key: `method_changes.apply:${confirmation.confirmationId}`,
      changed_fields: plan.changedFields,
      confirmation_id: confirmation.confirmationId,
      previous_strategy_revision: plan.current.last_confirmed_at ?? null,
      strategy_revision: appliedRevision,
    },
  }, `method_changes.apply:${confirmation.confirmationId}`);
  await audit(context, {
    operation: "method_changes.apply",
    resourceType: "method_change_candidate",
    resourceId: candidateId,
    requestBody: input,
    resultSummary: `applied method change candidate fields=${plan.changedFields.join(",")}`,
  });
  const publication = await publishWorkspaceArtifacts(
    context,
    [{ relativePath: "config/strategy.yaml", kind: "data", title: "当前投资策略" }],
    "method_changes.apply",
    { required: true },
  );
  await confirmation.consume();
  return {
    ok: true,
    userId: context.userId,
    instanceId: context.instanceId,
    candidate: confirmedCandidate,
    strategy: saved,
    changedFields: plan.changedFields,
    ...artifactPublicationFields(publication),
  };
}

function userPreferenceChangeInput(input: Record<string, unknown> | undefined): UserPreferenceChangeInput {
  if (input?.reviewSchedule !== undefined && (!input.reviewSchedule || typeof input.reviewSchedule !== "object" || Array.isArray(input.reviewSchedule))) {
    throw new Error("reviewSchedule 必须是对象");
  }
  if (input?.marketWatchSchedule !== undefined && (!input.marketWatchSchedule || typeof input.marketWatchSchedule !== "object" || Array.isArray(input.marketWatchSchedule))) {
    throw new Error("marketWatchSchedule 必须是对象");
  }
  if (input?.notificationPreference !== undefined && typeof input.notificationPreference !== "string" && (!input.notificationPreference || typeof input.notificationPreference !== "object" || Array.isArray(input.notificationPreference))) {
    throw new Error("notificationPreference 必须是字符串或对象");
  }
  return {
    reviewSchedule: input?.reviewSchedule && typeof input.reviewSchedule === "object" && !Array.isArray(input.reviewSchedule)
      ? input.reviewSchedule as Record<string, unknown>
      : undefined,
    marketWatchSchedule: input?.marketWatchSchedule && typeof input.marketWatchSchedule === "object" && !Array.isArray(input.marketWatchSchedule)
      ? input.marketWatchSchedule as Record<string, unknown>
      : undefined,
    notificationPreference: typeof input?.notificationPreference === "string"
      ? input.notificationPreference
      : input?.notificationPreference && typeof input.notificationPreference === "object" && !Array.isArray(input.notificationPreference)
        ? input.notificationPreference as Record<string, unknown>
        : undefined,
    expectedLastConfirmedAt: input?.expectedLastConfirmedAt === undefined
      ? undefined
      : (input.expectedLastConfirmedAt as string | null),
    confirmationId: stringInput(input?.confirmationId),
  };
}

async function applyUserPreferences(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const confirmation = await prepareBoundConfirmation(input, context, "preferences.apply");
  const store = new WorkspaceStore(context.userId);
  const result = await applyUserPreferenceChange(store, userPreferenceChangeInput(input));
  await store.appendChangeLogOnce({
    ts: result.revision,
    source: "mcp",
    type: "user_preferences_applied",
    summary: stringInput(input?.summary) || "用户确认修改偏好配置",
    details: {
      operation_key: `preferences.apply:${confirmation.confirmationId}`,
      changed_paths: result.changedPaths,
      confirmation_id: confirmation.confirmationId,
      previous_revision: result.currentRevision,
      revision: result.revision,
    },
  }, `preferences.apply:${confirmation.confirmationId}`);
  await audit(context, {
    operation: "preferences.apply",
    resourceType: "user_preferences",
    resourceId: context.instanceId,
    requestBody: input,
    resultSummary: `updated ${result.changedPaths.join(",")}`,
  });
  const publication = await publishWorkspaceArtifacts(
    context,
    result.changedPaths.map((relativePath) => ({
      relativePath,
      kind: "data" as const,
      title: relativePath.endsWith("notification.yaml") ? "通知偏好配置" : "任务与盯盘计划",
    })),
    "preferences.apply",
    { required: true },
  );
  await confirmation.consume();
  return {
    ok: true,
    userId: context.userId,
    instanceId: context.instanceId,
    revision: result.revision,
    changedPaths: result.changedPaths,
    schedules: result.schedules,
    notification: result.notification,
    ...artifactPublicationFields(publication),
  };
}

async function saveReview(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  // F2: scheduledCompletion 扩展为 daily/weekly/monthly 三前缀
  const convId = context.conversationId ?? "";
  const scheduledCompletion =
    convId.startsWith("scheduler:daily-review:") ||
    convId.startsWith("scheduler:weekly-review:") ||
    convId.startsWith("scheduler:monthly-review:");
  if (!scheduledCompletion) requireConfirmed(input);
  const content = stringInput(input?.content);
  if (!content) throw new Error("缺少复盘内容");
  const pushBrief = stringInput(input?.pushBrief) || stringInput(input?.summary);
  if (scheduledCompletion && !pushBrief) throw new Error("scheduled review requires pushBrief");
  const decisionRecords = normalizeRecordList(input?.decisionRecords, "decisionRecords");
  const sourceEvents = normalizeRecordList(input?.sourceEvents, "sourceEvents");
  const kind = (stringInput(input?.kind) || "daily") as "daily" | "weekly" | "monthly";
  if (!(["daily", "weekly", "monthly"] as const).includes(kind)) {
    throw new Error(`reviews.save unsupported kind: ${kind}`);
  }
  const requestedKey = kind === "daily"
    ? (stringInput(input?.date) || localDateString())
    : (stringInput(input?.reportKey) || "");
  if (scheduledCompletion) {
    assertScheduledReviewTarget(context, kind, requestedKey);
  }
  const publicationMeta = {
    ...asRecord(input?.context),
    publication: { conversationId: context.conversationId ?? null, scheduled: scheduledCompletion },
  };

  // F2: 按 kind 分派。daily 走 saveSkillDailyReview（不变）；weekly/monthly 走 saveSkillPeriodicReview
  let saved: { date?: string; kind?: string; reportKey?: string; filePath: string };
  if (kind === "weekly" || kind === "monthly") {
    const reportKey = stringInput(input?.reportKey);
    if (!reportKey) throw new Error(`reviews.save requires reportKey for kind=${kind}`);
    const result = await saveSkillPeriodicReview({
      userId: context.userId,
      instanceId: context.instanceId,
      kind,
      reportKey,
      content,
      summary: pushBrief,
      context: publicationMeta,
    });
    saved = { kind: result.kind, reportKey: result.reportKey, filePath: result.filePath };
  } else {
    const result = await saveSkillDailyReview({
      userId: context.userId,
      instanceId: context.instanceId,
      date: stringInput(input?.date),
      content,
      summary: pushBrief,
      context: publicationMeta,
    });
    saved = { date: result.date, filePath: result.filePath };
  }

  const resourceId = saved.date ?? saved.reportKey ?? "unknown";
  const resourceType = kind === "daily" ? "daily_review" : `${kind}_review`;
  const store = new WorkspaceStore(context.userId);
  const publishedAt = new Date().toISOString();
  for (const [index, record] of decisionRecords.entries()) {
    await store.appendDecision({
      ...record,
      source_review_date: resourceId,
      source_review_conversation_id: context.conversationId ?? null,
      recorded_at: record.recorded_at ?? publishedAt,
      record_index: index,
    });
  }
  for (const [index, record] of sourceEvents.entries()) {
    await store.appendSourceEvent({
      ...record,
      source_review_date: resourceId,
      source_review_conversation_id: context.conversationId ?? null,
      recorded_at: record.recorded_at ?? publishedAt,
      record_index: index,
    });
  }
  await audit(context, {
    operation: "reviews.save",
    resourceType,
    resourceId,
    requestBody: {
      kind,
      date: input?.date,
      reportKey: input?.reportKey,
      hasContent: true,
      hasPushBrief: Boolean(pushBrief),
      hasContext: Boolean(input?.context),
      decisionRecordCount: decisionRecords.length,
      sourceEventCount: sourceEvents.length,
      scheduledCompletion,
    },
    resultSummary: `saved ${kind} review ${resourceId}; decisions=${decisionRecords.length}; sourceEvents=${sourceEvents.length}`,
  });
  let artifact: ConversationArtifact | undefined;
  try {
    const reportPath = kind === "daily"
      ? `reports/daily/${saved.date}.md`
      : `reports/${kind}/${saved.reportKey}.md`;
    const published = await publishConversationArtifact({
      userId: context.userId,
      instanceId: context.instanceId,
      relativePath: reportPath,
      kind: "report",
      title: kind === "daily" ? `每日复盘 ${saved.date}` : `${kind === "weekly" ? "周" : "月"}复盘 ${saved.reportKey}`,
      scope: {
        projectId: context.projectId || DEFAULT_PROJECT_ID,
        assistantId: context.instanceId,
        conversationId: context.conversationId ?? null,
        source: "reviews.save",
      },
    });
    artifact = published;
  } catch (error) {
    await audit(context, {
      operation: "reviews.save",
      resourceType,
      resourceId,
      requestBody: { artifactPublish: "failed" },
      resultSummary: `artifact publish skipped: ${(error as Error).message}`,
      status: "error",
    }).catch(() => undefined);
  }
  return {
    ok: true,
    userId: context.userId,
    instanceId: context.instanceId,
    ...saved,
    pushBrief,
    decisionRecordCount: decisionRecords.length,
    sourceEventCount: sourceEvents.length,
    artifact,
  };
}

async function publishArtifact(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const relativePath = stringInput(input?.relativePath);
  if (!relativePath) throw new Error("relativePath is required");
  const title = stringInput(input?.title) || undefined;
  const kindRaw = stringInput(input?.kind);
  const kind = isArtifactKind(kindRaw) ? kindRaw : undefined;
  const published = await publishConversationArtifact({
    userId: context.userId,
    instanceId: context.instanceId,
    relativePath,
    kind,
    title,
    scope: {
      projectId: context.projectId || DEFAULT_PROJECT_ID,
      assistantId: context.instanceId,
      conversationId: context.conversationId ?? null,
      source: "artifacts.publish",
    },
  });
  await audit(context, {
    operation: "artifacts.publish",
    resourceType: "conversation_artifact",
    resourceId: published.artifactId,
    requestBody: { relativePath, kind, title },
    resultSummary: `published ${published.kind}/${published.previewMode} ${published.fileName}`,
  });
  return {
    ok: true,
    userId: context.userId,
    instanceId: context.instanceId,
    artifact: published,
  };
}

function isArtifactKind(value: string | undefined): value is ConversationArtifact["kind"] {
  return value === "report" || value === "chart" || value === "data" || value === "document";
}

type PortfolioHoldingChange = {
  code: string;
  name: string;
  weight?: number | null;
  cost?: number | null;
  shares?: number | null;
  notes?: string;
};

type PortfolioWatchlistAction = {
  code: string;
  action: "keep" | "remove";
};

type PlannedPortfolioChanges = {
  expectedLastConfirmedAt: string | null;
  current: PortfolioYaml;
  next: PortfolioYaml;
  removedHoldings: PortfolioHolding[];
  upsertedHoldings: PortfolioHolding[];
  removedWatchlist: PortfolioWatchItem[];
  keptWatchlistCodes: string[];
  allocation: {
    complete: boolean;
    holdingWeightPercent: number | null;
    cashRatioPercent: number | null;
    totalPercent: number | null;
  };
};

async function planPortfolioChanges(
  input: Record<string, unknown>,
  context: ServiceToolContext
): Promise<PlannedPortfolioChanges> {
  if (!Object.prototype.hasOwnProperty.call(input, "expectedLastConfirmedAt")) {
    throw new Error("expectedLastConfirmedAt is required; read the current portfolio before drafting changes");
  }
  const expectedLastConfirmedAt = input.expectedLastConfirmedAt === null
    ? null
    : stringInput(input.expectedLastConfirmedAt);
  if (input.expectedLastConfirmedAt !== null && !expectedLastConfirmedAt) {
    throw new Error("expectedLastConfirmedAt must be an ISO timestamp or null");
  }
  if (expectedLastConfirmedAt && Number.isNaN(Date.parse(expectedLastConfirmedAt))) {
    throw new Error("expectedLastConfirmedAt must be an ISO timestamp or null");
  }

  const store = new WorkspaceStore(context.userId);
  const current = (await store.readPortfolio()) ?? { holdings: [], watchlist: [], accounts: [] };
  const currentRevision = current.last_confirmed_at ?? null;
  if (currentRevision !== expectedLastConfirmedAt) {
    throw new Error(`portfolio state changed; expected revision ${expectedLastConfirmedAt ?? "null"}, current revision ${currentRevision ?? "null"}`);
  }

  const removeHoldingCodes = [...new Set(normalizeCodes(input.removeHoldingCodes))];
  if (removeHoldingCodes.some((code) => !/^\d{6}$/.test(code))) {
    throw new Error("removeHoldingCodes must contain six-digit stock codes");
  }
  const upsertHoldings = normalizeRecordList(input.upsertHoldings, "upsertHoldings")
    .map(normalizePortfolioHoldingChange);
  const watchlistActions = normalizeRecordList(input.watchlistActions, "watchlistActions")
    .map(normalizePortfolioWatchlistAction);
  const hasCashRatio = Object.prototype.hasOwnProperty.call(input, "cashRatioPercent");
  const cashRatioPercent = hasCashRatio ? finiteNumber(input.cashRatioPercent, "cashRatioPercent", 0, 100) : undefined;

  if (!removeHoldingCodes.length && !upsertHoldings.length && !watchlistActions.length && !hasCashRatio) {
    throw new Error("portfolio change set is empty");
  }
  const upsertCodes = new Set(upsertHoldings.map((item) => item.code));
  const duplicateUpserts = upsertHoldings.filter((item, index) => upsertHoldings.findIndex((other) => other.code === item.code) !== index);
  if (duplicateUpserts.length) throw new Error(`upsertHoldings contains duplicate codes: ${[...new Set(duplicateUpserts.map((item) => item.code))].join(",")}`);
  const contradictoryCodes = removeHoldingCodes.filter((code) => upsertCodes.has(code));
  if (contradictoryCodes.length) throw new Error(`cannot remove and upsert the same holding: ${contradictoryCodes.join(",")}`);

  const holdings = [...(current.holdings ?? [])];
  const removedHoldings: PortfolioHolding[] = [];
  for (const code of removeHoldingCodes) {
    const index = holdings.findIndex((holding) => holding.code === code && holding.status !== "closed" && !holding.sell_date);
    if (index < 0) throw new Error(`active holding not found: ${code}`);
    removedHoldings.push(...holdings.splice(index, 1));
  }

  const upsertedHoldings: PortfolioHolding[] = [];
  for (const change of upsertHoldings) {
    const index = holdings.findIndex((holding) => holding.code === change.code);
    const existing = index >= 0 ? holdings[index] : undefined;
    const next: PortfolioHolding = {
      ...existing,
      code: change.code,
      name: change.name,
      status: "open",
      sell_date: null,
      sell_price: null,
      ...(Object.prototype.hasOwnProperty.call(change, "weight") ? { weight: change.weight } : {}),
      ...(Object.prototype.hasOwnProperty.call(change, "cost") ? { cost: change.cost } : {}),
      ...(Object.prototype.hasOwnProperty.call(change, "shares") ? { shares: change.shares } : {}),
      ...(change.notes !== undefined ? { notes: change.notes } : {}),
    };
    if (index >= 0) holdings[index] = next;
    else holdings.push(next);
    upsertedHoldings.push(next);
  }

  const watchlist = [...(current.watchlist ?? [])];
  const actionByCode = new Map<string, "keep" | "remove">();
  for (const action of watchlistActions) {
    if (actionByCode.has(action.code)) throw new Error(`watchlistActions contains duplicate code: ${action.code}`);
    actionByCode.set(action.code, action.action);
  }
  for (const holding of upsertHoldings) {
    if (watchlist.some((item) => item.code === holding.code) && !actionByCode.has(holding.code)) {
      throw new Error(`watchlist action is required when a watched stock becomes a holding: ${holding.code}`);
    }
  }
  const removedWatchlist: PortfolioWatchItem[] = [];
  const keptWatchlistCodes: string[] = [];
  for (const [code, action] of actionByCode) {
    const index = watchlist.findIndex((item) => item.code === code);
    if (index < 0) throw new Error(`watchlist item not found: ${code}`);
    if (action === "remove") removedWatchlist.push(...watchlist.splice(index, 1));
    else keptWatchlistCodes.push(code);
  }

  const currentCash = isRecord(current.cash) ? current.cash : {};
  const nextCash = hasCashRatio ? updatePortfolioCashRatio(currentCash, cashRatioPercent!) : current.cash;
  const next: PortfolioYaml = {
    ...current,
    cash: nextCash,
    holdings,
    watchlist,
    accounts: Array.isArray(current.accounts) ? current.accounts : [],
  };
  const weights = holdings.map((holding) => holding.weight);
  const knownWeights = weights.filter((weight): weight is number => typeof weight === "number" && Number.isFinite(weight));
  const allHoldingWeightsKnown = knownWeights.length === weights.length;
  const finalCashRatio: number | null = hasCashRatio ? (cashRatioPercent ?? null) : portfolioCashRatio(current.cash);
  const holdingWeightPercent = allHoldingWeightsKnown
    ? knownWeights.reduce((sum, weight) => sum + weight, 0)
    : null;
  const complete = allHoldingWeightsKnown && finalCashRatio !== null;
  const totalPercent = complete ? holdingWeightPercent! + finalCashRatio! : null;
  if (complete && Math.abs(totalPercent! - 100) > 0.01) {
    throw new Error(`portfolio allocation must total 100%; holdings=${holdingWeightPercent}, cash=${finalCashRatio}, total=${totalPercent}. Provide an explicit cashRatioPercent or correct holding weights`);
  }

  return {
    expectedLastConfirmedAt,
    current,
    next,
    removedHoldings,
    upsertedHoldings,
    removedWatchlist,
    keptWatchlistCodes,
    allocation: {
      complete,
      holdingWeightPercent,
      cashRatioPercent: finalCashRatio,
      totalPercent,
    },
  };
}

async function applyPortfolioChanges(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const confirmation = await prepareBoundConfirmation(input, context, "portfolio.apply_changes");
  const store = new WorkspaceStore(context.userId);
  const existing = await store.readPortfolio();
  const confirmationId = stringInput(input?.confirmationId)!;
  if (existing?.last_confirmation_id === confirmationId) {
    await confirmation.consume();
    return portfolioChangeResult(context, existing, [], [], [], []);
  }

  const plan = await planPortfolioChanges(input ?? {}, context);
  const now = new Date().toISOString();
  const saved: PortfolioYaml = {
    ...plan.next,
    last_confirmed_at: now,
    last_confirmed_by: "user",
    last_confirmation_id: confirmationId,
  };
  await store.writePortfolio(saved);
  await store.appendChangeLog({
    ts: now,
    source: "mcp",
    type: "portfolio_changed",
    summary: stringInput(input?.summary) || "用户确认更新持仓组合",
    details: {
      confirmation_id: confirmationId,
      removed_holding_codes: plan.removedHoldings.map((item) => item.code),
      upserted_holding_codes: plan.upsertedHoldings.map((item) => item.code),
      removed_watchlist_codes: plan.removedWatchlist.map((item) => item.code),
      kept_watchlist_codes: plan.keptWatchlistCodes,
      cash_ratio_percent: plan.allocation.cashRatioPercent,
    },
  });
  await confirmation.consume();
  await audit(context, {
    operation: "portfolio.apply_changes",
    resourceType: "portfolio",
    resourceId: context.instanceId,
    requestBody: input,
    resultSummary: `removedHoldings=${plan.removedHoldings.length}; upsertedHoldings=${plan.upsertedHoldings.length}; removedWatchlist=${plan.removedWatchlist.length}; totalPercent=${plan.allocation.totalPercent ?? "unknown"}`,
  });
  const artifact = await publishPortfolioFileArtifact(context);
  return portfolioChangeResult(
    context,
    saved,
    plan.removedHoldings,
    plan.upsertedHoldings,
    plan.removedWatchlist,
    plan.keptWatchlistCodes,
    artifact,
  );
}

interface WorkspaceArtifactSpec {
  relativePath: string;
  title: string;
  kind: ConversationArtifact["kind"];
}

interface WorkspaceArtifactPublication {
  artifacts: ConversationArtifact[];
  failures: Array<{ relativePath: string; message: string }>;
}

async function publishWorkspaceArtifacts(
  context: ServiceToolContext,
  specs: WorkspaceArtifactSpec[],
  sourceOperation: string,
  options: { required?: boolean } = {},
): Promise<WorkspaceArtifactPublication> {
  const artifacts: ConversationArtifact[] = [];
  const failures: Array<{ relativePath: string; message: string }> = [];
  const seenPaths = new Set<string>();
  for (const spec of specs) {
    if (seenPaths.has(spec.relativePath)) continue;
    seenPaths.add(spec.relativePath);
    try {
      const injectedError = serviceToolFailureInjection.artifactPublish?.(spec.relativePath);
      if (injectedError) throw injectedError;
      const published = await publishConversationArtifact({
        userId: context.userId,
        instanceId: context.instanceId,
        relativePath: spec.relativePath,
        kind: spec.kind,
        title: spec.title,
        scope: {
          projectId: context.projectId || DEFAULT_PROJECT_ID,
          assistantId: context.instanceId,
          conversationId: context.conversationId ?? null,
          source: "artifacts.publish",
        },
      });
      artifacts.push(published);
      await audit(context, {
        operation: "artifacts.publish",
        resourceType: "conversation_artifact",
        resourceId: published.artifactId,
        requestBody: { relativePath: spec.relativePath, automatic: true, sourceOperation },
        resultSummary: `published automatic workspace artifact ${published.fileName}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ relativePath: spec.relativePath, message });
      await audit(context, {
        operation: "artifacts.publish",
        resourceType: "conversation_artifact",
        resourceId: spec.relativePath,
        requestBody: { relativePath: spec.relativePath, automatic: true, sourceOperation },
        resultSummary: `automatic workspace artifact skipped: ${message}`,
        status: "error",
      }).catch(() => undefined);
    }
  }
  if (options.required && failures.length > 0) {
    throw new Error(`必须发布的工作空间文件未能全部发布: ${failures.map((failure) => `${failure.relativePath}: ${failure.message}`).join("; ")}`);
  }
  return { artifacts, failures };
}

function artifactPublicationFields(publication: WorkspaceArtifactPublication) {
  return {
    ...(publication.artifacts.length > 0 ? { artifacts: publication.artifacts } : {}),
    ...(publication.failures.length > 0 ? { artifactPublishFailures: publication.failures } : {}),
  };
}

async function publishPortfolioFileArtifact(context: ServiceToolContext): Promise<ConversationArtifact | undefined> {
  const publication = await publishWorkspaceArtifacts(
    context,
    [{ relativePath: "config/portfolio.yaml", kind: "data", title: "当前持仓配置" }],
    "portfolio.apply_changes",
  );
  return publication.artifacts[0];
}

function onboardingArtifactSpecs(step: string): WorkspaceArtifactSpec[] {
  const specs: WorkspaceArtifactSpec[] = [
    { relativePath: "config/onboarding_state.yaml", kind: "data", title: "初始配置状态" },
  ];
  if (step === "portfolio") specs.push({ relativePath: "config/portfolio.yaml", kind: "data", title: "当前持仓配置" });
  if (step === "style") specs.push({ relativePath: "config/strategy.yaml", kind: "data", title: "投资策略配置" });
  if (step === "review_schedule" || step === "market_watch_schedule") {
    specs.push({ relativePath: "config/schedules.yaml", kind: "data", title: "任务与盯盘计划" });
  }
  if (step === "notification") specs.push({ relativePath: "config/notification.yaml", kind: "data", title: "通知偏好配置" });
  if (step === "watch_rules") specs.push({ relativePath: "config/watch.yaml", kind: "data", title: "盯盘边界配置" });
  return specs;
}

function portfolioChangeResult(
  context: ServiceToolContext,
  portfolio: PortfolioYaml,
  removedHoldings: PortfolioHolding[],
  upsertedHoldings: PortfolioHolding[],
  removedWatchlist: PortfolioWatchItem[],
  keptWatchlistCodes: string[],
  artifact?: ConversationArtifact,
) {
  return {
    ok: true,
    userId: context.userId,
    instanceId: context.instanceId,
    revision: portfolio.last_confirmed_at ?? null,
    holdings: portfolio.holdings ?? [],
    watchlist: portfolio.watchlist ?? [],
    cash: portfolio.cash ?? null,
    ...(artifact ? { artifact } : {}),
    applied: {
      removedHoldingCodes: removedHoldings.map((item) => item.code),
      upsertedHoldingCodes: upsertedHoldings.map((item) => item.code),
      removedWatchlistCodes: removedWatchlist.map((item) => item.code),
      keptWatchlistCodes,
    },
  };
}

function normalizePortfolioHoldingChange(input: Record<string, unknown>): PortfolioHoldingChange {
  const code = stringInput(input.code);
  const name = stringInput(input.name);
  if (!code || !/^\d{6}$/.test(code)) throw new Error("upsertHoldings[].code must be a six-digit stock code");
  if (!name) throw new Error(`upsertHoldings name is required for ${code}`);
  const result: PortfolioHoldingChange = { code, name };
  if (Object.prototype.hasOwnProperty.call(input, "weight")) result.weight = nullableFiniteNumber(input.weight, `weight for ${code}`, 0, 100);
  if (Object.prototype.hasOwnProperty.call(input, "cost")) result.cost = nullableFiniteNumber(input.cost, `cost for ${code}`, 0);
  if (Object.prototype.hasOwnProperty.call(input, "shares")) result.shares = nullableFiniteNumber(input.shares, `shares for ${code}`, 0);
  if (Object.prototype.hasOwnProperty.call(input, "notes")) result.notes = stringInput(input.notes) ?? "";
  return result;
}

function normalizePortfolioWatchlistAction(input: Record<string, unknown>): PortfolioWatchlistAction {
  const code = stringInput(input.code);
  if (!code || !/^\d{6}$/.test(code)) throw new Error("watchlistActions[].code must be a six-digit stock code");
  if (input.action !== "keep" && input.action !== "remove") throw new Error(`watchlist action must be keep or remove for ${code}`);
  return { code, action: input.action };
}

function finiteNumber(value: unknown, field: string, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  if (value === null || value === undefined || value === "") {
    throw new Error(`${field} must be a number between ${min} and ${max}`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}`);
  }
  return number;
}

function nullableFiniteNumber(value: unknown, field: string, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  return value === null ? null : finiteNumber(value, field, min, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function portfolioCashRatio(cash: unknown): number | null {
  if (!isRecord(cash)) return null;
  const ratio = Number(cash.ratio_percent);
  return Number.isFinite(ratio) ? ratio : null;
}

function updatePortfolioCashRatio(cash: Record<string, unknown>, ratioPercent: number) {
  const notes = typeof cash.notes === "string" ? cash.notes : undefined;
  const synchronizedNotes = notes && /现金.*?\d+(?:\.\d+)?\s*%/.test(notes)
    ? notes.replace(/(现金.*?)(\d+(?:\.\d+)?)(\s*%)/, `$1${ratioPercent}$3`)
    : notes;
  return {
    ...cash,
    ratio_percent: ratioPercent,
    ...(synchronizedNotes !== undefined ? { notes: synchronizedNotes } : {}),
  };
}

function normalizeCodes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizePositiveIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function normalizeRecordList(value: unknown, field: string): Record<string, unknown>[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${field}[${index}] must be an object`);
    }
    return item as Record<string, unknown>;
  });
}

function isExplicitWatchSetupSkipText(value: string) {
  const normalized = value.replace(/[\s，。！!？?]/g, "");
  return /^(暂不设置(明确)?规则|先不设置(明确)?规则|不设置(明确)?规则|暂时不设置(明确)?规则|跳过(规则设置)?|先跳过|以后再设置|先不用)$/.test(normalized);
}

const CONFIRMED_WRITE_OPERATIONS = new Set([
  "portfolio.apply_changes",
  "onboarding.confirm_portfolio",
  "onboarding.confirm_step",
  "watchlist.add",
  "plans.set",
  "plans.watch_conditions",
  "method_changes.propose",
  "method_changes.apply",
  "preferences.apply",
  "watch_rules.create",
]);

async function requestConfirmation(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const operation = stringInput(input?.operation);
  const payload = asRecord(input?.payload);
  if (!operation || !CONFIRMED_WRITE_OPERATIONS.has(operation)) throw new Error("operation is not confirmable");
  if (!context.conversationId) throw new Error("conversationId is required for confirmation");
  const preview = await validateConfirmationDraft(operation, payload, context);
  const target = confirmationTarget(operation, payload, context);
  const pending = await createSandboxConfirmation(mcpSandboxContext(context, `mcp-request:${Date.now()}`), target);
  await audit(context, {
    operation: "confirmations.request",
    resourceType: target.resourceType,
    resourceId: target.resourceId,
    requestBody: { operation, payload, summary: stringInput(input?.summary) },
    resultSummary: `confirmation requested for ${operation}`,
  });
  return {
    ok: true,
    userId: context.userId,
    instanceId: context.instanceId,
    confirmationId: pending.id,
    operation,
    expiresAt: pending.expiresAt,
    ...(preview ? { preview } : {}),
  };
}

async function validateConfirmationDraft(
  operation: string,
  payload: Record<string, unknown>,
  context: ServiceToolContext
) {
  if (operation === "onboarding.confirm_step") {
    const step = stringInput(payload.step);
    if (!isSharedOnboardingStep(step)) throw new Error(`非法 onboarding step: ${String(step ?? "")}`);
    validateOnboardingStepPayload(step, payload);
  }
  if (operation === "onboarding.confirm_portfolio") {
    const holdings = normalizeOnboardingAssetList(payload.holdings);
    const watchlist = normalizeOnboardingAssetList(payload.watchlist);
    if (!holdings.length && !watchlist.length) throw new Error("至少需要一个持仓或观察仓标的");
    const missingCodes = [
      ...findOnboardingAssetsMissingCode("holding", holdings),
      ...findOnboardingAssetsMissingCode("watchlist", watchlist),
    ];
    if (missingCodes.length > 0) {
      throw new Error(`持仓和观察仓写入前必须补齐 6 位证券代码: ${JSON.stringify(missingCodes)}`);
    }
  }
  if (operation === "portfolio.apply_changes") {
    return planPortfolioChanges(payload, context);
  }
  if (operation === "method_changes.apply") {
    const plan = await planMethodChangeApplication(payload, context);
    return {
      candidateId: plan.candidate.id,
      candidateStatus: plan.candidate.status,
      changedFields: plan.changedFields,
      currentStrategyRevision: plan.current.last_confirmed_at ?? null,
    };
  }
  if (operation === "preferences.apply") {
    const plan = await planUserPreferenceChange(new WorkspaceStore(context.userId), userPreferenceChangeInput(payload));
    return {
      changedPaths: plan.changedPaths,
      currentRevision: plan.currentRevision,
      nextRevision: plan.schedules.last_confirmed_at ?? plan.notification.last_confirmed_at ?? null,
    };
  }
  return undefined;
}

async function prepareBoundConfirmation(
  input: Record<string, unknown> | undefined,
  context: ServiceToolContext,
  operation: string
) {
  requireConfirmed(input);
  const confirmationId = stringInput(input?.confirmationId);
  if (!confirmationId) throw new Error("confirmationId is required after requesting confirmation");
  if (!context.conversationId) throw new Error("conversationId is required for confirmed writes");
  await requireRecentUserConfirmation(context, operation, confirmationId);
  const payload = stripConfirmationFields(input);
  const sandboxContext = mcpSandboxContext(context, `mcp-confirm:${Date.now()}`);
  const target = confirmationTarget(operation, payload, context);
  const result = await validateSandboxConfirmation(
    sandboxContext,
    confirmationId,
    target
  );
  if (!result.ok) throw new Error(`confirmation invalid: ${result.reason}`);
  return {
    confirmationId,
    consume: async () => {
      const consumed = await consumeSandboxConfirmation(sandboxContext, confirmationId, target);
      if (!consumed.ok) throw new Error(`confirmation invalid: ${consumed.reason}`);
    },
  };
}

function confirmationTarget(operation: string, payload: Record<string, unknown>, context: ServiceToolContext) {
  const resourceByOperation: Record<string, string> = {
    "portfolio.apply_changes": "portfolio",
    "onboarding.confirm_portfolio": "onboarding_portfolio",
    "onboarding.confirm_step": "onboarding_step",
    "watchlist.add": "watchlist",
    "plans.set": "stock_plan",
    "plans.watch_conditions": "stock_plan",
    "method_changes.propose": "method_change_candidate",
    "method_changes.apply": "method_change_candidate",
    "preferences.apply": "user_preferences",
    "watch_rules.create": "watch_rule",
  };
  const resourceType = resourceByOperation[operation];
  if (!resourceType) throw new Error("operation is not confirmable");
  const resourceId = operation === "portfolio.apply_changes"
    ? context.instanceId
    : operation === "onboarding.confirm_portfolio"
    ? context.instanceId
    : operation === "onboarding.confirm_step"
      ? stringInput(payload.step)
      : operation.startsWith("plans.")
        ? stringInput(payload.stockCode ?? payload.code)
        : operation === "method_changes.apply"
      ? stringInput(payload.candidateId)
        : operation === "preferences.apply"
          ? context.instanceId
        : undefined;
  const requestBody = operation === "method_changes.apply"
    ? stripMethodChangeConfirmationMetadata(payload)
    : operation === "preferences.apply"
      ? stripPreferencesConfirmationMetadata(payload)
    : operation === "portfolio.apply_changes"
      ? stripPortfolioConfirmationMetadata(payload)
      : payload;
  return {
    operation,
    resourceType,
    resourceId,
    requestBody,
  };
}

function stripPortfolioConfirmationMetadata(payload: Record<string, unknown>) {
  const { summary: _summary, ...boundPayload } = payload;
  return boundPayload;
}

function stripMethodChangeConfirmationMetadata(payload: Record<string, unknown>) {
  const { summary: _summary, decisionNote: _decisionNote, ...boundPayload } = payload;
  return boundPayload;
}

function stripPreferencesConfirmationMetadata(payload: Record<string, unknown>) {
  const { summary: _summary, ...boundPayload } = payload;
  return boundPayload;
}

function mcpSandboxContext(context: ServiceToolContext, tokenId: string): SandboxContext {
  return {
    userId: context.userId,
    projectId: context.projectId || DEFAULT_PROJECT_ID,
    instanceId: context.instanceId,
    role: "user",
    channel: "api",
    backend: "codex",
    conversationId: context.conversationId,
    permissions: ["read:self", "write:self", "review:self", "alert:self"],
    tokenId,
  };
}

function stripConfirmationFields(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const { confirmationId: _confirmationId, confirmedByUser: _confirmedByUser, ...payload } = input ?? {};
  return payload;
}

function requireConfirmed(input: Record<string, unknown> | undefined) {
  if (input?.confirmedByUser !== true) {
    throw new Error("confirmedByUser=true is required after explicit user confirmation");
  }
}

async function requireRecentUserConfirmation(context: ServiceToolContext, operation: string, confirmationId: string) {
  const [confirmation] = await db.select({ createdAt: pendingSandboxConfirmations.createdAt })
    .from(pendingSandboxConfirmations)
    .where(and(
      eq(pendingSandboxConfirmations.id, confirmationId),
      eq(pendingSandboxConfirmations.userId, context.userId),
      eq(pendingSandboxConfirmations.instanceId, context.instanceId),
      eq(pendingSandboxConfirmations.status, "pending")
    ))
    .limit(1);
  if (!confirmation) throw new Error(`pending confirmation is unavailable for ${operation}`);
  const conditions = [
    eq(conversationMessages.userId, context.userId),
    eq(conversationMessages.instanceId, context.instanceId),
    eq(conversationMessages.role, "user"),
  ];
  if (context.conversationId) {
    conditions.push(eq(conversationMessages.conversationId, context.conversationId));
  }
  const [latest] = await db.select({
    content: conversationMessages.content,
    createdAt: conversationMessages.createdAt,
  })
    .from(conversationMessages)
    .where(and(...conditions))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(1);
  const text = latest?.content?.trim() || "";
  if (!text) throw new Error(`recent user confirmation is unavailable for ${operation}`);
  if (new Date(latest.createdAt).getTime() <= new Date(confirmation.createdAt).getTime()) {
    throw new Error(`recent user confirmation predates the draft for ${operation}`);
  }
  if (isExplicitConfirmationText(text)) return;
  throw new Error(`recent user message is not an explicit confirmation for ${operation}`);
}

function isExplicitConfirmationText(text: string) {
  const normalized = text.replace(/\s+/g, "");
  if (!normalized) return false;
  if (/^(确认|确认保存|确认写入|确认默认复盘时间|确认盘中简报时间|确认盘中简报设置|确认默认盯盘时间|确认通知偏好|确认默认提醒边界|确认提醒边界|可以|可以的|就这样|就这个|保存|同意|没问题|ok|OK|Ok|好|好的)$/.test(normalized)) return true;
  return /确认/.test(normalized) && normalized.length <= 20;
}

async function audit(context: ServiceToolContext, input: {
  operation: string;
  resourceType: string;
  resourceId?: string;
  requestBody?: unknown;
  resultSummary?: string;
  status?: "success" | "denied" | "error";
}) {
  await recordSandboxAudit({
    context: {
      userId: context.userId,
      projectId: context.projectId || DEFAULT_PROJECT_ID,
      instanceId: context.instanceId,
      role: "user",
      channel: "api",
      backend: "codex",
      conversationId: context.conversationId,
      permissions: ["read:self", "write:self", "review:self", "alert:self"],
      tokenId: "mcp-service-tools",
    },
    operation: input.operation,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    requestBody: input.requestBody,
    resultSummary: input.resultSummary,
    status: input.status ?? "success",
  });
}

function stringInput(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function redactUrlForAudit(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|signature|sig|auth|credential/i.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

function normalizeStockInputs(value: unknown): Array<{ code: string; name?: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const raw = item as Record<string, unknown>;
      const code = stringInput(raw.code);
      const name = stringInput(raw.name);
      return code ? { code, ...(name ? { name } : {}) } : null;
    })
    .filter((item): item is { code: string; name?: string } => item !== null);
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numberValue)) return fallback;
  return Math.min(Math.max(numberValue, min), max);
}

function compactToolText(value: string, limit = 1200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function safeJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function numberOrExisting(value: unknown, existing: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : existing ?? null;
}

function requirePositiveInteger(value: unknown, label: string) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) throw new Error(`${label} must be a positive integer`);
  return numberValue;
}

function normalizeWatchlistReason(reason: string) {
  return reason.replace(/观察池/g, "自选池").trim();
}

function normalizeOnboardingAssetList(value: unknown): Array<{ name: string; code: string; notes?: string }> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: Array<{ name: string; code: string; notes?: string }> = [];
  for (const raw of value) {
    const item = typeof raw === "string" ? { name: raw } : asRecord(raw);
    const name = stringInput(item.name ?? item.stockName ?? item.stock_name ?? item.label ?? item.title) || "";
    const code = stringInput(item.code ?? item.stockCode ?? item.stock_code ?? item.symbol) || "";
    if (!name && !code) continue;
    const key = `${code}::${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const notes = stringInput(item.notes);
    result.push({ name: name || code || "未命名标的", code, notes });
  }
  return result;
}

function findOnboardingAssetsMissingCode(kind: "holding" | "watchlist", items: Array<{ name: string; code: string }>) {
  return items
    .filter((item) => !/^\d{6}$/.test(item.code))
    .map((item) => ({
      kind,
      name: item.name,
      code: item.code || null,
      reason: item.code ? "证券代码必须是 6 位数字" : "缺少证券代码",
    }));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

const ONBOARDING_STEPS = [
  "welcome",
  "portfolio",
  "style",
  "review_schedule",
  "market_watch_schedule",
  "notification",
  "watch_rules",
] as const;

type OnboardingStepKey = typeof ONBOARDING_STEPS[number];

function isOnboardingStep(value: unknown): value is OnboardingStepKey {
  return typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

function nextOnboardingStep(step: OnboardingStepKey): OnboardingStepKey | "completed" {
  const idx = ONBOARDING_STEPS.indexOf(step);
  return idx >= 0 && idx < ONBOARDING_STEPS.length - 1 ? ONBOARDING_STEPS[idx + 1] : "completed";
}

function normalizeOnboardingState(state: OnboardingStateYaml | null | undefined): OnboardingStateYaml {
  return {
    version: state?.version ?? 1,
    status: state?.status ?? "not_started",
    current_step: state?.current_step ?? "welcome",
    steps: state?.steps ?? {},
    completed_at: state?.completed_at ?? null,
    updated_at: state?.updated_at ?? null,
    notes: state?.notes ?? "",
  };
}

async function applyOnboardingStepDefaults(
  store: WorkspaceStore,
  step: OnboardingStepKey,
  now: string,
  body: Record<string, unknown>
) {
  if (step === "style") {
    const profile = asRecord(body.styleProfile ?? body.style_profile);
    const style = stringInput(profile.style ?? body.style);
    const notes = stringInput(profile.notes ?? body.notes);
    const selectedStylePack = profile.selectedStylePack ?? profile.selected_style_pack;
    const buyRules = profile.buyRules ?? profile.buy_rules;
    const sellRules = profile.sellRules ?? profile.sell_rules;
    const riskRules = profile.riskRules ?? profile.risk_rules;
    if (!style && !notes) throw new Error("style confirmation requires styleProfile with a strategy summary");
    const existing = (await store.readStrategy()) ?? {};
    await store.writeStrategy({
      ...existing,
      profile: {
        ...(existing.profile ?? {}),
        style: style || existing.profile?.style || "自定义策略",
        selected_style_pack: selectedStylePack === null ? null : stringInput(selectedStylePack) ?? existing.profile?.selected_style_pack ?? null,
        custom_style_enabled: typeof (profile.customStyleEnabled ?? profile.custom_style_enabled) === "boolean"
          ? Boolean(profile.customStyleEnabled ?? profile.custom_style_enabled)
          : existing.profile?.custom_style_enabled ?? true,
        risk_preference: stringInput(profile.riskPreference ?? profile.risk_preference) ?? existing.profile?.risk_preference ?? "",
        investment_horizon: stringInput(profile.investmentHorizon ?? profile.investment_horizon) ?? existing.profile?.investment_horizon ?? "",
      },
      buy_rules: Array.isArray(buyRules) ? buyRules : existing.buy_rules ?? [],
      sell_rules: Array.isArray(sellRules) ? sellRules : existing.sell_rules ?? [],
      risk_rules: Array.isArray(riskRules) ? riskRules : existing.risk_rules ?? [],
      notes: notes ?? existing.notes ?? "",
      last_confirmed_at: now,
    });
  }

  if (step === "review_schedule") {
    const schedules = await store.readSchedules() ?? {};
    const reviewSchedule = asRecord(body.reviewSchedule ?? body.review_schedule);
    await store.writeSchedules({
      ...schedules,
      timezone: schedules.timezone ?? "Asia/Shanghai",
      run_policy: {
        automatic_by_default: true,
        manual_trigger_allowed: true,
        skip_automatic_if_manual_report_exists: true,
        refresh_requires_user_confirmation: true,
        ...(asRecord(schedules.run_policy)),
      },
      daily_review: {
        enabled: true,
        auto_run: true,
        default_time: stringInput(body.dailyReviewTime ?? body.daily_review_time) || "19:00",
        trading_days_only: true,
        ...asRecord(reviewSchedule.daily_review),
      },
      weekly_review: {
        enabled: true,
        auto_run: true,
        default_time: stringInput(body.weeklyReviewTime ?? body.weekly_review_time) || "Saturday 09:00",
        ...asRecord(reviewSchedule.weekly_review),
      },
      monthly_review: {
        enabled: true,
        auto_run: true,
        default_time: stringInput(body.monthlyReviewTime ?? body.monthly_review_time) || "day_1 09:00",
        review_previous_month: true,
        ...asRecord(reviewSchedule.monthly_review),
      },
    });
  }
  if (step === "market_watch_schedule") {
    const schedules = await store.readSchedules() ?? {};
    const inputSchedule = asRecord(body.marketWatchSchedule ?? body.market_watch_schedule);
    const windows = Array.isArray(inputSchedule.default_windows)
      ? inputSchedule.default_windows.map(String)
      : Array.isArray(body.marketWatchWindows)
        ? body.marketWatchWindows.map(String)
        : Array.isArray(body.market_watch_windows)
          ? body.market_watch_windows.map(String)
          : ["09:55", "11:20", "14:30"];
    await store.writeSchedules({
      ...schedules,
      market_watch: {
        ...asRecord(schedules.market_watch),
        enabled: true,
        default_windows: windows,
        custom_frequency: inputSchedule.custom_frequency ?? null,
        only_push_on_exception: inputSchedule.only_push_on_exception !== false,
        push_mode: stringInput(inputSchedule.push_mode ?? body.pushMode ?? body.push_mode) || "exception_only",
      },
    });
  }
  if (step === "notification") {
    const notification = await store.readNotification() ?? {};
    const mode = readNotificationMode(body);
    await store.writeNotification({
      ...notification,
      preference: {
        mode,
        label: mode === "active_watch" ? "积极盯盘" : mode === "evening_summary" ? "晚间汇总" : "低打扰",
        updated_at: now,
      },
    });
  }
  if (step === "watch_rules") {
    await store.appendChangeLog({
      ts: now,
      source: "mcp",
      type: "watch_rules_boundary_confirmed",
      summary: "用户确认默认提醒边界；未自动创建明确规则巡检",
      details: { did_create_explicit_rules: false },
    });
  }
}

function readNotificationMode(body: Record<string, unknown>): "low_disturbance" | "active_watch" | "evening_summary" {
  const raw = body.notificationPreference ?? body.notification_preference ?? body.notification ?? body.preference;
  if (typeof raw === "string") return normalizeNotificationMode(raw);
  const record = asRecord(raw);
  return normalizeNotificationMode(record.mode ?? body.notification_mode ?? body.notificationMode ?? body.mode);
}

function normalizeNotificationMode(value: unknown): "low_disturbance" | "active_watch" | "evening_summary" {
  if (value === "active_watch" || value === "evening_summary") return value;
  return "low_disturbance";
}
