/**
 * Mastra in-process 工具面（阶段 1）
 *
 * 工具的 schema / description / annotations 单一真住在 `./tool-specs.js`
 * （与 MCP stdio server 共享）；本文件只声明 Mastra agent 暴露哪些工具
 * （T-400 两段式发现后的精选子集 + spreadsheet 桥接对）。
 * 业务逻辑零迁移：每个工具的 execute 直接调 `callServiceTool(name, input, context)`，
 * "怎么执行"（callServiceTool + scope guard + requestContext 注入）在 index.ts。
 */

import { ALL_SERVICE_TOOL_SPECS, type ToolSpec } from "./tool-specs.js";

export type { ToolSpec } from "./tool-specs.js";

/**
 * Mastra agent 暴露的工具面。新增/移除工具只改这个 id 集合；
 * 工具本身的定义改动一律去 tool-specs.ts。
 */
const MASTRA_EXPOSED_TOOL_IDS: ReadonlySet<string> = new Set([
  "file.parse",
  "research.news_search",
  "research.web_search",
  "research.web_read",
  "assets.list",
  "automation.list",
  "automation.get",
  "automation.create",
  "automation.update",
  "automation.activate",
  "automation.pause",
  "automation.delete",
  "assets.version.read",
  "assets.version.commit",
  "assets.working_copy.read",
  "assets.conversation.save",
  "assets.attachment.save",
  "assets.rename",
  "assets.archive",
  "assets.delete",
  "portfolio.read",
  "watchlist.read",
  "plans.read",
  "conversation.history",
  "confirmations.pending",
  "confirmations.request",
  "portfolio.apply_changes",
  "watchlist.add",
  "watchlist.add_many",
  "plans.set",
  "plans.watch_conditions",
  "method_changes.propose",
  "method_changes.apply",
  "preferences.apply",
  "reviews.save",
  "artifacts.publish",
  "spreadsheet.create",
  "spreadsheet.transform",
  "watch_rules.catalog",
  "watch_rules.list",
  "watch_rules.validate",
  "watch_rules.dry_run",
  "watch_rules.create",
  "onboarding.confirm_portfolio",
  "onboarding.draft.get",
  "onboarding.draft.upsert_step",
  "onboarding.draft.request_confirmation",
  // T-540 纠错候选：交互会话内可提出/修订草案（approve 永不暴露）。
  "state.candidate.propose",
  "state.candidate.revise",
  // 交互会话内按用户确认的内容创建私有 Skill 草案（批准权在 Portal）。
  "skill.create",
  // 对话 Agent 技能管理（2026-10-08 裁决）：启用/安装/编辑/创建无需确认；
  // 停用/卸载走 confirmations.request 确认流。
  "skill.list",
  "skill.install",
  "skill.set_enabled",
  "skill.uninstall",
  "skill.edit",
  // 「我的策略」域（2026-10-08 owner 裁决）：策略=规则/口径/风控，主策略唯一
  // 常驻；切换主策略走确认流。
  "strategy.list",
  "strategy.create",
  "strategy.edit",
  "strategy.read",
  "strategy.set_primary",
]);

/** Mastra 工具面（ALL_SERVICE_TOOL_SPECS 的精选子集，保持原展示顺序）。 */
export const TOOL_SPECS: readonly ToolSpec[] = ALL_SERVICE_TOOL_SPECS.filter((spec) =>
  MASTRA_EXPOSED_TOOL_IDS.has(spec.id)
);

export const TOOL_IDS: readonly string[] = TOOL_SPECS.map((spec) => spec.id);
