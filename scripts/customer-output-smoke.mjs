import assert from "node:assert/strict";
import { sanitizeCustomerText, redactSensitiveText } from "../dist/lib/customer-output.js";

const leakPatterns = [
  /localhost/i,
  /127\.0\.0\.1/i,
  /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/(?:api|admin|acp)\//i,
  /\/(?:api|admin|acp)\//i,
  /\bcurl\b/i,
  /\b(?:npm|pnpm|yarn|launchctl|pm2|sqlite3|tsx|tsc)\b/i,
  /\/Users\//i,
  /\/tmp\//i,
  /\bsrc\//i,
  /\bdist\//i,
  /\bdocs\//i,
  /\bscripts\//i,
  /\blogs\//i,
  /\bdata\//i,
  /\.codex\//i,
  /\.env/i,
  /\bCodex\b/i,
  /\bACP\b/i,
  /\bHermes\b/i,
  /\bMCP\b/i,
  /\bskill\b/i,
  /weixin-agent-sdk/i,
  /OpenClaw/i,
  /Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i,
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
];

const cases = [
  {
    name: "token and sandbox API",
    input: [
      "我会先调用 skill 和 /api/sandbox/dashboard。",
      "curl -X POST http://localhost:22649/api/sandbox/watchlist/add -H \"Authorization: Bearer abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz\"",
      "已添加 平安银行(000001) 到自选池。",
    ].join("\n"),
  },
  {
    name: "local files and service commands",
    input: [
      "后台排查：npm run build && sqlite3 ./data/invest-agent.db \"select value from settings where key='acp_backend'\"",
      "日志在 /Users/combo/MyFile/projects/invest-agent-ideal/logs/service.log，源码 src/acp/agent.ts，文档 docs/quality/golden-test-set.md。",
      "结论：今天只需要继续观察，不需要追高。",
    ].join("\n"),
  },
  {
    name: "internal components and stack",
    input: [
      "Kimi ACP 通过 MCP 调用了 invest-agent-daily-review skill。",
      "Error: request failed",
      "at Object.run (/Users/combo/MyFile/projects/invest-agent-ideal/dist/index.js:10:2)",
      "处理结果：复盘生成完成，核心风险是量能不足。",
    ].join("\n"),
  },
  {
    name: "admin routes and env",
    input: [
      "GET /admin/hermes-weixin，POST /acp/message，读取 .env.example 和 data/invest-agent.db。",
      "已完成：提醒规则已设置。",
    ].join("\n"),
  },
];

for (const item of cases) {
  const output = sanitizeCustomerText(item.input);
  for (const pattern of leakPatterns) {
    assert.equal(pattern.test(output), false, `${item.name} leaked ${pattern}: ${output}`);
  }
  assert.notEqual(output.length, 0, `${item.name} produced empty output`);
}

const redacted = redactSensitiveText(
  "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz"
);
assert.match(redacted, /REDACTED/);
assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz\.abcdefghijklmnopqrstuvwxyz/);

const reviewSummary = sanitizeCustomerText([
  "【2026-06-24 复盘摘要】",
  "",
  "1. 核心判断",
  "- 今日主要指数全线收红。",
  "",
  "完整复盘已保存。需要展开可以回复「查看今日复盘」。",
].join("\n"));
assert.match(reviewSummary, /复盘摘要/);
assert.match(reviewSummary, /今日主要指数全线收红/);
assert.doesNotMatch(reviewSummary, /^已保存/);

const portfolioMovement = sanitizeCustomerText([
  "当前持有 3 只，今日涨跌如下：",
  "- 赛轮轮胎(601058)：11.54，-0.18 (-1.54%)",
  "- 赣锋锂业(002460)：71.62，+3.62 (+5.32%)",
  "",
  "结论：有 1 只单日波动超过 3%。",
].join("\n"));
assert.match(portfolioMovement, /当前持有 3 只/);
assert.match(portfolioMovement, /赣锋锂业/);
assert.match(portfolioMovement, /结论/);

const watchlistComposer = sanitizeCustomerText([
  "结论：目前自选股中没有个股接近预设的买点条件。",
  "- 所有7只自选股均无买入预案（plan: null），也没有支撑位或观察位条件。",
].join("\n"));
assert.match(watchlistComposer, /暂无交易预案/);
assert.doesNotMatch(watchlistComposer, /plan\s*:\s*null/i);

const alertComposer = sanitizeCustomerText([
  "结论：均线突破类规则需要指标检查，可能暂时无法正常触发。",
  "不代表无效，但触发可能延迟或条件未满足。",
].join("\n"));
assert.match(alertComposer, /需要巡检计算确认/);
assert.doesNotMatch(alertComposer, /可能暂时无法正常触发/);
assert.doesNotMatch(alertComposer, /触发可能延迟/);

console.log(JSON.stringify({ ok: true, cases: cases.length }));
