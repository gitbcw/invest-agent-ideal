import { and, eq } from "drizzle-orm";
import { getToolManifest, type ToolManifestItem } from "./tool-manifest.js";
import { db } from "../db/index.js";
import { alerts } from "../db/schema.js";
import { dailyPlanBackend } from "../lib/daily-plan-backend.js";
import { planBackend, portfolioBackend, watchlistBackend } from "../lib/data-backend.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, type UserContext } from "../lib/user-context.js";
import { resolveWorkspacePath } from "../lib/workspace.js";
import { loadRecentWeixinMemory, type ConversationMessage } from "../lib/weixin-conversation-memory.js";
import { listPendingConfirmations } from "./pending-state.js";

export interface ContextPacket {
  user: {
    userId: string;
    instanceId: string;
    projectId?: string;
    conversationId?: string;
    channel: "weixin-mobile" | "dashboard" | "api";
  };
  workspace: {
    path?: string;
    projectType?: string;
    skillBundleId?: string;
    strategySkillId?: string;
  };
  recentConversation: ConversationMessage[];
  pendingConfirmations: Array<{
    kind: "alert_draft" | "plan_draft" | "investment_model_draft" | "tool_write_draft";
    summary: string;
    expiresAt?: string;
  }>;
  latestArtifacts: Array<{
    kind: "daily_review" | "analysis" | "screening";
    date?: string;
    title: string;
    summary: string;
  }>;
  stateSummary: {
    portfolioCount: number;
    watchlistCount: number;
    alertCount: number;
    planCount: number;
    latestReviewDate?: string;
  };
  toolManifest: ToolManifestItem[];
}

export interface BuildContextPacketOptions {
  recentLimit?: number;
  pendingConfirmations?: ContextPacket["pendingConfirmations"];
}

export async function buildContextPacket(
  userContext: UserContext,
  options: BuildContextPacketOptions = {}
): Promise<ContextPacket> {
  const userId = userContext.userId;
  const instanceId = userContext.instanceId || DEFAULT_INSTANCE_ID;
  const channel = userContext.channel || "api";
  const [recentConversation, stateSummary, latestArtifacts] = await Promise.all([
    loadRecentWeixinMemory(userContext, options.recentLimit ?? 12).catch(() => []),
    buildStateSummary(userId, instanceId),
    buildLatestArtifacts(userId, instanceId),
  ]);

  return {
    user: {
      userId,
      instanceId,
      projectId: userContext.projectId || DEFAULT_PROJECT_ID,
      conversationId: userContext.conversationId,
      channel,
    },
    workspace: {
      path: userContext.workspacePath || safeWorkspacePath(userId),
      projectType: userContext.projectType,
      skillBundleId: userContext.skillBundleId,
      strategySkillId: userContext.strategySkillId,
    },
    recentConversation,
    pendingConfirmations: mergePendingConfirmations(listPendingConfirmations(userContext), options.pendingConfirmations ?? []),
    latestArtifacts,
    stateSummary,
    toolManifest: getToolManifest(),
  };
}

function mergePendingConfirmations(
  fromStore: ContextPacket["pendingConfirmations"],
  fromCaller: ContextPacket["pendingConfirmations"]
) {
  const merged = new Map<string, ContextPacket["pendingConfirmations"][number]>();
  for (const item of [...fromStore, ...fromCaller]) {
    merged.set(`${item.kind}:${item.summary}`, item);
  }
  return [...merged.values()];
}

async function buildStateSummary(userId: string, instanceId: string): Promise<ContextPacket["stateSummary"]> {
  const [portfolio, watchlist, plans, alertRows, latestReview] = await Promise.all([
    portfolioBackend.listActive(userId, instanceId).catch(() => []),
    watchlistBackend.list(userId, instanceId).catch(() => []),
    planBackend.list(userId, instanceId).catch(() => []),
    db.select().from(alerts).where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId))).catch(() => []),
    dailyPlanBackend.getLatest(userId, instanceId).catch(() => null),
  ]);
  return {
    portfolioCount: portfolio.length,
    watchlistCount: watchlist.length,
    alertCount: alertRows.length,
    planCount: plans.length,
    latestReviewDate: latestReview?.planDate,
  };
}

async function buildLatestArtifacts(userId: string, instanceId: string): Promise<ContextPacket["latestArtifacts"]> {
  const latestReview = await dailyPlanBackend.getLatest(userId, instanceId).catch(() => null);
  if (!latestReview) return [];
  return [{
    kind: "daily_review",
    date: latestReview.planDate,
    title: `${latestReview.planDate} 日复盘`,
    summary: compactSummary(latestReview.summary || latestReview.content),
  }];
}

function compactSummary(value: string) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function safeWorkspacePath(userId: string) {
  try {
    return resolveWorkspacePath(userId);
  } catch {
    return undefined;
  }
}
