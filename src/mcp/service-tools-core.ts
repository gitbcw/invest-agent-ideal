import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { conversationMessages, pendingSandboxConfirmations } from "../db/schema.js";
import { planBackend, portfolioBackend, watchlistBackend } from "../lib/data-backend.js";
import { recordSandboxAudit } from "../lib/sandbox-audit.js";
import { consumeSandboxConfirmation, createSandboxConfirmation } from "../lib/sandbox-confirmation.js";
import type { SandboxContext } from "../lib/sandbox-context.js";
import { DEFAULT_PROJECT_ID, defaultInstanceIdForUser, normalizeUserId } from "../lib/user-context.js";
import { WorkspaceStore, type OnboardingStateYaml } from "../lib/workspace-store.js";
import { saveSkillDailyReview } from "../handlers/review.js";
import { setPlanWatchConditions, type PlanWatchConditionInput } from "../handlers/plan-conditions.js";
import { marketHealth, marketQuote, marketSnapshot } from "../services/market-data.js";
import { resolveStockRefs } from "../services/stock-resolver.js";
import { createWatchRule, dryRunWatchRuleById, listWatchRuleCatalog, listWatchRules, validateWatchRule } from "../services/watch-rules.js";
import { methodChangeBackend } from "../lib/method-change-backend.js";

export interface ServiceToolContext {
  userId: string;
  instanceId: string;
  workspacePath?: string;
  projectId?: string;
  conversationId?: string;
}

export function serviceToolContextFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceToolContext {
  const userId = normalizeUserId(env.INVEST_AGENT_MCP_USER_ID);
  const instanceId = (env.INVEST_AGENT_MCP_INSTANCE_ID || defaultInstanceIdForUser(userId)).trim();
  const workspacePath = env.INVEST_AGENT_MCP_WORKSPACE_PATH?.trim() || undefined;
  const conversationId = env.INVEST_AGENT_MCP_CONVERSATION_ID?.trim() || undefined;
  return { userId, instanceId, workspacePath, projectId: DEFAULT_PROJECT_ID, conversationId };
}

