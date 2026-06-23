/**
 * 工作包 1 烟测:覆盖三类典型场景 + provider fallback。
 *
 * 运行前确保 .env 配置了 DEEPSEEK_API_KEY / DOUBAO_API_KEY / STEPFUN_API_KEY
 *
 *   node scripts/triage-smoke.mjs
 */

import "dotenv/config";
import { triage } from "../dist/acp/triage.js";

const cases = [
  {
    label: "[轻量] 简单问候",
    text: "你好",
    expect: "direct_reply 或 fallback_codex(边界模糊也接受)",
  },
  {
    label: "[轻量] 简单确认",
    text: "好的,明白了",
    expect: "direct_reply",
  },
  {
    label: "[复杂] 持仓分析",
    text: "帮我看看阳光电源最近走势怎么样,现在该加仓还是减仓?",
    expect: "fallback_codex",
  },
  {
    label: "[复杂] 选股研究",
    text: "我想研究一下新能源车产业链,从上游锂矿到下游整车都有哪些值得关注的标的?",
    expect: "fallback_codex",
  },
  {
    label: "[复杂] 复盘生成",
    text: "今天收盘后帮我做一份日复盘",
    expect: "fallback_codex(短路日复盘)",
  },
  {
    label: "[边界] 写代码",
    text: "帮我写一个 Python 脚本,实现快速排序",
    expect: "reject",
  },
  {
    label: "[边界] 餐饮推荐",
    text: "今晚吃什么好?推荐几家附近的餐厅",
    expect: "reject",
  },
  {
    label: "[边界] 投资无关但模糊",
    text: "今天大盘怎么样",
    expect: "fallback_codex(虽短但需要行情数据,LLM 可能不确定)",
  },
];

console.log(`跑 ${cases.length} 个用例...\n`);
const results = [];
for (const c of cases) {
  const r = await triage(c.text);
  results.push({ ...c, result: r });
  console.log(`>>> ${c.label}`);
  console.log(`    输入: ${c.text}`);
  console.log(`    期望: ${c.expect}`);
  console.log(`    实际: kind=${r.kind} confidence=${r.confidence.toFixed(2)} provider=${r.provider ?? "-"} elapsedMs=${r.elapsedMs}`);
  if (r.text) console.log(`    text: ${r.text.slice(0, 80)}${r.text.length > 80 ? "..." : ""}`);
  if (r.reason) console.log(`    reason: ${r.reason}`);
  console.log("");
}

console.log("=== 汇总 ===");
for (const r of results) {
  const ok = r.result.kind !== undefined;
  console.log(`  ${ok ? "✓" : "✗"} ${r.label} → ${r.result.kind} (${r.result.confidence.toFixed(2)}, ${r.result.provider ?? "-"})`);
}
