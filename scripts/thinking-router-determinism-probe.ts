/**
 * T-396 根因定位探针：思考深度裁判同输入 N 次重判的分布实测。
 *
 * 用法：node --import tsx --env-file=.env scripts/thinking-router-determinism-probe.ts
 *       [--n 12] [--concurrency 4] [--only <caseId>] [--headers]
 *
 * 案例：data/experiments/t396-cases-raw.json（生产指令原文，data/ 在 .gitignore，
 * 不入库）+ 本文件内置的构造对照案例。automation 案例按生产 runner 真实拼接格式
 * （name\ninstruction\n输出模式: {output_json}）组装，与 generic-automation-runner
 * classifyThinkingDepth 调用点保持一致。
 *
 * 走生产同款 classifyThinkingDepth（含 fail-open 语义：reason 带 router- 前缀的
 * 是路由失败回退，不是裁判判定，统计时单列）。真实调用网关，glm-5.3-flash
 * 裁判 ~¥0.0014/次。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyThinkingDepth, THINKING_DEPTH_ROUTER_MODEL } from "../src/services/thinking-depth-router.js";

const RAW_PATH = path.resolve(import.meta.dirname, "../data/experiments/t396-cases-raw.json");
const OUT_DIR = path.resolve(import.meta.dirname, "../data/experiments");

interface RawCase { task: string; name: string; instruction: string; output: Record<string, unknown> }

/** 构造对照案例（无敏感内容，进 git）。desc 说明该案例要回答的问题。 */
const CONSTRUCTED_CASES: Array<{ id: string; mode: "interactive" | "automation"; desc: string; text: string }> = [
  {
    id: "clear-low-interactive",
    mode: "interactive",
    desc: "对照：明显 low（数据查询），若也翻转则说明不确定性是全局的而非边界专属",
    text: "查一下贵州茅台今天的资金净流入和成交额",
  },
  {
    id: "clear-high-interactive",
    mode: "interactive",
    desc: "对照：明显 high（财报深度分析+同行对比）",
    text: "从现金流、存货周转、盈利质量三个维度深度分析这家公司最新财报的质量，与同行横向对比，指出可能的财报粉饰风险，给出论证链",
  },
  {
    id: "boundary-interactive-addposition",
    mode: "interactive",
    desc: "边界：短消息像速查，但属于「该不该买卖」开放决策（规则集应 high）——交互轮的典型边界",
    text: "帮我看看现在这个位置能不能加仓",
  },
  {
    id: "market-watch-constructed",
    mode: "automation",
    desc: "对照：简报推送类（守卫外，裁判应稳定 low）",
    text: `市场观察\n每个交易日 11:30 生成市场观察：汇总主要指数涨跌与成交额、全市场涨跌家数、当日强势板块与领涨股、值得注意的市场信号，形成简报摘要。输出模式: {"mode":"push","channel":"wechat"}`,
  },
];

function parseArgs(): { n: number; concurrency: number; only: string | null; headers: boolean; intervalMs: number; forceMode: "interactive" | "automation" | null } {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? "") : null;
  };
  const forceMode = get("--force-mode");
  return {
    n: Number(get("--n") ?? 12),
    concurrency: Number(get("--concurrency") ?? 4),
    only: get("--only"),
    headers: argv.includes("--headers"),
    intervalMs: Number(get("--interval") ?? 0),
    forceMode: forceMode === "interactive" || forceMode === "automation" ? forceMode : null,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const { n, concurrency, only, headers, intervalMs, forceMode } = parseArgs();
  let raw: RawCase[] = [];
  try {
    raw = JSON.parse(await readFile(RAW_PATH, "utf8")) as RawCase[];
  } catch {
    console.error(`生产案例文件缺失（${RAW_PATH}）：从生产库 automation_task_revisions 只读导出 [{task,name,instruction,output}]，字段格式见 T-396 实验记录。仅有内置对照案例时可忽略本错误继续。`);
  }
  const productionCases = raw.map((c) => ({
    id: `prod-${c.task}`,
    mode: "automation" as const,
    desc: `生产任务指令原文（at_${c.task} ${c.name}），按 runner 真实拼接格式组装`,
    text: `${c.name}\n${c.instruction}\n输出模式: ${JSON.stringify(c.output)}`,
  }));
  const cases = [...productionCases, ...CONSTRUCTED_CASES].filter((c) => !only || only.split(",").includes(c.id));

  if (headers && !only) {
    // 渠道探针：同请求直接 fetch 一次，打印全部响应头找 new-api 渠道标记
    const base = (process.env.MASTRA_GATEWAY_BASE_URL || "").replace(/\/$/, "");
    const key = process.env.MASTRA_GATEWAY_API_KEY || "";
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: THINKING_DEPTH_ROUTER_MODEL,
        messages: [
          { role: "system", content: "只输出 JSON：{\"depth\":\"low\"或\"high\",\"reason\":\"x\"}" },
          { role: "user", content: "查一下今天的行情" },
        ],
        max_tokens: 1024,
        temperature: 0,
      }),
    });
    console.log("=== response headers（找渠道标记）===");
    for (const [k, v] of res.headers) console.log(`  ${k}: ${v}`);
    await res.json().catch(() => null);
  }

  const report: Array<Record<string, unknown>> = [];
  for (const c of cases) {
    const calls = await pool(
      Array.from({ length: n }, (_, i) => i),
      intervalMs > 0 ? 1 : concurrency,
      async (_, i) => {
        if (intervalMs > 0 && i > 0) await sleep(intervalMs);
        const started = Date.now();
        const decision = await classifyThinkingDepth({ text: c.text, mode: forceMode ?? c.mode });
        return { ...decision, elapsed_ms: Date.now() - started };
      },
    );
    const judged = calls.filter((d) => !d.reason.startsWith("router-"));
    const failed = calls.length - judged.length;
    const low = judged.filter((d) => d.depth === "low").length;
    const high = judged.filter((d) => d.depth === "high").length;
    const majority = Math.max(low, high);
    const stability = judged.length ? majority / judged.length : 0;
    const reasons = {
      low: [...new Set(judged.filter((d) => d.depth === "low").map((d) => d.reason))],
      high: [...new Set(judged.filter((d) => d.depth === "high").map((d) => d.reason))],
    };
    report.push({
      id: c.id, mode: forceMode ?? c.mode, desc: c.desc, text_chars: c.text.length,
      n: calls.length, low, high, router_failures: failed,
      stability: Number(stability.toFixed(3)),
      flip_rate: Number((1 - stability).toFixed(3)),
      reasons, calls,
    });
    console.log(
      `${c.id.padEnd(34)} low=${String(low).padStart(2)} high=${String(high).padStart(2)} fail=${failed} ` +
      `stability=${(stability * 100).toFixed(0)}% elapsed_avg=${Math.round(calls.reduce((s, d) => s + d.elapsed_ms, 0) / calls.length)}ms`,
    );
    if (low > 0 && high > 0) {
      console.log(`    low reasons:  ${reasons.low.slice(0, 4).join(" / ")}`);
      console.log(`    high reasons: ${reasons.high.slice(0, 4).join(" / ")}`);
    }
  }

  const outPath = path.join(OUT_DIR, `t396-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), n, concurrency, report }, null, 2));
  console.log(`\n完整结果: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
