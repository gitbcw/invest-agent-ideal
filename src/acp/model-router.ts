export type AcpModelTier = "simple" | "complex";

const COMPLEX_CHAT_PATTERNS = [
  /复盘/i,
  /选股/i,
  /筛选/i,
  /筛股/i,
  /研究/i,
  /研判/i,
  /分析.+股票/i,
  /股票.+分析/i,
  /行业.+分析/i,
  /主题.+分析/i,
  /估值/i,
  /财报/i,
  /公告/i,
  /交易计划/i,
  /出预案/i,
  /策略匹配/i,
  /投资模型/i,
];

export function resolveChatModelTier(text: string): AcpModelTier {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return "simple";
  return COMPLEX_CHAT_PATTERNS.some((pattern) => pattern.test(normalized)) ? "complex" : "simple";
}

export function resolveScheduledModelTier(mode: string): AcpModelTier {
  if (/^scheduled-(daily|weekly|monthly)-review$/.test(mode)) return "complex";
  return "simple";
}
