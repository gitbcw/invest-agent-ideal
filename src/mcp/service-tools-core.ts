import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import ExcelJS from "exceljs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { db, sqlite } from "../db/index.js";
import { alertRules, conversationArtifacts, conversationMessages, mastraProjectProfiles, pendingSandboxConfirmations, sandboxAuditLogs } from "../db/schema.js";
import { resolveProjectStorageRoot } from "../services/project-storage-root.js";
import {
  publishConversationArtifact,
  readConversationArtifactPayload,
  type ConversationArtifact,
  type ConversationArtifactRecord,
} from "../services/conversation-artifacts.js";
import {
  archiveUserAsset,
  createUserAsset,
  deleteUserAsset,
  getUserAsset,
  listUserAssets,
  listUserAssetReferences,
  listUserAssetVersions,
  readCurrentUserAsset,
  readUserAssetVersion,
  renameUserAsset,
  saveConversationAttachmentAsUserAsset,
  saveConversationArtifactAsUserAsset,
  uploadUserAssetVersion,
  UserAssetError,
} from "../services/user-assets.js";
import {
  activateAutomationTask,
  createAutomationTask,
  getAutomationTask,
  getAutomationTaskRun,
  listAutomationTaskRevisions,
  listAutomationTasks,
  pauseAutomationTask,
  updateAutomationTask,
} from "../services/automation-tasks.js";
import { ACTIVE_BACKEND, isWorkspaceBackend, planBackend, portfolioBackend, watchlistBackend } from "../lib/data-backend.js";
import { getMastraPortfolioRevision, readMastraPortfolioProjection, replaceMastraPortfolioProjection } from "../lib/mastra-portfolio-backend.js";
import { recordSandboxAudit } from "../lib/sandbox-audit.js";
import { registerReportAssetMapping } from "../services/report-asset-mappings.js";
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
  openMastraOnboardingStore,
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
import { applyUserPreferenceChange, MastraUserPreferenceStore, planUserPreferenceChange, type UserPreferenceChangeInput, type UserPreferenceStore } from "../services/user-preferences.js";

export interface ServiceToolContext {
  userId: string;
  instanceId: string;
  workspacePath?: string;
  projectId?: string;
  conversationId?: string;
  runId?: string;
  expectedReviewKind?: "daily" | "weekly" | "monthly";
  expectedReviewKey?: string;
}

