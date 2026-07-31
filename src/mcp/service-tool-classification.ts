/**
 * 服务 MCP 工具分类与定时任务授权 (F1)
 *
 * 这是 service MCP 工具风险分类的**单一真相**，同时驱动工具注册提示和定时任务
 * 的有效授权计算。避免维护两份漂移的工具清单。
 *
 * 分类语义:
 *   - read: 只读，无副作用（行情/研究/持仓观察/计划读取/会话历史/规则目录等）
 *   - final-action: 任务唯一最终动作（复盘保存/报告发布）
 *   - other-write: 其他写操作（持仓变更/观察添加/计划设置/onboarding/确认/规则创建等）
 *
 * 定时任务的授权 = scope reads（全部 read 工具）+ 该任务的 final-action。
 * 这保证后台任务不会发现与本任务无关的写工具（portfolio/onboarding/rule mutation 等）。
 */

export type ServiceToolClass = "read" | "final-action" | "other-write";

/** 服务 MCP 工具的风险分类单一真相。 */
export const SERVICE_TOOL_CLASSIFICATION: Record<string, ServiceToolClass> = {
  // ── read: 历史市场观察记录、研究证据、用户状态 ──
  "market_watch.snapshot": "read",
  "research.news_search": "read",
  "research.web_search": "read",
  "research.web_read": "read",
  // ── read: 用户状态与上下文 (9) ──
  "portfolio.read": "read",
  "watchlist.read": "read",
  "plans.read": "read",
  "conversation.history": "read",
  "confirmations.pending": "read",
  "watch_rules.catalog": "read",
  "watch_rules.list": "read",
  "watch_rules.validate": "read",
  "watch_rules.dry_run": "read",
  // ── final-action: 任务唯一最终动作 (1) ──
  "reviews.save": "final-action",
  // ── other-write: 持仓/观察/计划/方法变更 (6) ──
  "portfolio.apply_changes": "other-write",
  "watchlist.add": "other-write",
  "plans.set": "other-write",
  "plans.watch_conditions": "other-write",
  "method_changes.propose": "other-write",
  "watch_rules.create": "other-write",
  // ── other-write: 确认与发布 (2) ──
  "confirmations.request": "other-write",
  "artifacts.publish": "other-write",
  // ── other-write: onboarding 族 (10) ──
  "onboarding.confirm_portfolio": "other-write",
  "onboarding.confirm_step": "other-write",
  "onboarding.complete_watch_setup": "other-write",
  "onboarding.draft.get": "other-write",
  "onboarding.draft.upsert_step": "other-write",
  "onboarding.draft.request_confirmation": "other-write",
  "onboarding.draft.accept_step": "other-write",
  "onboarding.draft.skip_watch_rules": "other-write",
  "onboarding.draft.enqueue_commit": "other-write",
  "onboarding.draft.commit_status": "other-write",
};

/** 查表分类；未知工具默认归 other-write（保守）。 */
export function classifyServiceTool(name: string): ServiceToolClass {
  return SERVICE_TOOL_CLASSIFICATION[name] ?? "other-write";
}

/** 全部只读服务工具（定时任务的 scope reads 基线）。 */
export const READ_TOOLS: string[] = Object.entries(SERVICE_TOOL_CLASSIFICATION)
  .filter(([, cls]) => cls === "read")
  .map(([name]) => name)
  .sort();

/** 全部其他写工具（定时任务不应看到这些）。 */
export const OTHER_WRITE_TOOLS: string[] = Object.entries(SERVICE_TOOL_CLASSIFICATION)
  .filter(([, cls]) => cls === "other-write")
  .map(([name]) => name)
  .sort();

/** 全部 final-action 工具。 */
export const FINAL_ACTION_TOOLS: string[] = Object.entries(SERVICE_TOOL_CLASSIFICATION)
  .filter(([, cls]) => cls === "final-action")
  .map(([name]) => name)
  .sort();

/**
 * 每类定时任务可授权的 final-action。
 * market-watch 无服务写动作；daily 授权 reviews.save；
 * weekly/monthly 在 F1 只 scope reads（F2 引入保存动作后更新）。
 */
const SCHEDULED_FINAL_ACTIONS: Record<string, string[]> = {
  "scheduled-market-watch": [],
  "scheduled-daily-review": ["reviews.save"],
  "scheduled-weekly-review": ["reviews.save"],
  "scheduled-monthly-review": ["reviews.save"],
};

/**
 * 计算定时任务的有效 service tool 授权。
 * = scope reads（全部 read 工具）+ 该任务的 final-action。
 * 未知 taskType 兜底返回只读（保守：只读不写）。
 */
export function resolveScheduledServiceGrant(taskType: string): string[] {
  const finalActions = SCHEDULED_FINAL_ACTIONS[taskType];
  if (finalActions === undefined) {
    // 未知 scheduled taskType：保守只读，不授权任何写动作
    return [...READ_TOOLS];
  }
  return [...READ_TOOLS, ...finalActions];
}

/**
 * R2: 判断 taskType 是否属于 scheduled（前缀级 fail closed）。
 * 任何以 "scheduled-" 开头的 taskType 都走 grant 计算（已知类型有 final-action，
 * 未知类型 resolveScheduledServiceGrant 返回只读兜底）。这保证未来新增的 scheduled
 * 任务不会因不在表里而获得全工具（空 allowlist）。
 */
export function isScheduledTaskType(taskType: string | undefined): boolean {
  return Boolean(taskType && taskType.startsWith("scheduled-"));
}
