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
      "后台排查：npm run build && launchctl kickstart -k gui/501/local.invest-agent-hermes",
      "日志在 /Users/combo/MyFile/projects/invest-agent/logs/hermes.log，源码 src/acp/agent.ts，文档 docs/19-skill-loop-hardening-plan.md。",
      "结论：今天只需要继续观察，不需要追高。",
    ].join("\n"),
  },
  {
    name: "internal components and stack",
    input: [
      "Hermes ACP 通过 MCP 调用了 invest-agent-daily-review skill。",
      "Error: request failed",
      "at Object.run (/Users/combo/MyFile/projects/invest-agent/dist/index.js:10:2)",
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

console.log(JSON.stringify({ ok: true, cases: cases.length }));