export interface ServiceToolFailureInjection {
  artifactPublish?: (relativePath: string) => Error | undefined;
  artifactPublishAfter?: (relativePath: string, artifact: ConversationArtifact) => Error | undefined;
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
  const runId = env.INVEST_AGENT_MCP_RUN_ID?.trim() || undefined;
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
    runId,
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
    const resourceKeys = [
      ...mutationResourceKeysForOperation(name, input),
      ...directAutomationResourceKeys(name, input),
    ];
    return resourceKeys.length > 0
      ? await withResourceMutationLock(context, resourceKeys, () => dispatchServiceTool(name, input, context))
      : await dispatchServiceTool(name, input, context);
  } catch (error) {
    if (CONFIRMED_WRITE_OPERATIONS.has(name) || DRAFT_OPERATIONS.has(name) || DIRECT_AUTOMATION_OPERATIONS.has(name) || name === "confirmations.request" || name === "reviews.save" || name === "artifacts.publish" || name === "research.web_search" || name === "research.web_read" || name.startsWith("assets.")) {
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

function directAutomationResourceKeys(name: string, input: Record<string, unknown> | undefined): string[] {
  if (name === "assets.list" || name === "automation.list" || name === "automation.get") return [];
  if (name === "automation.create") {
    const taskId = stringInput(input?.taskId);
    return [taskId ? `automation-task:${taskId}` : "automation-task:create"];
  }
  if (name === "automation.update" || name === "automation.activate" || name === "automation.pause") {
    const taskId = stringInput(input?.taskId);
    return [taskId ? `automation-task:${taskId}` : "automation-task:invalid"];
  }
  return [];
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
        projectId: context.projectId,
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
      const portfolio = readMastraPortfolioProjection(context.userId, context.instanceId) as PortfolioYaml;
      const revision = getMastraPortfolioRevision(context.userId, context.instanceId);
      await audit(context, {
        operation: "portfolio.read",
        resourceType: "portfolio",
        resourceId: context.instanceId,
        resultSummary: `holdings=${rows.length}; revision=${revision ?? "null"}`,
      });
      return {
        ok: true,
        userId: context.userId,
        instanceId: context.instanceId,
        count: rows.length,
        revision,
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
    case "assets.list":
      return listAssetsTool(input, context);
    case "assets.version.read":
      return readAssetVersionTool(input, context);
    case "assets.version.commit":
      return submitAssetVersionTool(input, context);
    case "assets.conversation.save":
      return saveConversationAssetTool(input, context);
    case "assets.attachment.save":
      return saveAttachmentAsAssetTool(input, context);
    case "assets.rename":
      return renameAssetTool(input, context);
    case "assets.archive":
      return archiveAssetTool(input, context);
    case "assets.delete":
      return deleteAssetTool(input, context);
    case "automation.list":
      return listAutomationTool(input, context);
    case "automation.get":
      return getAutomationTool(input, context);
    case "automation.create":
      return createAutomationTool(input, context);
    case "automation.update":
      return updateAutomationTool(input, context);
    case "automation.activate":
      return setAutomationActiveTool(input, context);
    case "automation.pause":
      return setAutomationPausedTool(input, context);
    case "confirmations.pending":
      return readPendingConfirmations(input, context);
    case "confirmations.request":
      return requestConfirmation(input, context);
    case "portfolio.apply_changes":
      return applyPortfolioChanges(input, context);
    case "onboarding.confirm_portfolio":
      return confirmOnboardingPortfolio(input, context);
    case "onboarding.draft.get":
      return readOnboardingDraft(context);
    case "onboarding.draft.upsert_step":
      return upsertOnboardingDraft(input, context);
    case "onboarding.draft.request_confirmation":
      return requestOnboardingDraftStepConfirmation(input, context);
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
    case "spreadsheet.create":
      return createSpreadsheetTool(input, context);
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

async function readAssetVersionTool(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const assetId = stringInput(input?.assetId);
  if (!assetId) throw new UserAssetError("ASSET_NOT_FOUND", "assetId is required");
  const scope = assetScope(context);
  const result = stringInput(input?.versionId)
    ? await readUserAssetVersion({ ...scope, assetId, versionId: stringInput(input?.versionId)! })
    : await readCurrentUserAsset({ ...scope, assetId });
  await audit(context, {
    operation: "assets.version.read",
    resourceType: "user_asset_version",
    resourceId: result.descriptor.versionId,
    requestBody: { assetId, versionId: input?.versionId ?? null },
    resultSummary: "format=" + result.descriptor.format + "; sizeBytes=" + result.bytes.length,
  });
  return {
    ok: true,
    asset: publicAssetDescriptor(await getUserAsset({ ...scope, assetId })),
    version: publicAssetVersion(result.descriptor),
    base64: result.bytes.toString("base64"),
  };
}

type DirectAutomationStatus = "active" | "paused";

function automationToolScope(context: ServiceToolContext) {
  return {
    userId: context.userId,
    projectId: context.projectId || DEFAULT_PROJECT_ID,
    instanceId: context.instanceId,
  };
}

function requestedAutomationStatus(input: Record<string, unknown> | undefined): DirectAutomationStatus | undefined {
  const status = stringInput(input?.status);
  if (status === "active" || status === "paused") return status;
  if (typeof input?.enabled === "boolean") return input.enabled ? "active" : "paused";
  if (typeof input?.activate === "boolean") return input.activate ? "active" : "paused";
  if (typeof input?.active === "boolean") return input.active ? "active" : "paused";
  return undefined;
}

function automationDefinitionInput(input: Record<string, unknown> | undefined) {
  const value = input ?? {};
  return {
    ...(stringInput(value.taskId) ? { taskId: stringInput(value.taskId) } : {}),
    name: value.name,
    ...(value.description !== undefined ? { description: value.description } : {}),
    schedule: value.schedule,
    ...(value.instruction !== undefined ? { instruction: value.instruction } : {}),
    ...(value.inputs !== undefined ? { inputs: value.inputs } : {}),
    ...(value.output !== undefined ? { output: value.output } : {}),
    ...(value.delivery !== undefined ? { delivery: value.delivery } : {}),
  };
}

function automationUpdateDefinitionInput(input: Record<string, unknown> | undefined) {
  const value = input ?? {};
  return {
    taskId: value.taskId,
    ...(value.expectedRevision !== undefined ? { expectedRevision: value.expectedRevision } : {}),
    ...(value.name !== undefined ? { name: value.name } : {}),
    ...(value.description !== undefined ? { description: value.description } : {}),
    ...(value.schedule !== undefined ? { schedule: value.schedule } : {}),
    ...(value.instruction !== undefined ? { instruction: value.instruction } : {}),
    ...(value.inputs !== undefined ? { inputs: value.inputs } : {}),
    ...(value.output !== undefined ? { output: value.output } : {}),
    ...(value.delivery !== undefined ? { delivery: value.delivery } : {}),
  };
}

function hasAutomationDefinitionUpdate(input: Record<string, unknown> | undefined): boolean {
  const value = input ?? {};
  return ["name", "description", "schedule", "instruction", "inputs", "output", "delivery"]
    .some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

async function listAssetsTool(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const value = input ?? {};
  const scope = automationToolScope(context);
  const assets = await listUserAssets({
    ...scope,
    ...(value.status === "active" || value.status === "archived" || value.status === "all" ? { status: value.status } : {}),
    ...(typeof value.search === "string" ? { search: value.search } : {}),
    ...(typeof value.format === "string" ? { format: value.format as never } : {}),
    ...(typeof value.source === "string" ? { source: value.source as never } : {}),
    ...(typeof value.limit === "number" ? { limit: value.limit } : {}),
  });
  await audit(context, {
    operation: "assets.list",
    resourceType: "user_asset",
    resourceId: context.instanceId,
    requestBody: {
      status: value.status ?? null,
      search: value.search ?? null,
      format: value.format ?? null,
      source: value.source ?? null,
      limit: value.limit ?? null,
    },
    resultSummary: `assets=${assets.length}`,
  });
  return {
    ok: true,
    userId: context.userId,
    instanceId: context.instanceId,
    count: assets.length,
    items: assets.map((asset) => publicAssetDescriptor(asset)),
  };
}

async function listAutomationTool(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const value = input ?? {};
  const statuses = Array.isArray(value.statuses)
    ? value.statuses.filter((status): status is "paused" | "active" | "needs_attention" | "archived" =>
      status === "paused" || status === "active" || status === "needs_attention" || status === "archived")
    : undefined;
  const frequencies = Array.isArray(value.frequencies)
    ? value.frequencies.filter((frequency): frequency is "daily" | "trading_days" | "weekdays" | "weekly" =>
      frequency === "daily" || frequency === "trading_days" || frequency === "weekdays" || frequency === "weekly")
    : undefined;
  const deliveryModes = Array.isArray(value.deliveryModes)
    ? value.deliveryModes.filter((mode): mode is "none" | "wechat_summary" | "wechat_on_condition" =>
      mode === "none" || mode === "wechat_summary" || mode === "wechat_on_condition")
    : undefined;
  const outputModes = Array.isArray(value.outputModes)
    ? value.outputModes.filter((mode): mode is "none" | "agent" | "create" | "update" =>
      mode === "none" || mode === "agent" || mode === "create" || mode === "update")
    : undefined;
  const items = await listAutomationTasks(automationToolScope(context), {
    ...(typeof value.query === "string" ? { query: value.query } : {}),
    ...(statuses?.length ? { statuses } : {}),
    ...(frequencies?.length ? { frequencies } : {}),
    ...(deliveryModes?.length ? { deliveryModes } : {}),
    ...(outputModes?.length ? { outputModes } : {}),
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
    ...(typeof value.limit === "number" ? { limit: value.limit } : {}),
  });
  await audit(context, {
    operation: "automation.list",
    resourceType: "automation_task",
    resourceId: context.instanceId,
    requestBody: {
      query: value.query ?? null,
      statuses: statuses ?? null,
      frequencies: frequencies ?? null,
      deliveryModes: deliveryModes ?? null,
      outputModes: outputModes ?? null,
      cursor: value.cursor ?? null,
      limit: value.limit ?? null,
    },
    resultSummary: `tasks=${items.length}`,
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, count: items.length, items };
}

async function getAutomationTool(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const taskId = stringInput(input?.taskId);
  if (!taskId) throw new Error("taskId is required");
  const task = await getAutomationTask({ ...automationToolScope(context), taskId });
  await audit(context, {
    operation: "automation.get",
    resourceType: "automation_task",
    resourceId: taskId,
    requestBody: { taskId },
    resultSummary: task ? `status=${task.status}; revision=${task.currentRevision}` : "not_found",
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, task };
}

async function createAutomationTool(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const value = input ?? {};
  const scope = automationToolScope(context);
  const created = await createAutomationTask({ ...scope, ...automationDefinitionInput(value) } as never);
  const requestedStatus = requestedAutomationStatus(value);
  // Direct assistant creation is an enable-on-create flow by default. A
  // caller can explicitly request paused when preparing a task for later.
  const task = requestedStatus === "paused"
    ? created
    : await activateAutomationTask({ ...scope, taskId: created.taskId, expectedRevision: created.currentRevision });
  await audit(context, {
    operation: "automation.create",
    resourceType: "automation_task",
    resourceId: task.taskId,
    requestBody: { ...automationDefinitionInput(value), status: requestedStatus ?? "active" },
    resultSummary: `created; status=${task.status}; revision=${task.currentRevision}`,
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, task };
}

async function updateAutomationTool(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const value = input ?? {};
  const taskId = stringInput(value.taskId);
  if (!taskId) throw new Error("taskId is required");
  const scope = automationToolScope(context);
  const current = await getAutomationTask({ ...scope, taskId });
  if (!current) throw new Error(`automation task not found: ${taskId}`);
  const requestedStatus = requestedAutomationStatus(value);

  if (!hasAutomationDefinitionUpdate(value) && requestedStatus) {
    const task = requestedStatus === "active"
      ? await activateAutomationTask({ ...scope, taskId, expectedRevision: typeof value.expectedRevision === "number" ? value.expectedRevision : undefined })
      : await pauseAutomationTask({ ...scope, taskId, expectedRevision: typeof value.expectedRevision === "number" ? value.expectedRevision : undefined });
    await audit(context, {
      operation: "automation.update",
      resourceType: "automation_task",
      resourceId: taskId,
      requestBody: { taskId, status: requestedStatus, expectedRevision: value.expectedRevision ?? null },
      resultSummary: `status=${task.status}; revision=${task.currentRevision}`,
    });
    return { ok: true, userId: context.userId, instanceId: context.instanceId, task };
  }

  const revised = await updateAutomationTask({ ...scope, ...automationUpdateDefinitionInput(value) } as never);
  const shouldRemainActive = requestedStatus === "active" || (requestedStatus !== "paused" && current.status === "active");
  const task = shouldRemainActive
    ? await activateAutomationTask({ ...scope, taskId, expectedRevision: revised.currentRevision })
    : revised;
  await audit(context, {
    operation: "automation.update",
    resourceType: "automation_task",
    resourceId: taskId,
    requestBody: { ...automationUpdateDefinitionInput(value), status: requestedStatus ?? (current.status === "active" ? "active" : "paused") },
    resultSummary: `updated; status=${task.status}; revision=${task.currentRevision}`,
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, task };
}

async function setAutomationActiveTool(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const taskId = stringInput(input?.taskId);
  if (!taskId) throw new Error("taskId is required");
  const task = await activateAutomationTask({
    ...automationToolScope(context),
    taskId,
    expectedRevision: typeof input?.expectedRevision === "number" ? input.expectedRevision : undefined,
  });
  await audit(context, {
    operation: "automation.activate",
    resourceType: "automation_task",
    resourceId: taskId,
    requestBody: { taskId, expectedRevision: input?.expectedRevision ?? null },
    resultSummary: `status=${task.status}; revision=${task.currentRevision}`,
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, task };
}

async function setAutomationPausedTool(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const taskId = stringInput(input?.taskId);
  if (!taskId) throw new Error("taskId is required");
  const task = await pauseAutomationTask({
    ...automationToolScope(context),
    taskId,
    expectedRevision: typeof input?.expectedRevision === "number" ? input.expectedRevision : undefined,
  });
  await audit(context, {
    operation: "automation.pause",
    resourceType: "automation_task",
    resourceId: taskId,
    requestBody: { taskId, expectedRevision: input?.expectedRevision ?? null },
    resultSummary: `status=${task.status}; revision=${task.currentRevision}`,
  });
  return { ok: true, userId: context.userId, instanceId: context.instanceId, task };
}

async function submitAssetVersionTool(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const assetId = stringInput(input?.assetId);
  const fileName = stringInput(input?.fileName);
  const base64 = stringInput(input?.base64);
  if (!assetId || !fileName || !base64) throw new UserAssetError("ASSET_INVALID_CONTENT", "assetId, fileName and base64 are required");
  const run = await automationAssetRun(context);
  if (run) {
    assertAutomationOutputTarget(run, assetId, "commit");
  }
  const scope = assetScope(context);
  const saved = await uploadUserAssetVersion({
    ...scope,
    assetId,
    fileName,
    mimeType: stringInput(input?.mimeType),
    bytes: decodeAssetBase64(base64),
    expectedVersionId: typeof input?.expectedVersionId === "string"
      ? input.expectedVersionId
      : run?.run.outputVersionId ?? undefined,
    source: run ? "automation" : "conversation",
    conversationId: context.conversationId ?? null,
    taskId: run?.taskId ?? null,
    runId: context.runId ?? null,
    idempotencyKey: stringInput(input?.idempotencyKey),
  });
  await audit(context, {
    operation: "assets.version.commit",
    resourceType: "user_asset",
    resourceId: saved.assetId,
    requestBody: { assetId, fileName, expectedVersionId: input?.expectedVersionId ?? null, runId: context.runId ?? null },
    resultSummary: "versionId=" + (saved.currentVersionId || "") + "; source=" + (run ? "automation" : "conversation"),
  });
  return { ok: true, asset: publicAssetDescriptor(saved), version: saved.currentVersion ? publicAssetVersion(saved.currentVersion) : null };
}

async function saveConversationAssetTool(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const fileName = stringInput(input?.fileName);
  const base64 = stringInput(input?.base64);
  if (!fileName || !base64) throw new UserAssetError("ASSET_INVALID_CONTENT", "fileName and base64 are required");
  const run = await automationAssetRun(context);
  if (run) {
    assertAutomationOutputTarget(run, stringInput(input?.assetId), "save");
  }
  const saved = await saveConversationArtifactAsUserAsset({
    ...assetScope(context),
    name: stringInput(input?.name),
    fileName,
    mimeType: stringInput(input?.mimeType),
    bytes: decodeAssetBase64(base64),
    assetId: stringInput(input?.assetId),
    // MCP permission authorizes ordinary conversation saves. The service
    // retains its confirmation guard for callers outside this capability.
    confirmedByUser: true,
    conversationId: context.conversationId ?? null,
    taskId: run?.taskId ?? null,
    runId: context.runId ?? null,
    idempotencyKey: stringInput(input?.idempotencyKey),
  });
  await audit(context, {
    operation: "assets.conversation.save",
    resourceType: "user_asset",
    resourceId: saved.assetId,
    requestBody: { assetId: input?.assetId ?? null, fileName, runId: context.runId ?? null },
    resultSummary: "versionId=" + (saved.currentVersionId || "") + "; source=" + (run ? "automation" : "conversation"),
  });
  return { ok: true, asset: publicAssetDescriptor(saved), version: saved.currentVersion ? publicAssetVersion(saved.currentVersion) : null };
}

async function saveAttachmentAsAssetTool(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const attachmentId = stringInput(input?.attachmentId);
  if (!attachmentId) throw new UserAssetError("ASSET_INVALID_CONTENT", "attachmentId is required");
  await assertInteractiveAssetMutation(context, "promote conversation attachments");
  const { bytes, record } = await readAttachmentBytes({
    attachmentId,
    userId: context.userId,
    projectId: context.projectId,
    instanceId: context.instanceId,
  });
  const saved = await saveConversationAttachmentAsUserAsset({
    ...assetScope(context),
    name: stringInput(input?.name),
    fileName: record.fileName,
    mimeType: record.mimeType,
    bytes,
    assetId: stringInput(input?.assetId),
    // Calling this capability is permitted only after the user has clearly
    // asked to retain or automate the attachment in the current conversation.
    confirmedByUser: true,
    conversationId: context.conversationId ?? record.conversationId,
    idempotencyKey: stringInput(input?.idempotencyKey) ?? `attachment-save:${attachmentId}`,
  });
  await audit(context, {
    operation: "assets.attachment.save",
    resourceType: "user_asset",
    resourceId: saved.assetId,
    requestBody: { attachmentId, assetId: input?.assetId ?? null },
    resultSummary: "versionId=" + (saved.currentVersionId || "") + "; source=upload",
  });
  return { ok: true, asset: publicAssetDescriptor(saved), version: saved.currentVersion ? publicAssetVersion(saved.currentVersion) : null };
}

async function renameAssetTool(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const assetId = stringInput(input?.assetId);
  const name = stringInput(input?.name);
  if (!assetId || !name) throw new UserAssetError("ASSET_NOT_FOUND", "assetId and name are required");
  await assertInteractiveAssetMutation(context, "rename");
  const saved = await renameUserAsset({ ...assetScope(context), assetId, name });
  await audit(context, {
    operation: "assets.rename", resourceType: "user_asset", resourceId: saved.assetId,
    requestBody: { assetId, name }, resultSummary: "renamed",
  });
  return { ok: true, asset: publicAssetDescriptor(saved) };
}

async function archiveAssetTool(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const assetId = stringInput(input?.assetId);
  if (!assetId) throw new UserAssetError("ASSET_NOT_FOUND", "assetId is required");
  await assertInteractiveAssetMutation(context, "archive");
  const saved = await archiveUserAsset({ ...assetScope(context), assetId });
  await audit(context, {
    operation: "assets.archive", resourceType: "user_asset", resourceId: saved.assetId,
    requestBody: { assetId }, resultSummary: "archived",
  });
  return { ok: true, asset: publicAssetDescriptor(saved) };
}

async function deleteAssetTool(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const assetId = stringInput(input?.assetId);
  if (!assetId) throw new UserAssetError("ASSET_NOT_FOUND", "assetId is required");
  await assertInteractiveAssetMutation(context, "delete");
  const confirmation = await prepareBoundConfirmation(input, context, "assets.delete");
  const deleted = await deleteUserAsset({ ...assetScope(context), assetId });
  await confirmation.consume();
  await audit(context, {
    operation: "assets.delete", resourceType: "user_asset", resourceId: deleted.assetId,
    requestBody: { assetId }, resultSummary: "deletedVersions=" + deleted.deletedVersions,
  });
  return { ok: true, ...deleted };
}

type AutomationAssetRunContext = {
  taskId: string;
  run: NonNullable<Awaited<ReturnType<typeof getAutomationTaskRun>>>;
  revision: NonNullable<Awaited<ReturnType<typeof listAutomationTaskRevisions>>>[number];
};

async function automationAssetRun(context: ServiceToolContext): Promise<AutomationAssetRunContext | null> {
  if (!context.runId) return null;
  const run = await getAutomationTaskRun({
    userId: context.userId,
    projectId: context.projectId || DEFAULT_PROJECT_ID,
    instanceId: context.instanceId,
    runId: context.runId,
  });
  if (!run || run.status !== "running") throw new UserAssetError("ASSET_LEASE_LOST", "automation run is not active");
  const task = await getAutomationTask({
    userId: context.userId,
    projectId: context.projectId || DEFAULT_PROJECT_ID,
    instanceId: context.instanceId,
    taskId: run.taskId,
  });
  if (!task) throw new UserAssetError("ASSET_LEASE_LOST", "automation task is unavailable");
  const revisions = await listAutomationTaskRevisions({
    userId: context.userId,
    projectId: context.projectId || DEFAULT_PROJECT_ID,
    instanceId: context.instanceId,
    taskId: run.taskId,
  });
  const revision = revisions.find((item) => item.revisionId === run.revisionId);
  if (!revision) throw new UserAssetError("ASSET_LEASE_LOST", "automation revision is unavailable");
  return { taskId: run.taskId, run, revision };
}

async function assertInteractiveAssetMutation(context: ServiceToolContext, operation: string): Promise<void> {
  const run = await automationAssetRun(context);
  if (run) {
    throw new UserAssetError("AUTOMATION_ASSET_BINDING_INVALID", `scheduled automation cannot ${operation} assets`);
  }
}

function assertAutomationOutputTarget(run: AutomationAssetRunContext, assetId: string | undefined, operation: "commit" | "save"): void {
  const output = run.revision.output;
  if (output.mode === "update") {
    if (!assetId || output.assetId !== assetId || run.run.outputAssetId !== assetId) {
      throw new UserAssetError("AUTOMATION_ASSET_BINDING_INVALID", `${operation} target is not bound to the run`);
    }
    return;
  }
  if (operation === "commit" || assetId) {
    throw new UserAssetError("AUTOMATION_ASSET_BINDING_INVALID", `${operation} requires the declared output policy`);
  }
}

function assetScope(context: ServiceToolContext) {
  return { userId: context.userId, projectId: context.projectId || DEFAULT_PROJECT_ID, instanceId: context.instanceId };
}

function decodeAssetBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new UserAssetError("ASSET_INVALID_CONTENT", "base64 payload is invalid");
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length) throw new UserAssetError("ASSET_INVALID_CONTENT", "asset is empty");
  return bytes;
}

function publicAssetDescriptor(asset: Awaited<ReturnType<typeof getUserAsset>> | Awaited<ReturnType<typeof createUserAsset>>): unknown {
  if (!asset) return null;
  return {
    assetId: asset.assetId,
    name: asset.name,
    status: asset.status,
    currentVersionId: asset.currentVersionId,
    currentVersion: asset.currentVersion ? publicAssetVersion(asset.currentVersion) : null,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    archivedAt: asset.archivedAt,
  };
}

function publicAssetVersion(version: Awaited<ReturnType<typeof readCurrentUserAsset>>["descriptor"]): unknown {
  const safe = { ...version } as Record<string, unknown>;
  delete safe.storagePath;
  return safe;
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
  const mastraStore = openMastraOnboardingStore({ userId: context.userId, instanceId: context.instanceId, projectId: context.projectId });
  const store: any = mastraStore.store;
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
  sqlite.transaction(() => mastraStore.persist())();
  await confirmation.consume();
  await audit(context, {
    operation: "onboarding.confirm_portfolio",
    resourceType: "onboarding_state",
    resourceId: "portfolio",
    requestBody: input,
    resultSummary: `confirmed portfolio holdings=${holdingInputs.length}; watchlist=${watchInputs.length}; current=style`,
  });
  const publication: WorkspaceArtifactPublication = { artifacts: [], failures: [] };
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
]);

const DIRECT_AUTOMATION_OPERATIONS = new Set([
  "assets.list",
  "automation.list",
  "automation.get",
  "automation.create",
  "automation.update",
  "automation.activate",
  "automation.pause",
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
  const expectedRevision = getMastraPortfolioRevision(context.userId, context.instanceId);
  await watchlistBackend.add(context.userId, context.instanceId, {
    code: stockCode,
    name: stockName,
    reason: normalizeWatchlistReason(stringInput(input?.reason) || "AI 助手根据对话加入"),
    source: "ai_conversation",
    expectedRevision,
  });
  await confirmation.consume();
  await audit(context, {
    operation: "watchlist.add",
    resourceType: "watchlist",
    resourceId: stockCode,
    requestBody: input,
    resultSummary: `added ${stockName}(${stockCode})`,
  });
  const publication: WorkspaceArtifactPublication = { artifacts: [], failures: [] };
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
  const expectedRevision = getMastraPortfolioRevision(context.userId, context.instanceId);
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
    expectedRevision,
  });
  await confirmation.consume();
  await audit(context, {
    operation: "plans.set",
    resourceType: "stock_plan",
    resourceId: stockCode,
    requestBody: input,
    resultSummary: `${existing ? "updated" : "created"} ${stockName}(${stockCode})`,
  });
  const publication: WorkspaceArtifactPublication = { artifacts: [], failures: [] };
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
  const publication: WorkspaceArtifactPublication = { artifacts: [], failures: [] };
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
  const strategy = await readMastraStrategyProjection(context);
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

async function readMastraStrategyProjection(context: ServiceToolContext): Promise<StrategyYaml | null> {
  const rows = await db.select().from(mastraProjectProfiles).where(and(
    eq(mastraProjectProfiles.userId, context.userId),
    eq(mastraProjectProfiles.projectId, context.projectId || DEFAULT_PROJECT_ID),
    eq(mastraProjectProfiles.instanceId, context.instanceId),
  )).limit(1);
  if (!rows[0]) return null;
  try {
    const value = JSON.parse(rows[0].profileJson) as Record<string, unknown>;
    const profile = (value.profile && typeof value.profile === "object" ? value.profile : value) as Record<string, unknown>;
    return {
      profile: {
        style: typeof profile.style === "string" ? profile.style : undefined,
        selected_style_pack: typeof (profile.selected_style_pack ?? profile.selectedStylePack) === "string" ? (profile.selected_style_pack ?? profile.selectedStylePack) as string : undefined,
        risk_preference: typeof (profile.risk_preference ?? profile.riskPreference) === "string" ? (profile.risk_preference ?? profile.riskPreference) as string : undefined,
        investment_horizon: typeof (profile.investment_horizon ?? profile.investmentHorizon) === "string" ? (profile.investment_horizon ?? profile.investmentHorizon) as string : undefined,
        markets: Array.isArray(profile.markets) ? profile.markets as string[] : [],
      },
      allocation: (value.allocation && typeof value.allocation === "object" ? value.allocation : {}) as Record<string, unknown>,
      position_roles: (value.position_roles ?? value.positionRoles ?? {}) as Record<string, unknown>,
      buy_rules: Array.isArray(value.buy_rules ?? value.buyRules) ? (value.buy_rules ?? value.buyRules) as unknown[] : [],
      sell_rules: Array.isArray(value.sell_rules ?? value.sellRules) ? (value.sell_rules ?? value.sellRules) as unknown[] : [],
      rebalance_rules: Array.isArray(value.rebalance_rules ?? value.rebalanceRules) ? (value.rebalance_rules ?? value.rebalanceRules) as unknown[] : [],
      risk_rules: Array.isArray(value.risk_rules ?? value.riskRules) ? (value.risk_rules ?? value.riskRules) as unknown[] : [],
      do_not_do_rules: Array.isArray(value.do_not_do_rules ?? value.doNotDoRules) ? (value.do_not_do_rules ?? value.doNotDoRules) as string[] : [],
      decision_boundaries: (value.decision_boundaries ?? value.decisionBoundaries ?? {}) as Record<string, unknown>,
      notes: typeof value.notes === "string" ? value.notes : undefined,
      last_confirmed_at: rows[0].sourceRevision ?? undefined,
    };
  } catch (error) {
    throw new Error(`MASTRA_PROJECTION_INVALID: strategy profile payload is invalid: ${(error as Error).message}`);
  }
}

async function writeMastraStrategyProjection(context: ServiceToolContext, strategy: StrategyYaml): Promise<void> {
  const now = new Date().toISOString();
  const projectId = context.projectId || DEFAULT_PROJECT_ID;
  const existing = await db.select().from(mastraProjectProfiles).where(and(
    eq(mastraProjectProfiles.userId, context.userId), eq(mastraProjectProfiles.projectId, projectId), eq(mastraProjectProfiles.instanceId, context.instanceId),
  )).limit(1);
  // Merge with the raw existing payload so sibling projection domains stored
  // in the same row (for example tradingStrategies) survive strategy writes.
  let base: Record<string, unknown> = {};
  if (existing[0]) {
    try {
      const parsed = JSON.parse(existing[0].profileJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed;
    } catch {
      // Invalid existing payload: replace wholesale instead of failing the write.
    }
  }
  const payload = JSON.stringify({ ...base, ...strategy });
  const values = {
    userId: context.userId, projectId, instanceId: context.instanceId, profileJson: payload,
    sourcePath: "service-owned://strategy", sourceChecksum: `service:${now}`, sourceRevision: strategy.last_confirmed_at ?? now,
    migrationBatchId: "service-owned", createdAt: existing[0]?.createdAt ?? now, updatedAt: now,
  };
  if (existing[0]) await db.update(mastraProjectProfiles).set(values).where(and(
    eq(mastraProjectProfiles.userId, context.userId), eq(mastraProjectProfiles.projectId, projectId), eq(mastraProjectProfiles.instanceId, context.instanceId),
  ));
  else await db.insert(mastraProjectProfiles).values(values);
}

async function planMethodChangeApplication(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const candidateId = stringInput(input?.candidateId);
  if (!candidateId) throw new Error("candidateId 是必填项");
  const candidate = await methodChangeBackend.get(context.userId, context.instanceId, candidateId);
  if (!candidate) throw new Error("方法变更候选不存在");

  const current = await readMastraStrategyProjection(context);
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
  let saved = plan.current;
  let confirmedCandidate = plan.candidate;
  if (!plan.alreadyApplied) {
    const next = mergeStrategyPatch(plan.current, plan.patch, now, confirmation.confirmationId, candidateId);
    await writeMastraStrategyProjection(context, next);
    const savedStrategy = await readMastraStrategyProjection(context);
    if (
      savedStrategy?.last_confirmed_at !== now
      || savedStrategy.last_confirmation_id !== confirmation.confirmationId
      || savedStrategy.last_method_change_candidate_id !== candidateId
    ) {
      await writeMastraStrategyProjection(context, plan.current);
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
      await writeMastraStrategyProjection(context, plan.current);
      throw error;
    }
  }

  const appliedRevision = saved.last_confirmed_at ?? now;
  // (E8) workspace change-log append retired; the audit entry below is the durable record.
  await audit(context, {
    operation: "method_changes.apply",
    resourceType: "method_change_candidate",
    resourceId: candidateId,
    requestBody: input,
    resultSummary: `applied method change candidate fields=${plan.changedFields.join(",")}`,
  });
  // G17: config file snapshots are not user deliverables; mastra writes via projections.
  const publication = { artifacts: [], failures: [] };
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
  const store: UserPreferenceStore = new MastraUserPreferenceStore(context.userId, context.instanceId, context.projectId || DEFAULT_PROJECT_ID);
  const result = await applyUserPreferenceChange(store, userPreferenceChangeInput(input));
  if (store.appendChangeLogOnce) await store.appendChangeLogOnce({
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
  // G17: config file snapshots are not user deliverables; mastra writes via projections.
  const publication = { artifacts: [], failures: [] };
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
  const publishedAt = new Date().toISOString();
  {
    const projectId = context.projectId || DEFAULT_PROJECT_ID;
    for (const [index, record] of decisionRecords.entries()) {
      const payload = { ...record, source_review_date: resourceId, source_review_conversation_id: context.conversationId ?? null, recorded_at: record.recorded_at ?? publishedAt, record_index: index };
      db.$client.prepare("INSERT INTO mastra_review_memory_records (record_id,user_id,project_id,instance_id,record_type,business_key,payload_json,source_path,source_line,source_checksum,migration_batch_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(`decision-${context.userId}-${context.instanceId}-${resourceId}-${index}-${publishedAt}`, context.userId, projectId, context.instanceId, "service_event", `decision:${resourceId}:${index}:${publishedAt}`, JSON.stringify(payload), "service-owned://reviews", null, `service:${publishedAt}`, "service-owned", publishedAt);
    }
    for (const [index, record] of sourceEvents.entries()) {
      const payload = { ...record, source_review_date: resourceId, source_review_conversation_id: context.conversationId ?? null, recorded_at: record.recorded_at ?? publishedAt, record_index: index };
      db.$client.prepare("INSERT INTO mastra_review_memory_records (record_id,user_id,project_id,instance_id,record_type,business_key,payload_json,source_path,source_line,source_checksum,migration_batch_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(`source-event-${context.userId}-${context.instanceId}-${resourceId}-${index}-${publishedAt}`, context.userId, projectId, context.instanceId, "service_event", `source-event:${resourceId}:${index}:${publishedAt}`, JSON.stringify(payload), "service-owned://reviews", null, `service:${publishedAt}`, "service-owned", publishedAt);
    }
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
    artifact = await attachPublishedArtifactToUserFiles(published, context);
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
  const saveToMyFiles = input?.saveToMyFiles === true;
  const published = await publishConversationArtifact({
    userId: context.userId,
    instanceId: context.instanceId,
    relativePath,
    kind,
    title,
    saveToMyFiles,
    scope: {
      projectId: context.projectId || DEFAULT_PROJECT_ID,
      assistantId: context.instanceId,
      conversationId: context.conversationId ?? null,
      source: "artifacts.publish",
    },
  });
  const available = await attachPublishedArtifactToUserFiles(published, context);
  await audit(context, {
    operation: "artifacts.publish",
    resourceType: "conversation_artifact",
    resourceId: available.artifactId,
    requestBody: { relativePath, kind, title, saveToMyFiles },
    resultSummary: `published ${available.kind}/${available.previewMode} ${available.fileName}; assetId=${available.assetId ?? "none"}`,
  });
  return {
    ok: true,
    userId: context.userId,
    instanceId: context.instanceId,
    artifact: available,
  };
}

async function createSpreadsheetTool(input: Record<string, unknown> | undefined, context: ServiceToolContext) {
  const value = input ?? {};
  const fileName = stringInput(value.fileName);
  const columns = Array.isArray(value.columns) ? value.columns.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  const rows = Array.isArray(value.rows) ? value.rows : [];
  if (!fileName || !/^[^/\\]+\.xlsx$/i.test(fileName)) throw new UserAssetError("ASSET_INVALID_CONTENT", "fileName must be a plain .xlsx file name");
  if (columns.length < 1 || columns.length > 30) throw new UserAssetError("ASSET_INVALID_CONTENT", "columns must contain 1-30 labels");
  if (rows.length > 100) throw new UserAssetError("ASSET_INVALID_CONTENT", "rows may contain at most 100 records");
  for (const row of rows) if (!Array.isArray(row) || row.length > columns.length) throw new UserAssetError("ASSET_INVALID_CONTENT", "each row must be an array no wider than columns");

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Invest Agent (Mastra)";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("数据", { views: [{ state: "frozen", ySplit: 1 }] });
  const title = stringInput(value.title);
  if (title) sheet.addRow([title]);
  const header = sheet.addRow(columns);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1C7C7D" } };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  sheet.autoFilter = { from: { row: title ? 2 : 1, column: 1 }, to: { row: (title ? 2 : 1) + rows.length, column: columns.length } };
  for (const row of rows) sheet.addRow(row.map((cell: unknown) => cell === null || cell === undefined ? "" : typeof cell === "object" ? JSON.stringify(cell) : cell));
  if (title) {
    sheet.mergeCells(1, 1, 1, columns.length);
    sheet.getCell(1, 1).font = { bold: true, size: 14, color: { argb: "FF12343B" } };
  }
  for (let index = 1; index <= columns.length; index += 1) {
    const values = [columns[index - 1], ...rows.map((row) => row[index - 1])];
    const width = Math.min(42, Math.max(12, Math.max(...values.map((item) => String(item ?? "").length), 0) + 2));
    sheet.getColumn(index).width = width;
  }
  if (typeof value.notes === "string" && value.notes.trim()) {
    const noteRow = sheet.addRow([`备注：${value.notes.trim()}`]);
    sheet.mergeCells(noteRow.number, 1, noteRow.number, columns.length);
    noteRow.alignment = { wrapText: true, vertical: "top" };
  }
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const saved = await saveConversationArtifactAsUserAsset({
    ...assetScope(context),
    name: title || fileName.replace(/\.xlsx$/i, ""),
    fileName,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes,
    confirmedByUser: true,
    conversationId: context.conversationId ?? null,
    runId: context.runId ?? null,
    idempotencyKey: `spreadsheet:${context.conversationId ?? "unknown"}:${fileName}`,
  });
  await audit(context, { operation: "spreadsheet.create", resourceType: "user_asset", resourceId: saved.assetId, requestBody: { fileName, columns: columns.length, rows: rows.length }, resultSummary: `created xlsx asset=${saved.assetId}; bytes=${bytes.length}` });
  // Canonical delivery flow (same pipeline as reviews.save): the generated
  // workbook also lands in deliveries/ and is published as a conversation
  // artifact bound to the current turn, so the assistant reply carries the
  // standard artifact card with preview/download in the Portal. The durable
  // My Files entry is the user asset saved above and stays linked via
  // assetId/versionId. A publish failure must not fail the tool.
  let artifact: ConversationArtifact | undefined;
  try {
    const projectId = context.projectId || DEFAULT_PROJECT_ID;
    const projectRoot = await resolveProjectStorageRoot({ userId: context.userId, projectId, instanceId: context.instanceId });
    const deliveryDir = path.join(projectRoot, "deliveries");
    await mkdir(deliveryDir, { recursive: true });
    await writeFile(path.join(deliveryDir, fileName), bytes);
    const published = await publishConversationArtifact({
      userId: context.userId,
      instanceId: context.instanceId,
      relativePath: `deliveries/${fileName}`,
      kind: "data",
      title: title || fileName.replace(/\.xlsx$/i, ""),
      assetId: saved.assetId,
      versionId: saved.currentVersion?.versionId ?? null,
      idempotencyKey: `spreadsheet-artifact:${context.conversationId ?? "unknown"}:${fileName}`,
      scope: {
        projectId,
        assistantId: context.instanceId,
        conversationId: context.conversationId ?? null,
        source: "artifacts.publish",
      },
    });
    artifact = published;
  } catch (error) {
    await audit(context, {
      operation: "spreadsheet.create",
      resourceType: "conversation_artifact",
      requestBody: { artifactPublish: "failed", fileName },
      resultSummary: `artifact publish skipped: ${(error as Error).message}`,
      status: "error",
    }).catch(() => undefined);
  }
  return {
    ok: true,
    asset: publicAssetDescriptor(saved),
    version: saved.currentVersion ? publicAssetVersion(saved.currentVersion) : null,
    artifact,
    fileName,
    rows: rows.length,
    columns: columns.length,
    delivery: {
      location: "portal_my_files",
      instruction: "文件已生成：用户资产库存有持久副本，且服务已自动发布附件卡片挂在本次回复下方（含预览/下载）。回复正文告知文件已生成并给出文件名即可；不要在正文放置任何下载链接或路径。",
    },
  };
}

async function attachPublishedArtifactToUserFiles(
  published: ConversationArtifactRecord,
  context: ServiceToolContext,
): Promise<ConversationArtifactRecord> {
  if (published.assetId && published.versionId) return published;
  if (published.retentionClass !== "durable_library" || published.visibility !== "library") return published;

  return withResourceMutationLock(
    { userId: published.userId, instanceId: published.instanceId },
    `artifact-user-file:${published.relativePath}`,
    async () => {
      const [previous] = await db.select({ assetId: conversationArtifacts.assetId })
        .from(conversationArtifacts)
        .where(and(
          eq(conversationArtifacts.userId, published.userId),
          eq(conversationArtifacts.projectId, published.scope.projectId),
          eq(conversationArtifacts.instanceId, published.instanceId),
          eq(conversationArtifacts.relativePath, published.relativePath),
          isNotNull(conversationArtifacts.assetId),
        ))
        .orderBy(desc(conversationArtifacts.updatedAt))
        .limit(1);
      const { payload } = await readConversationArtifactPayload({
        artifactId: published.artifactId,
        userId: published.userId,
        instanceId: published.instanceId,
      });
      const save = (assetId?: string) => saveConversationArtifactAsUserAsset({
        userId: published.userId,
        projectId: published.scope.projectId,
        instanceId: published.instanceId,
        assetId,
        name: published.title,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        bytes: Buffer.from(payload.base64, "base64"),
        confirmedByUser: true,
        conversationId: context.conversationId ?? published.scope.conversationId ?? null,
        idempotencyKey: `artifact-user-file:${published.artifactId}`,
      });

      let saved;
      try {
        saved = await save(previous?.assetId ?? undefined);
      } catch (error) {
        if (!previous?.assetId || !(error instanceof UserAssetError) || !["ASSET_ARCHIVED", "ASSET_NOT_FOUND"].includes(error.code)) {
          throw error;
        }
        saved = await save();
      }
      const versionId = saved.currentVersionId;
      if (!versionId) throw new UserAssetError("ASSET_COMMIT_FAILED", "published artifact has no current version");

      await db.update(conversationArtifacts)
        .set({ assetId: saved.assetId, versionId })
        .where(and(
          eq(conversationArtifacts.artifactId, published.artifactId),
          eq(conversationArtifacts.userId, published.userId),
          eq(conversationArtifacts.projectId, published.scope.projectId),
          eq(conversationArtifacts.instanceId, published.instanceId),
        ));
      if (published.retentionClass === "durable_library" && published.kind === "report") {
        await registerReportAssetMapping({
          userId: published.userId,
          projectId: published.scope.projectId,
          instanceId: published.instanceId,
          reportId: published.artifactId,
          title: published.title,
          fileName: published.fileName,
          mimeType: published.mimeType,
          sizeBytes: published.sizeBytes,
          backingAssetId: saved.assetId,
          backingVersionId: versionId,
          readPath: published.relativePath,
        });
      }
      return { ...published, assetId: saved.assetId, versionId };
    },
  );
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

  const current = readMastraPortfolioProjection(context.userId, context.instanceId) as PortfolioYaml;
  const currentRevision = getMastraPortfolioRevision(context.userId, context.instanceId);
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
  const existing = readMastraPortfolioProjection(context.userId, context.instanceId) as PortfolioYaml;
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
  // E8: mastra projection is the only portfolio write path; the workspace
  // change-log append retired with the backend (audit entry below is the record).
  replaceMastraPortfolioProjection(context.userId, context.instanceId, saved as Record<string, unknown>, plan.expectedLastConfirmedAt);
  await confirmation.consume();
  await audit(context, {
    operation: "portfolio.apply_changes",
    resourceType: "portfolio",
    resourceId: context.instanceId,
    requestBody: input,
    resultSummary: `removedHoldings=${plan.removedHoldings.length}; upsertedHoldings=${plan.upsertedHoldings.length}; removedWatchlist=${plan.removedWatchlist.length}; totalPercent=${plan.allocation.totalPercent ?? "unknown"}`,
  });
  // G17: portfolio.yaml snapshot delivery retired with the workspace backend (E8).
  const artifact: ConversationArtifact | undefined = undefined;
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
  options: { required?: boolean; idempotencyKey?: string } = {},
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
        idempotencyKey: options.idempotencyKey
          ? `${options.idempotencyKey}:${spec.relativePath}`
          : undefined,
      });
      const injectedAfterPublishError = serviceToolFailureInjection.artifactPublishAfter?.(spec.relativePath, published);
      if (injectedAfterPublishError) throw injectedAfterPublishError;
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
  "assets.delete",
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
    const store: UserPreferenceStore = new MastraUserPreferenceStore(context.userId, context.instanceId, context.projectId || DEFAULT_PROJECT_ID);
    const plan = await planUserPreferenceChange(store, userPreferenceChangeInput(payload));
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
    "assets.delete": "user_asset",
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
        : operation === "assets.delete"
          ? stringInput(payload.assetId) || context.instanceId
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
    backend: "mastra",
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
      backend: "mastra",
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
