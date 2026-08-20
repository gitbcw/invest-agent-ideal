const EXACT_TOOL_LABELS: Record<string, string> = {
  get_hist_kline: "查询历史行情",
  get_realtime_quote: "查询实时行情",
  get_industry_fund_flow_matrix: "查询行业资金流",
  get_tz_pool: "查询主题投资池",
  get_sector_list: "获取行业板块列表",
  get_market_summary: "整理市场概况",
  get_market_newsflash: "检索市场快讯",
  "portfolio.read": "读取持仓信息",
  "watchlist.read": "读取自选信息",
  "plans.read": "读取投资计划",
  "conversation.history": "回顾相关对话"
};

export function toolDisplayName(toolName?: string): string {
  if (!toolName) return "执行分析步骤";
  const exact = EXACT_TOOL_LABELS[toolName];
  if (exact) return exact;

  const normalized = toolName.toLowerCase();
  if (/news|flash|announcement/.test(normalized)) return "检索市场资讯";
  if (/industry|sector|fund.?flow/.test(normalized)) return "查询行业与资金数据";
  if (/quote|kline|price|market/.test(normalized)) return "查询市场行情";
  if (/portfolio|holding|position/.test(normalized)) return "读取持仓信息";
  if (/watchlist|observation/.test(normalized)) return "读取关注标的";
  if (/workspace|file|asset|document/.test(normalized)) return "读取工作文件";
  if (/review/.test(normalized)) return "读取复盘记录";
  if (/plan|strategy/.test(normalized)) return "读取投资计划与策略";
  if (/search|research|web/.test(normalized)) return "检索研究资料";
  if (/calculate|calculator|compute|indicator/.test(normalized)) return "执行数据计算";
  return "执行分析步骤";
}

