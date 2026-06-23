/**
 * 沙箱引擎冒烟测试
 *
 * 验证 ScriptIndicatorEngine:
 *   1. 编译示例脚本 double_ma_cross.ts(esbuild bundle)
 *   2. 执行 compute,验证 helpers 桥(computeMA)被正确调用
 *   3. 验证缓存命中(第二次 compile fromCache=true)
 *   4. 验证超时熔断
 *   5. 验证 ctx 注入(IndicatorContext 字段可读)
 *
 * 运行:npm run smoke:script-indicator
 */

import { ScriptIndicatorEngine } from "../dist/services/script-indicator-engine.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

// 临时工作空间(测试结束清理)
const tmpWorkspace = resolve("./.tmp-script-indicator-workspace");
if (existsSync(tmpWorkspace)) rmSync(tmpWorkspace, { recursive: true, force: true });
mkdirSync(tmpWorkspace, { recursive: true });

// 示例脚本路径(项目内)
const scriptPath = resolve("./templates/workspace/scripts/indicators/double_ma_cross.ts");
assert(existsSync(scriptPath), `示例脚本应存在: ${scriptPath}`);

// 30 日 K 线 fixture(整体上涨趋势)
const klines = [
  { date: "2026-04-01", open: 10.0, close: 10.1, high: 10.2, low: 9.9, volume: 1000000 },
  { date: "2026-04-02", open: 10.1, close: 10.3, high: 10.4, low: 10.0, volume: 1100000 },
  { date: "2026-04-03", open: 10.3, close: 10.5, high: 10.6, low: 10.2, volume: 1200000 },
  { date: "2026-04-04", open: 10.5, close: 10.4, high: 10.6, low: 10.3, volume: 1050000 },
  { date: "2026-04-05", open: 10.4, close: 10.7, high: 10.8, low: 10.3, volume: 1300000 },
  { date: "2026-04-06", open: 10.7, close: 11.0, high: 11.1, low: 10.6, volume: 1400000 },
  { date: "2026-04-07", open: 11.0, close: 10.8, high: 11.1, low: 10.7, volume: 1150000 },
  { date: "2026-04-08", open: 10.8, close: 10.6, high: 10.9, low: 10.5, volume: 1000000 },
  { date: "2026-04-09", open: 10.6, close: 10.9, high: 11.0, low: 10.5, volume: 1250000 },
  { date: "2026-04-10", open: 10.9, close: 11.2, high: 11.3, low: 10.8, volume: 1350000 },
  { date: "2026-04-11", open: 11.2, close: 11.5, high: 11.6, low: 11.1, volume: 1450000 },
  { date: "2026-04-12", open: 11.5, close: 11.4, high: 11.6, low: 11.3, volume: 1200000 },
  { date: "2026-04-13", open: 11.4, close: 11.7, high: 11.8, low: 11.3, volume: 1400000 },
  { date: "2026-04-14", open: 11.7, close: 12.0, high: 12.1, low: 11.6, volume: 1500000 },
  { date: "2026-04-15", open: 12.0, close: 12.2, high: 12.3, low: 11.9, volume: 1550000 },
  { date: "2026-04-16", open: 12.2, close: 12.1, high: 12.3, low: 12.0, volume: 1300000 },
  { date: "2026-04-17", open: 12.1, close: 12.4, high: 12.5, low: 12.0, volume: 1450000 },
  { date: "2026-04-18", open: 12.4, close: 12.6, high: 12.7, low: 12.3, volume: 1500000 },
  { date: "2026-04-19", open: 12.6, close: 12.5, high: 12.7, low: 12.4, volume: 1250000 },
  { date: "2026-04-20", open: 12.5, close: 12.8, high: 12.9, low: 12.4, volume: 1400000 },
  { date: "2026-04-21", open: 12.8, close: 13.0, high: 13.1, low: 12.7, volume: 1500000 },
  { date: "2026-04-22", open: 13.0, close: 12.9, high: 13.1, low: 12.8, volume: 1300000 },
  { date: "2026-04-23", open: 12.9, close: 13.1, high: 13.2, low: 12.8, volume: 1400000 },
  { date: "2026-04-24", open: 13.1, close: 13.3, high: 13.4, low: 13.0, volume: 1500000 },
  { date: "2026-04-25", open: 13.3, close: 13.5, high: 13.6, low: 13.2, volume: 1550000 },
  { date: "2026-04-26", open: 13.5, close: 13.4, high: 13.6, low: 13.3, volume: 1300000 },
  { date: "2026-04-27", open: 13.4, close: 13.6, high: 13.7, low: 13.3, volume: 1400000 },
  { date: "2026-04-28", open: 13.6, close: 13.8, high: 13.9, low: 13.5, volume: 1500000 },
  { date: "2026-04-29", open: 13.8, close: 13.7, high: 13.9, low: 13.6, volume: 1300000 },
  { date: "2026-04-30", open: 13.7, close: 14.0, high: 14.1, low: 13.6, volume: 1550000 },
];

