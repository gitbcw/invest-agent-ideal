/**
 * Registered scheduled task types (generic capability of the system).
 *
 * A task type binds a scheduled automation task to its grant table entry
 * (`SCHEDULED_FINAL_ACTIONS` in mcp/service-tool-classification.ts uses the
 * same ids), a default instruction, and a completion contract. The system
 * provides the registry; what a user actually runs is decided by presets
 * (services/presets.ts) or their own task configuration — per the
 * "generic capabilities + personalized configuration" principle.
 */

export interface ScheduledTaskTypeDefinition {
  /** Matches SCHEDULED_FINAL_ACTIONS keys; also drives scheduled grants. */
  id: string;
  name: string;
  description: string;
  /** What completing this task means; enforced contract wording for the agent. */
  completionContract: string;
  /** Default instruction used when a task instance does not override it. */
  defaultInstruction: string;
}

const DAILY_REVIEW_INSTRUCTION = [
  "你正在执行当前用户的自动日复盘。",
  "研究用户持仓、自选股、预案和当日提醒后生成收盘复盘。",
  "发布是本任务唯一完成路径：完成研究后必须调用 reviews.save，content 放完整 Markdown，pushBrief 放独立的微信简报。",
  "不要把未保存的复盘草稿、摘要或自然语言最终回复当作完成。若 reviews.save 未成功，停止，不得输出任何面向用户的复盘内容。",
].join("\n");

const PERIODIC_REVIEW_INSTRUCTION = [
  "你正在执行当前用户的周期复盘（周或月）。",
  "基于区间内日复盘、提醒事件与观点追踪，生成周期复盘并回测此前的判断。",
  "发布是本任务唯一完成路径：完成研究后必须调用 reviews.save，content 放完整 Markdown，pushBrief 放独立的微信简报。",
  "不要把未保存的复盘草稿、摘要或自然语言最终回复当作完成。若 reviews.save 未成功，停止，不得输出任何面向用户的复盘内容。",
].join("\n");

const MARKET_WATCH_INSTRUCTION = [
  "你正在生成当前用户的盘中定时简报。",
  "market-watch 是盘中定时简报/摘要任务，不是明确规则巡检；明确规则巡检只由规则巡检机制执行。",
  "是否推送、推送频率、推送内容和提醒边界均以服务端读取的用户配置为准。",
  "行情事实必须来自实时数据：使用外部 market-data MCP 工具（如实时行情、市场总览、资金流）获取当前时点数据；没有实时数据时明确说明数据缺口，不得用过期数据充当当日行情。",
  "无值得打扰用户的内容时，精确输出 NO_PUSH；不要为了完成任务而生成空洞简报。",
].join("\n");

export const SCHEDULED_TASK_TYPES: Record<string, ScheduledTaskTypeDefinition> = {
  "scheduled-daily-review": {
    id: "scheduled-daily-review",
    name: "日复盘",
    description: "交易日收盘后生成当日复盘并保存发布",
    completionContract: "reviews.save 成功即完成；失败则不得输出用户内容",
    defaultInstruction: DAILY_REVIEW_INSTRUCTION,
  },
  "scheduled-weekly-review": {
    id: "scheduled-weekly-review",
    name: "周复盘",
    description: "每周生成周度复盘并保存发布",
    completionContract: "reviews.save 成功即完成；失败则不得输出用户内容",
    defaultInstruction: PERIODIC_REVIEW_INSTRUCTION,
  },
  "scheduled-monthly-review": {
    id: "scheduled-monthly-review",
    name: "月复盘",
    description: "每月生成月度复盘并保存发布",
    completionContract: "reviews.save 成功即完成；失败则不得输出用户内容",
    defaultInstruction: PERIODIC_REVIEW_INSTRUCTION,
  },
  "scheduled-market-watch": {
    id: "scheduled-market-watch",
    name: "盘中盯盘",
    description: "交易日的指定时段生成盘中简报，按用户投递策略决定是否推送",
    completionContract: "可投递正文或精确 NO_PUSH 二选一",
    defaultInstruction: MARKET_WATCH_INSTRUCTION,
  },
};

export function isRegisteredScheduledTaskType(id: string | undefined | null): boolean {
  return typeof id === "string" && Object.hasOwn(SCHEDULED_TASK_TYPES, id);
}

export function getScheduledTaskType(id: string): ScheduledTaskTypeDefinition {
  const definition = SCHEDULED_TASK_TYPES[id];
  if (!definition) throw new Error(`SCHEDULED_TASK_TYPE_UNKNOWN: ${id}`);
  return definition;
}
