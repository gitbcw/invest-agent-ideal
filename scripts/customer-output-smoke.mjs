import assert from "node:assert/strict";
import { dedupeRepeatedCustomerText, sanitizeCustomerText, redactSensitiveText } from "../dist/lib/customer-output.js";

const unsafeLeakPatterns = [
  /localhost:\d+/i,
  /127\.0\.0\.1:\d+/i,
  /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/(?:api|admin|acp)\//i,
  /\/(?:api|admin|acp)\//i,
  /\bcurl\b/i,
  /\/Users\//i,
  /\/tmp\//i,
  /\.state\//i,
  /~\/\.openclaw/i,
  /Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i,
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
];

const output = sanitizeCustomerText([
  "我会把已确认的策略写入策略档案，并追加确认日志。已记录你的投资策略。",
  "",
  "我会按这个框架做后续复盘：",
  "- 基本面为主，技术面辅助",
  "- 中期趋势跟踪",
  "- 观察池和自选池两个词都应原样保留",
  "- Codex、Hermes、ACP、MCP、skill、Dashboard、reviews 不再做风格性改写",
  "",
  "curl -X POST http://localhost:22649/api/sandbox/watchlist/add -H \"Authorization: Bearer abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz\"",
  "日志在 /Users/combo/MyFile/projects/invest-agent-ideal/logs/service.log，临时文件 /tmp/foo.log。",
  "",
  "下一步可以继续设置：每日复盘时间和盯盘提醒规则。",
].join("\n"));

for (const pattern of unsafeLeakPatterns) {
  assert.equal(pattern.test(output), false, `unsafe leak ${pattern}: ${output}`);
}

assert.match(output, /我会把已确认的策略写入策略档案/);
assert.match(output, /我会按这个框架做后续复盘/);
assert.match(output, /观察池和自选池两个词都应原样保留/);
assert.match(output, /Codex、Hermes、ACP、MCP、skill、Dashboard、reviews 不再做风格性改写/);
assert.match(output, /后台命令已隐藏/);
assert.match(output, /内部文件/);
assert.match(output, /下一步可以继续设置/);

const redacted = redactSensitiveText(
  "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz"
);
assert.match(redacted, /REDACTED/);
assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz\.abcdefghijklmnopqrstuvwxyz/);

const markdownTable = sanitizeCustomerText([
  "| 类型 | 标的 | 仓位 |",
  "|---|---|---:|",
  "| 持仓 | 赛轮轮胎 | 30% |",
].join("\n"));
assert.match(markdownTable, /\| 类型 \| 标的 \| 仓位 \|/);
assert.match(markdownTable, /\|---\|---\|---:\|/);

const repeatedOnboarding = dedupeRepeatedCustomerText([
  "我可以帮你做这些投资辅助：",
  "",
  "1. 录入并维护持仓、现金、观察仓",
  "2. 每日/每周/月度复盘",
  "",
  "我不会承诺收益，也不会替你下单。",
  "",
  "我可以帮你做这些投资辅助：",
  "",
  "1. 录入并维护持仓、现金、观察仓",
  "2. 每日/每周/月度复盘",
  "",
  "我不会承诺收益，也不会替你下单。",
].join("\n"));
assert.equal((repeatedOnboarding.match(/我可以帮你做这些投资辅助/g) ?? []).length, 1);

const repeatedDraft = dedupeRepeatedCustomerText([
  "我会按首次建档流程处理：先把你发来的持仓整理成确认草案，不直接写入。我先整理成建档草案，暂不写入：",
  "",
  "【持仓】",
  "1. 赛轮轮胎：30%",
  "2. 赣锋锂业：25%",
  "",
  "请回复“确认写入”，我再保存。",
  "我先整理成建档草案，暂不写入：",
  "",
  "【持仓】",
  "1. 赛轮轮胎：30%",
  "2. 赣锋锂业：25%",
  "",
  "请回复“确认写入”，我再保存。",
].join("\n"));
assert.equal((repeatedDraft.match(/【持仓】/g) ?? []).length, 1);

console.log(JSON.stringify({ ok: true }));