export async function callServiceTool(
  name: string,
  input: Record<string, unknown> | undefined,
  context: ServiceToolContext
): Promise<unknown> {
  switch (name) {
    case "market.snapshot":
      return {
        ok: true,
        userId: context.userId,
        instanceId: context.instanceId,
        result: await marketSnapshot({
          userId: context.userId,
          instanceId: context.instanceId,
          includeCapitalFlow: input?.includeCapitalFlow === true,
        }),
      };
    case "market.quote": {
      const codes = normalizeCodes(input?.codes);
      if (codes.length === 0) throw new Error("codes is required");
      return {
        ok: true,
        userId: context.userId,
        instanceId: context.instanceId,
        updatedAt: new Date().toISOString(),
        ...(await marketQuote(codes, context.userId)),
      };
    }
    case "market.health":
      return {
        ok: true,
        userId: context.userId,
        instanceId: context.instanceId,
        result: await marketHealth(),
      };
    case "portfolio.read": {
      const rows = await portfolioBackend.listActive(context.userId, context.instanceId);
      return {
        ok: true,
        userId: context.userId,
        instanceId: context.instanceId,
        count: rows.length,
        items: rows.map((row) => ({
          id: row.rowId ?? null,
          stockCode: row.code,
          stockName: row.name,
          buyDate: row.buyDate,
          costPrice: row.costPrice ?? null,
          sellPrice: row.sellPrice ?? null,
          sellDate: row.sellDate ?? null,
          status: row.status,
        })),
      };
    }
    case "watchlist.read": {
      const rows = await watchlistBackend.list(context.userId, context.instanceId);
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
    case "onboarding.confirm_portfolio":
      return confirmOnboardingPortfolio(input, context);
    case "onboarding.confirm_step":
      return confirmOnboardingStep(input, context);
    case "watchlist.add":
      return addWatchlist(input, context);
    case "plans.set":
      return setPlan(input, context);
    case "plans.watch_conditions":
      return setPlanConditions(input, context);
    case "method_changes.propose":
      return proposeMethodChange(input, context);
    case "reviews.save":
      return saveReview(input, context);
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
      await requireBoundConfirmation(input, context, "watch_rules.create");
      const rule = await createWatchRule({
        ...(input as any),
        userId: context.userId,
        instanceId: context.instanceId,
        source: { kind: "mcp_tool", actor: "workspace_codex" },
      });
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
  await requireBoundConfirmation(input, context, "onboarding.confirm_portfolio");
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
  const state = normalizeOnboardingState(await store.readOnboardingState());
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
  await audit(context, {
    operation: "onboarding.confirm_portfolio",
    resourceType: "onboarding_state",
    resourceId: "portfolio",
    requestBody: input,
    resultSummary: `confirmed portfolio holdings=${holdingInputs.length}; watchlist=${watchInputs.length}; current=style`,
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, state: nextState, holdings, watchlist: watchItems };
}

async function confirmOnboardingStep(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const step = stringInput(input?.step);
  if (!isOnboardingStep(step)) throw new Error(`非法 onboarding step: ${String(step ?? "")}`);
  await requireBoundConfirmation(input, context, "onboarding.confirm_step");
  const now = new Date().toISOString();
  const store = new WorkspaceStore(context.userId);
  await applyOnboardingStepDefaults(store, step, now, input ?? {});
  const current = normalizeOnboardingState(await store.readOnboardingState());
  const steps = { ...(current.steps ?? {}) };
  steps[step] = { done: true, completed_at: steps[step]?.completed_at ?? now };
  const allDone = ONBOARDING_STEPS.every((key) => key === step || steps[key]?.done === true);
  const shouldComplete = allDone || step === "watch_rules";
  const nextState: OnboardingStateYaml = {
    ...current,
    status: shouldComplete ? "completed" : "in_progress",
    current_step: shouldComplete ? "completed" : nextOnboardingStep(step),
    steps,
    completed_at: shouldComplete ? (current.completed_at ?? now) : current.completed_at ?? null,
    updated_at: now,
    notes: stringInput(input?.notes) ?? current.notes ?? "",
  };
  await store.writeOnboardingState(nextState);
  await store.appendChangeLog({
    ts: now,
    source: "mcp",
    type: `onboarding_${step}_confirmed`,
    summary: stringInput(input?.summary) || `用户确认 onboarding 步骤: ${step}`,
    details: { step, status: nextState.status, current_step: nextState.current_step },
  });
  await audit(context, {
    operation: "onboarding.confirm_step",
    resourceType: "onboarding_state",
    resourceId: step,
    requestBody: input,
    resultSummary: `confirmed ${step}; status=${nextState.status}`,
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, state: nextState, message: shouldComplete ? "新手引导已完成" : `已确认 ${step}` };
}

async function addWatchlist(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  await requireBoundConfirmation(input, context, "watchlist.add");
  const name = stringInput(input?.name ?? input?.stockName);
  const code = stringInput(input?.code ?? input?.stockCode);
  if (!name && !code) throw new Error("请输入股票名称或代码");
  const { codes, unresolved } = await resolveStockRefs([{ code, name }]);
  if (codes.length === 0) throw new Error(`未找到股票：${unresolved[0]?.name ?? code}`);
  const stockCode = codes[0];
  const existing = await watchlistBackend.find(context.userId, context.instanceId, stockCode);
  if (existing) return { ok: false, error: `${existing.name}(${stockCode}) 已在自选池中`, userId: context.userId };
  const quoteResult = await marketQuote([stockCode], context.userId);
  const stockName = quoteResult.items[0]?.name || name || stockCode;
  await watchlistBackend.add(context.userId, context.instanceId, {
    code: stockCode,
    name: stockName,
    reason: normalizeWatchlistReason(stringInput(input?.reason) || "AI 助手根据对话加入"),
    source: "ai_conversation",
  });
  await audit(context, {
    operation: "watchlist.add",
    resourceType: "watchlist",
    resourceId: stockCode,
    requestBody: input,
    resultSummary: `added ${stockName}(${stockCode})`,
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, message: `已添加 ${stockName}(${stockCode}) 到自选池`, stockCode, stockName };
}

async function setPlan(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  await requireBoundConfirmation(input, context, "plans.set");
  const stockCode = stringInput(input?.stockCode ?? input?.code);
  if (!stockCode) throw new Error("缺少股票代码");
  const quoteResult = await marketQuote([stockCode], context.userId);
  const stockName = stringInput(input?.stockName ?? input?.name) || quoteResult.items[0]?.name || stockCode;
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
  await audit(context, {
    operation: "plans.set",
    resourceType: "stock_plan",
    resourceId: stockCode,
    requestBody: input,
    resultSummary: `${existing ? "updated" : "created"} ${stockName}(${stockCode})`,
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, message: `${stockName}(${stockCode}) 预案已${existing ? "更新" : "创建"}` };
}

async function setPlanConditions(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  await requireBoundConfirmation(input, context, "plans.watch_conditions");
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
  await audit(context, {
    operation: "plans.watch_conditions",
    resourceType: "stock_plan",
    resourceId: stockCode,
    requestBody: input,
    resultSummary: `updated ${result.conditionCount} conditions for ${result.stockName}(${result.stockCode})`,
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, ...result };
}

async function proposeMethodChange(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  await requireBoundConfirmation(input, context, "method_changes.propose");
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
  await audit(context, {
    operation: "method_changes.propose",
    resourceType: "method_change_candidate",
    resourceId: String(created.id),
    requestBody: input,
    resultSummary: "proposed method change",
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, candidate: created };
}

async function saveReview(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  requireConfirmed(input);
  const content = stringInput(input?.content);
  if (!content) throw new Error("缺少复盘内容");
  const saved = await saveSkillDailyReview({
    userId: context.userId,
    instanceId: context.instanceId,
    date: stringInput(input?.date),
    content,
    summary: stringInput(input?.summary),
    context: input?.context,
  });
  await audit(context, {
    operation: "reviews.save",
    resourceType: "daily_review",
    resourceId: saved.date,
    requestBody: { date: input?.date, summary: input?.summary, hasContent: true, hasContext: Boolean(input?.context) },
    resultSummary: `saved daily review ${saved.date}`,
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, ...saved };
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

const CONFIRMED_WRITE_OPERATIONS = new Set([
  "onboarding.confirm_portfolio",
  "onboarding.confirm_step",
  "watchlist.add",
  "plans.set",
  "plans.watch_conditions",
  "method_changes.propose",
  "watch_rules.create",
]);

async function requestConfirmation(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const operation = stringInput(input?.operation);
  const payload = asRecord(input?.payload);
  if (!operation || !CONFIRMED_WRITE_OPERATIONS.has(operation)) throw new Error("operation is not confirmable");
  if (!context.conversationId) throw new Error("conversationId is required for confirmation");
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
  };
}

async function requireBoundConfirmation(
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
  const result = await consumeSandboxConfirmation(
    mcpSandboxContext(context, `mcp-confirm:${Date.now()}`),
    confirmationId,
    confirmationTarget(operation, payload, context)
  );
  if (!result.ok) throw new Error(`confirmation invalid: ${result.reason}`);
}

function confirmationTarget(operation: string, payload: Record<string, unknown>, context: ServiceToolContext) {
  const resourceByOperation: Record<string, string> = {
    "onboarding.confirm_portfolio": "onboarding_portfolio",
    "onboarding.confirm_step": "onboarding_step",
    "watchlist.add": "watchlist",
    "plans.set": "stock_plan",
    "plans.watch_conditions": "stock_plan",
    "method_changes.propose": "method_change_candidate",
    "watch_rules.create": "watch_rule",
  };
  const resourceType = resourceByOperation[operation];
  if (!resourceType) throw new Error("operation is not confirmable");
  const resourceId = operation === "onboarding.confirm_portfolio"
    ? context.instanceId
    : operation === "onboarding.confirm_step"
      ? stringInput(payload.step)
      : operation.startsWith("plans.")
        ? stringInput(payload.stockCode ?? payload.code)
        : undefined;
  return { operation, resourceType, resourceId, requestBody: payload };
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
