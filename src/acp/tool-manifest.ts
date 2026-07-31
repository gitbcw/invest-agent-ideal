export type ToolPolicyClass = "read" | "draft" | "write" | "async" | "reject";

export interface ToolManifestItem {
  name: string;
  policy: ToolPolicyClass;
  description: string;
  notes?: string[];
}

const TOOL_MANIFEST: ToolManifestItem[] = [
  { name: "portfolio.query", policy: "read", description: "查看持仓、仓位、持有股票" },
  { name: "portfolio.add", policy: "write", description: "把 AI 已明确绑定到 stocks 的股票加入持有股票池；写入前需要确认" },
  { name: "portfolio.remove", policy: "write", description: "把 AI 已明确绑定到 stocks 的股票移出持有股票池；写入前需要确认" },
  { name: "portfolio.update_cost", policy: "write", description: "更新持有股票池中某只股票的每股成本价，不记录数量或金额" },
  { name: "watchlist.query", policy: "read", description: "查看自选、自选股、自选池" },
  { name: "alerts.query", policy: "read", description: "查看提醒、提醒列表、预警规则" },
  { name: "plans.query", policy: "read", description: "查看预案、交易预案（某只股票的具体支撑/压力/目标/止损计划）" },
  {
    name: "strategies.query",
    policy: "read",
    description: "查看**交易策略**(用户在 trading_strategies.yaml 里定义的可执行策略模板,如突破回踩/趋势中继)。",
    notes: [
      "重要区分：**交易策略 ≠ 交易预案**。策略是规则模板(可重复用于多只股票),预案是某只股票的具体计划。",
      "用户说\"我有哪些交易策略\"\"查看交易策略\"\"策略列表\"时必须走 strategies.query,不要走 plans.query。",
    ],
  },
  { name: "trade_log.query", policy: "read", description: "查看交易日志、操作记录、买卖记录、持仓变更记录" },
  { name: "review_records.query", policy: "read", description: "查看复盘记录、历史复盘、最近复盘、复盘存档" },
  { name: "conversation.history", policy: "read", description: "查询当前实例/会话的权威对话记录；用于会话上下文不足时理解“确认”“继续”等短句" },
  { name: "confirmations.pending", policy: "read", description: "查询当前实例/会话仍待用户确认的服务端操作；用于执行确认前消除歧义" },
  { name: "monitor.overview", policy: "read", description: "查看监控、巡检、整体状态、概览" },
  { name: "alerts.check", policy: "async", description: "手动巡检、看看有没有新提醒" },
  { name: "alert.set", policy: "draft", description: "设置股票到价提醒（只起草提醒草案，等待用户确认，不直接写库）" },
  { name: "alert.remove", policy: "write", description: "关闭某只股票的提醒规则，可指定某类提醒；写入前需要确认" },
  { name: "watchlist.add", policy: "write", description: "把 AI 已明确绑定到 stocks 的股票加入自选池；写入前需要确认" },
  { name: "watchlist.remove", policy: "write", description: "把 AI 已明确绑定到 stocks 的股票移出自选池；写入前需要确认" },
  { name: "smalltalk.reply", policy: "read", description: "寒暄、能力介绍、问可以做什么" },
];

export function getToolManifest(): ToolManifestItem[] {
  return TOOL_MANIFEST.map((tool) => ({ ...tool, notes: tool.notes ? [...tool.notes] : undefined }));
}
