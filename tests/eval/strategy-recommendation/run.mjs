/**
 * 交易策略推荐评测执行器
 *
 * 用法:
 *   npm run eval:strategy-recommendation
 *
 * 流程:
 *   1. 读 fixtures.yaml 和 expected.yaml
 *   2. 对每只股票,调 invest-agent 的 /api/sandbox/strategies/recommend 端点
 *      (P3b 提供);若端点未实现或不可用,报"待 P3b 实现"。
 *   3. 对比 AI 输出与 expected:
 *      - top_1 严格相等
 *      - top_3 包含期望 key
 *      - rationale 包含至少 1 个期望关键词
 *   4. 输出命中率,与 threshold 比较,exit code 0/1
 *
 * 注:评测集离线跑,不进 CI 必跑项(依赖外部服务)。
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixturesPath = resolve(__dirname, "fixtures.yaml");
const expectedPath = resolve(__dirname, "expected.yaml");

if (!existsSync(fixturesPath) || !existsSync(expectedPath)) {
  console.error("缺少 fixtures.yaml 或 expected.yaml");
  process.exit(2);
}

const fixtures = parse(readFileSync(fixturesPath, "utf-8"));
const expected = parse(readFileSync(expectedPath, "utf-8"));

const baseUrl = process.env.INVEST_AGENT_BASE_URL || "http://localhost:22655";
const sandboxToken = process.env.INVEST_AGENT_SANDBOX_TOKEN;

if (!sandboxToken) {
  console.error("缺少 INVEST_AGENT_SANDBOX_TOKEN");
  console.error("评测需要 sandbox token 才能调推理端点");
  process.exit(2);
}

async function recommend(strategies, stockContext) {
  const resp = await fetch(`${baseUrl}/api/sandbox/strategies/recommend`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sandboxToken}`,
    },
    body: JSON.stringify({ strategies, stockContext }),
  });
  if (!resp.ok) {
    throw new Error(`recommend 失败 status=${resp.status} body=${await resp.text()}`);
  }
  return resp.json();
}

function keywordHit(rationaleText, keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) return true;
  return keywords.some((kw) => rationaleText.includes(kw));
}

let top1Hits = 0;
let top3Hits = 0;
let keywordHits = 0;
const rows = [];

for (const expectedRow of expected.expectations) {
  const fixtureStock = fixtures.stocks.find((s) => s.code === expectedRow.code);
  if (!fixtureStock) {
    console.error(`fixture 缺股票 ${expectedRow.code}`);
    process.exit(2);
  }

  let recommendation;
  try {
    recommendation = await recommend(fixtures.strategies, fixtureStock.stockContext);
  } catch (err) {
    console.error(`评测失败 code=${expectedRow.code}: ${err.message}`);
    console.error("\n提示:/api/sandbox/strategies/recommend 端点待 P3b 实现。");
    process.exit(2);
  }

  const top1 = recommendation.top_1 ?? recommendation.top1;
  const top3 = recommendation.top_3 ?? recommendation.top3 ?? [];
  const rationale = recommendation.rationale ?? "";

  const top1Ok = top1 === expectedRow.top_1;
  const top3Ok = top3.includes(expectedRow.top_1);
  const keywordOk = keywordHit(rationale, expectedRow.rationale_keywords);

  if (top1Ok) top1Hits++;
  if (top3Ok) top3Hits++;
  if (keywordOk) keywordHits++;

  rows.push({
    code: expectedRow.code,
    name: expectedRow.name,
    expected_top1: expectedRow.top_1,
    actual_top1: top1,
    actual_top3: top3,
    top1_ok: top1Ok,
    top3_ok: top3Ok,
    keyword_ok: keywordOk,
    rationale,
  });
}

const total = expected.expectations.length;
const top1Rate = top1Hits / total;
const top3Rate = top3Hits / total;

console.log("\n=== 交易策略推荐评测结果 ===\n");
for (const row of rows) {
  console.log(
    `${row.code} ${row.name}  期望=${row.expected_top1}  实际=${row.actual_top1}  ` +
      `top1:${row.top1_ok ? "✓" : "✗"} top3:${row.top3_ok ? "✓" : "✗"} kw:${row.keyword_ok ? "✓" : "✗"}`,
  );
  if (row.rationale) console.log(`  理由: ${row.rationale}`);
}
console.log(`\ntop-1 命中率: ${top1Hits}/${total} = ${(top1Rate * 100).toFixed(1)}% (阈值 ${(expected.threshold_top1_hit_rate * 100).toFixed(0)}%)`);
console.log(`top-3 命中率: ${top3Hits}/${total} = ${(top3Rate * 100).toFixed(1)}% (阈值 ${(expected.threshold_top3_hit_rate * 100).toFixed(0)}%)`);
console.log(`关键词命中率: ${keywordHits}/${total} = ${((keywordHits / total) * 100).toFixed(1)}%`);

const pass = top1Rate >= expected.threshold_top1_hit_rate && top3Rate >= expected.threshold_top3_hit_rate;
console.log(`\n${pass ? "✅ 通过" : "❌ 未通过"}`);
process.exit(pass ? 0 : 1);
