// 成本定价：token → 美元换算。
// 费率单位 $/M（每百万 token），基于 Agent trace 用量。
// 调价只改这里，owner/partner 成本视图共用。

// 费率表（$/M，每百万 token）。缓存读取 = 输入价格的 1/10。
export const PRICING_RATES = {
  input: 5, // 输入 token
  output: 30, // 输出 token
  thought: 5, // 推理 token（复用输入费率）
  cacheRead: 0.5, // 缓存读取（= 输入 1/10）
} as const;

// 注入页面的定价表 + 换算函数（客户端 JS 字符串）。
// costOf(n, rate) 返回字符串金额；tokens 单位为个，rate 为 $/M（每百万）。
export const PRICING_JS = `
const PRICING_RATES=${JSON.stringify(PRICING_RATES)};
const M=1000000;
function costOf(tokens,ratePerM){const n=Number(tokens||0);if(!n)return '$0.00';return '$'+(n/M*ratePerM).toFixed(2);}
// 汇总费用：输入+输出+推理+缓存读取
function totalCost(t){return Number((t.inputTokens||0)/M*PRICING_RATES.input)+(t.outputTokens||0)/M*PRICING_RATES.output+(t.thoughtTokens||0)/M*PRICING_RATES.thought+(t.cachedReadTokens||0)/M*PRICING_RATES.cacheRead;}
function fmtCost(v){return '$'+Number(v||0).toFixed(2);}
function fmtRate(r){return '$'+r+'/M';}`;