const turnovers = new Array(30).fill(0).map((_, i) => 1.0 + (i % 5) * 0.3);

const engine = new ScriptIndicatorEngine({
  workspaceRoot: tmpWorkspace,
  memoryLimitMB: 16,
  timeoutMs: 3000,
});

// === 1. 编译 ===
{
  const result = await engine.compile(scriptPath);
  assert(!result.fromCache, "首次编译不应命中缓存");
  assert(result.hash.length === 16, `hash 应为 16 字符,实际 ${result.hash}`);
  assert(existsSync(result.compiledPath), `编译产物应存在: ${result.compiledPath}`);
  console.log(`[OK] 首次编译 hash=${result.hash}`);

  const result2 = await engine.compile(scriptPath);
  assert(result2.fromCache, "第二次编译应命中缓存");
  assert(result2.hash === result.hash, "hash 应稳定");
  console.log(`[OK] 缓存命中,编译产物复用`);
}

// === 2. 执行 + helpers 桥 ===
{
  const result = await engine.run(scriptPath, { klines, turnovers });
  assert(result.values, "结果应包含 values");
  assert(typeof result.values.ma5 === "number", "ma5 应为 number");
  assert(typeof result.values.ma20 === "number", "ma20 应为 number");
  assert(typeof result.values.crossed_up === "boolean", "crossed_up 应为 boolean");
  assert(typeof result.values.crossed_down === "boolean", "crossed_down 应为 boolean");

  // 整体上涨趋势:MA5 应 > MA20
  assert(result.values.ma5 > result.values.ma20, `MA5(${result.values.ma5}) 应 > MA20(${result.values.ma20})`);

  // 验证 computeMA 调用正确(MA5 = 最近 5 日均价)
  const last5 = klines.slice(-5).map((k) => k.close);
  const expectedMA5 = last5.reduce((a, b) => a + b, 0) / 5;
  assert(
    Math.abs(result.values.ma5 - Math.round(expectedMA5 * 100) / 100) < 0.01,
    `MA5 应 ≈ ${expectedMA5.toFixed(2)},实际 ${result.values.ma5}`,
  );

  console.log(`[OK] 执行成功 MA5=${result.values.ma5} MA20=${result.values.ma20}`);
  console.log(`     crossed_up=${result.values.crossed_up} crossed_down=${result.values.crossed_down}`);
  console.log(`     notes=${JSON.stringify(result.notes)}`);
}

// === 3. ctx.params 注入 ===
{
  // 没有用到 params,但应能透传不报错
  const result = await engine.run(scriptPath, {
    klines,
    turnovers,
    params: { customThreshold: 0.5 },
  });
  assert(result.values, "params 透传应不影响执行");
  console.log(`[OK] params 透传 OK`);
}

// === 4. 超时熔断 ===
{
  // 写一个死循环临时脚本
  const infiniteScript = resolve(tmpWorkspace, "infinite.ts");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    infiniteScript,
    `import type { IndicatorContext, IndicatorResult } from 'invest-agent-runtime';
export const definition = { key: 'infinite', name: '死循环测试', reliability: 'experimental', dataRequirements: [], outputSchema: {} };
export function compute(ctx: IndicatorContext): IndicatorResult {
  let i = 0;
  while (true) { i++; }
  return { values: { i } };
}
`,
  );

  try {
    await engine.run(infiniteScript, { klines, turnovers });
    throw new Error("应抛出超时错误,但没抛");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes("timed out"), `错误信息应含 'timed out',实际: ${msg}`);
    console.log(`[OK] 超时熔断生效: ${msg}`);
  }
}

// === 5. 缺失 compute 导出的错误处理 ===
{
  const badScript = resolve(tmpWorkspace, "bad.ts");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    badScript,
    `export const definition = { key: 'bad', name: '无 compute', reliability: 'stable', dataRequirements: [], outputSchema: {} };
// 故意不 export compute
`,
  );

  try {
    await engine.run(badScript, { klines, turnovers });
    throw new Error("应抛出缺失 compute 错误");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes("compute"), `错误信息应提到 compute,实际: ${msg}`);
    console.log(`[OK] 缺失 compute 错误处理: ${msg}`);
  }
}

// 清理
rmSync(tmpWorkspace, { recursive: true, force: true });

console.log("\n✅ 沙箱引擎冒烟测试通过");
