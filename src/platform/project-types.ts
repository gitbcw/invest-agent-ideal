import type { SandboxPermission } from "../lib/sandbox-context.js";
import {
  DIET_RECOMMENDATION_SKILL_BUNDLE_ID,
  INVEST_AGENT_SKILL_BUNDLE_ID,
} from "./skill-bundles.js";

export type ProjectDashboardType = "invest-agent" | "generic";

export interface ProjectTypeManifest {
  id: string;
  displayName: string;
  description: string;
  defaultSkillBundleId: string;
  defaultHermesProfile: string;
  dashboardType: ProjectDashboardType;
  allowedTools: string[];
  defaultPermissions: SandboxPermission[];
  resourceTypes: string[];
}

export interface ProjectTypeManifestSummary {
  id: string;
  displayName: string;
  defaultSkillBundleId: string;
  defaultHermesProfile: string;
  dashboardType: ProjectDashboardType;
  allowedTools: string[];
  defaultPermissions: SandboxPermission[];
  resourceTypes: string[];
}

export const INVEST_AGENT_PROJECT_TYPE_ID = "invest-agent";
export const INVEST_AGENT_DEFAULT_SKILL_BUNDLE_ID = INVEST_AGENT_SKILL_BUNDLE_ID;
export const DIET_RECOMMENDATION_PROJECT_TYPE_ID = "diet-recommendation";
export const DIET_RECOMMENDATION_DEFAULT_SKILL_BUNDLE_ID = DIET_RECOMMENDATION_SKILL_BUNDLE_ID;

export const INVEST_AGENT_PROJECT_TYPE: ProjectTypeManifest = {
  id: INVEST_AGENT_PROJECT_TYPE_ID,
  displayName: "投资助手",
  description: "微信优先的投资决策辅助 AI 项目类型，负责巡检、复盘、选股问答、提醒和预案闭环。",
  defaultSkillBundleId: INVEST_AGENT_DEFAULT_SKILL_BUNDLE_ID,
  defaultHermesProfile: "invest-agent",
  dashboardType: "invest-agent",
  allowedTools: [
    "invest.dashboard.read",
    "invest.portfolio.read",
    "invest.portfolio.write",
    "invest.watchlist.read",
    "invest.watchlist.write",
    "invest.plan.read",
    "invest.plan.write",
    "invest.profile.read",
    "invest.profile.write",
    "invest.review.read",
    "invest.review.write",
    "invest.alert.read",
    "invest.alert.write",
    "invest.alert.check",
    "invest.strategy.read",
    "invest.strategy.write",
    "push.weixin.send",
  ],
  defaultPermissions: ["read:self", "write:self", "review:self", "alert:self", "push:self"],
  resourceTypes: [
    "portfolio",
    "watchlist",
    "stock_plan",
    "investment_profile",
    "methodology_profile",
    "method_change_candidate",
    "alert_rule",
    "alert_event",
    "daily_review",
    "indicator_result",
    "conversation_trace",
    "trading_strategy",
  ],
};

export const DIET_RECOMMENDATION_PROJECT_TYPE: ProjectTypeManifest = {
  id: DIET_RECOMMENDATION_PROJECT_TYPE_ID,
  displayName: "饮食推荐助手",
  description: "面向多用户的饮食建议 AI 项目类型，使用同一套饮食推荐 skill，根据每个微信用户的偏好和目标给出谨慎建议。",
  defaultSkillBundleId: DIET_RECOMMENDATION_DEFAULT_SKILL_BUNDLE_ID,
  defaultHermesProfile: "diet-recommendation",
  dashboardType: "generic",
  allowedTools: [
    "push.weixin.send",
  ],
  defaultPermissions: ["read:self", "push:self"],
  resourceTypes: [
    "diet_preference",
    "meal_suggestion",
    "nutrition_note",
    "conversation_trace",
  ],
};

const manifests = new Map<string, ProjectTypeManifest>([
  [INVEST_AGENT_PROJECT_TYPE.id, INVEST_AGENT_PROJECT_TYPE],
  [DIET_RECOMMENDATION_PROJECT_TYPE.id, DIET_RECOMMENDATION_PROJECT_TYPE],
]);

export function getProjectTypeManifest(projectTypeId?: string | null): ProjectTypeManifest {
  if (projectTypeId && manifests.has(projectTypeId)) {
    return manifests.get(projectTypeId)!;
  }
  return INVEST_AGENT_PROJECT_TYPE;
}

export function summarizeProjectTypeManifest(manifest: ProjectTypeManifest): ProjectTypeManifestSummary {
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    defaultSkillBundleId: manifest.defaultSkillBundleId,
    defaultHermesProfile: manifest.defaultHermesProfile,
    dashboardType: manifest.dashboardType,
    allowedTools: [...manifest.allowedTools],
    defaultPermissions: [...manifest.defaultPermissions],
    resourceTypes: [...manifest.resourceTypes],
  };
}
