import type { SandboxContext, SandboxPermission } from "../lib/sandbox-context.js";
import { ALLOWED_SANDBOX_TOOLS } from "./project-registry.js";

export type ToolId =
  | "invest.dashboard.read"
  | "invest.portfolio.read"
  | "invest.portfolio.write"
  | "invest.watchlist.read"
  | "invest.watchlist.write"
  | "invest.plan.read"
  | "invest.plan.write"
  | "invest.profile.read"
  | "invest.profile.write"
  | "invest.review.read"
  | "invest.review.write"
  | "invest.alert.read"
  | "invest.alert.write"
  | "invest.alert.check"
  | "invest.strategy.read"
  | "invest.strategy.write"
  | "push.weixin.send";

export interface ToolDefinition {
  id: ToolId;
  displayName: string;
  description: string;
  requiredPermissions: SandboxPermission[];
  resourceType: string;
  risk: "read" | "write" | "push";
}

const toolDefinitions: ToolDefinition[] = [
  {
    id: "invest.dashboard.read",
    displayName: "读取投资看板",
    description: "读取项目范围内的持仓、自选、预案、提醒、复盘和追踪摘要。",
    requiredPermissions: ["read:self"],
    resourceType: "dashboard",
    risk: "read",
  },
  {
    id: "invest.portfolio.read",
    displayName: "读取持仓池",
    description: "读取项目范围内的持仓池。",
    requiredPermissions: ["read:self"],
    resourceType: "portfolio",
    risk: "read",
  },
  {
    id: "invest.portfolio.write",
    displayName: "写入持仓池",
    description: "新增或移除项目范围内的持仓池条目。",
    requiredPermissions: ["write:self"],
    resourceType: "portfolio",
    risk: "write",
  },
  {
    id: "invest.watchlist.read",
    displayName: "读取自选池",
    description: "读取项目范围内的自选池。",
    requiredPermissions: ["read:self"],
    resourceType: "watchlist",
    risk: "read",
  },
  {
    id: "invest.watchlist.write",
    displayName: "写入自选池",
    description: "新增或移除项目范围内的自选池条目。",
    requiredPermissions: ["write:self"],
    resourceType: "watchlist",
    risk: "write",
  },
  {
    id: "invest.plan.read",
    displayName: "读取交易预案",
    description: "读取项目范围内的交易预案。",
    requiredPermissions: ["read:self"],
    resourceType: "stock_plan",
    risk: "read",
  },
  {
    id: "invest.plan.write",
    displayName: "写入交易预案",
    description: "新增、更新或删除项目范围内的交易预案和观察条件。",
    requiredPermissions: ["write:self"],
    resourceType: "stock_plan",
    risk: "write",
  },
  {
    id: "invest.profile.read",
    displayName: "读取投资 Profile",
    description: "读取项目范围内的用户投资风格、方法论、通知策略和方法变更候选。",
    requiredPermissions: ["read:self"],
    resourceType: "investment_profile",
    risk: "read",
  },
  {
    id: "invest.profile.write",
    displayName: "写入投资 Profile",
    description: "新增或更新项目范围内的用户投资风格、方法论和方法变更候选。",
    requiredPermissions: ["write:self"],
    resourceType: "investment_profile",
    risk: "write",
  },
  {
    id: "invest.review.read",
    displayName: "读取复盘上下文",
    description: "读取项目范围内的复盘上下文和历史复盘。",
    requiredPermissions: ["review:self"],
    resourceType: "daily_review",
    risk: "read",
  },
  {
    id: "invest.review.write",
    displayName: "生成或保存复盘",
    description: "生成或保存项目范围内的复盘内容。",
    requiredPermissions: ["review:self"],
    resourceType: "daily_review",
    risk: "write",
  },
  {
    id: "invest.alert.read",
    displayName: "读取提醒",
    description: "读取项目范围内的提醒规则和提醒事件。",
    requiredPermissions: ["alert:self"],
    resourceType: "alert_rule",
    risk: "read",
  },
  {
    id: "invest.alert.write",
    displayName: "写入提醒",
    description: "新增、更新、关闭或删除项目范围内的提醒规则。",
    requiredPermissions: ["alert:self", "write:self"],
    resourceType: "alert_rule",
    risk: "write",
  },
  {
    id: "invest.alert.check",
    displayName: "执行提醒巡检",
    description: "对项目范围内的持仓、自选和提醒规则执行一次巡检。",
    requiredPermissions: ["alert:self"],
    resourceType: "alert_check",
    risk: "read",
  },
  {
    id: "invest.strategy.read",
    displayName: "读取交易策略",
    description: "读取项目范围内的交易策略列表(workspace/config/trading_strategies.yaml)。",
    requiredPermissions: ["read:self"],
    resourceType: "trading_strategy",
    risk: "read",
  },
  {
    id: "invest.strategy.write",
    displayName: "写入交易策略",
    description: "新增、更新或删除项目范围内的交易策略。删除走二次确认。",
    requiredPermissions: ["write:self"],
    resourceType: "trading_strategy",
    risk: "write",
  },
  {
    id: "push.weixin.send",
    displayName: "发送微信推送",
    description: "向项目绑定的微信通道发送提醒或复盘消息。",
    requiredPermissions: ["push:self"],
    resourceType: "weixin_push",
    risk: "push",
  },
];

const toolMap = new Map<ToolId, ToolDefinition>(toolDefinitions.map((tool) => [tool.id, tool]));

export function listToolDefinitions() {
  return toolDefinitions.map((tool) => ({ ...tool, requiredPermissions: [...tool.requiredPermissions] }));
}

export function getToolDefinition(toolId: ToolId) {
  return toolMap.get(toolId);
}

export function assertSandboxToolAllowed(context: SandboxContext, toolId: ToolId, extraPermissions: SandboxPermission[] = []) {
  const tool = getToolDefinition(toolId);
  if (!tool) {
    throw new Error("SANDBOX_TOOL_UNKNOWN");
  }

  if (!ALLOWED_SANDBOX_TOOLS.includes(toolId)) {
    throw new Error("SANDBOX_TOOL_NOT_ALLOWED");
  }

  for (const permission of [...tool.requiredPermissions, ...extraPermissions]) {
    if (!context.permissions.includes(permission)) {
      throw new Error("SANDBOX_PERMISSION_DENIED");
    }
  }
}
