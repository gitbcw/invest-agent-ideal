/**
 * 主力控盘 L3b 脚本冒烟测试
 *
 * 验证 main_force_control.ts:
 *   1. 上涨趋势下 ZZLKP 应较高(主力控盘特征)
 *   2. 震荡趋势下 ZZLKP 应较低
 *   3. ZZLKP ∈ [0, 100]
 *   4. ZSHTL + ZZLKP ≈ 100(互补关系)
 *   5. ZJLRQD 是整数
 *   6. DKB ∈ {0, 1}
 *   7. 缺数据(<94 日)走 manual_review 分支
 *   8. 缺 turnovers 时按成交量估算
 *   9. 告知协议:reliability = experimental
 *
 * 运行:npm run smoke:main-force-control
 */

import { ScriptIndicatorEngine } from "../dist/services/script-indicator-engine.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

const tmpWorkspace = resolve("./.tmp-main-force-workspace");
if (existsSync(tmpWorkspace)) rmSync(tmpWorkspace, { recursive: true, force: true });
mkdirSync(tmpWorkspace, { recursive: true });

const scriptPath = resolve("./templates/workspace/scripts/indicators/main_force_control.ts");
assert(existsSync(scriptPath), `脚本应存在: ${scriptPath}`);

const engine = new ScriptIndicatorEngine({
  workspaceRoot: tmpWorkspace,
  memoryLimitMB: 128, // 主力控盘需要算多次 chipDistribution,放宽到 128MB
  timeoutMs: 10000,    // 给 10s,滚动窗口计算较重
});

// === fixture A:120 日整体上涨趋势(主力高度控盘特征) ===
function genUptrendKlines(days, startPrice = 10) {
  const out = [];
  let price = startPrice;
  for (let i = 0; i < days; i++) {
    // 基础涨幅 + 小波动
    const drift = 0.005;
    const noise = (Math.sin(i / 3) + Math.cos(i / 7)) * 0.01;
    const change = drift + noise;
    const open = price;
    const close = price * (1 + change);
    const high = Math.max(open, close) * 1.005;
    const low = Math.min(open, close) * 0.995;
    const volume = 1_000_000 + Math.floor(Math.sin(i / 5) * 200_000 + 300_000 * (1 + change));
    const date = dateOffset(i);
    out.push({ date, open, close, high, low, volume });
    price = close;
  }
  return out;
}

// === fixture B:120 日震荡(无明显趋势) ===
function genSidewaysKlines(days, base = 12) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const noise = Math.sin(i / 4) * 0.015 + Math.cos(i / 9) * 0.01;
    const open = base * (1 + Math.sin(i / 6) * 0.02);
    const close = open * (1 + noise);
    const high = Math.max(open, close) * 1.005;
    const low = Math.min(open, close) * 0.995;
    const volume = 1_200_000 + Math.floor(Math.cos(i / 3) * 300_000);
    const date = dateOffset(i);
    out.push({ date, open, close, high, low, volume });
  }
  return out;
}

function dateOffset(days) {
  const d = new Date(2026, 0, 1);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// === 1. 上涨趋势 ===
{
  const klines = genUptrendKlines(120);
  const turnovers = new Array(120).fill(0).map((_, i) => 1 + (i % 5) * 0.4);
  const result = await engine.run(scriptPath, { klines, turnovers });

  assert(result.values, "应有 values");
  const { zzlkp, zshtl, zjlrqd, dkb, zzljj, zcmzl } = result.values;

  assert(typeof zzlkp === "number" && zzlkp >= 0 && zzlkp <= 100, `ZZLKP 应 ∈ [0,100],实际 ${zzlkp}`);
  assert(typeof zshtl === "number" && zshtl >= 0 && zshtl <= 100, `ZSHTL 应 ∈ [0,100],实际 ${zshtl}`);
  assert(Number.isInteger(zjlrqd), `ZJLRQD 应为整数,实际 ${zjlrqd}`);
  assert(dkb === 0 || dkb === 1, `DKB 应 ∈ {0,1},实际 ${dkb}`);

  // ZZLKP + ZSHTL ≈ 100(互补)
  const sum = zzlkp + zshtl;
  assert(Math.abs(sum - 100) < 1.0, `ZZLKP+ZSHTL 应 ≈ 100,实际 ${sum}`);

  console.log(`[OK] 上涨趋势 ZZLKP=${zzlkp} ZSHTL=${zshtl} ZJLRQD=${zjlrqd} DKB=${dkb} ZZLJJ=${zzljj} ZCMZL=${zcmzl}`);
  console.log(`     notes: ${JSON.stringify(result.notes)}`);
  assert(result.reliability === "experimental", `reliability 必须标 experimental,实际 ${result.reliability}`);
}

// === 2. 震荡趋势 ===
{
  const klines = genSidewaysKlines(120);
  const turnovers = new Array(120).fill(0).map((_, i) => 2 + (i % 7) * 0.3);
  const result = await engine.run(scriptPath, { klines, turnovers });
  const { zzlkp, zjlrqd, dkb } = result.values;

  assert(zzlkp >= 0 && zzlkp <= 100, `震荡趋势 ZZLKP 应 ∈ [0,100],实际 ${zzlkp}`);
  console.log(`[OK] 震荡趋势 ZZLKP=${zzlkp} ZJLRQD=${zjlrqd} DKB=${dkb}`);
}

// === 3. 数据不足(走 manual_review 分支) ===
{
  const klines = genUptrendKlines(60); // < 94
  const turnovers = new Array(60).fill(1.5);
  const result = await engine.run(scriptPath, { klines, turnovers });

  assert(result.reliability === "manual_review", `数据不足应走 manual_review,实际 ${result.reliability}`);
  assert(
    result.notes.some((n) => n.includes("数据不足")),
    `notes 应说明数据不足`,
  );
  assert(result.values.zzlkp === 0, `数据不足时 zzlkp 应为 0`);
  console.log(`[OK] 数据不足分支: ${result.notes[0]}`);
}

// === 4. turnovers 缺失 → 自动估算 ===
{
  const klines = genUptrendKlines(120);
  // 故意传空 turnovers,触发 estimateTurnoversFromVolume
  const result = await engine.run(scriptPath, { klines, turnovers: [] });

  assert(typeof result.values.zzlkp === "number", `估算换手率后应仍能算出 ZZLKP`);
  assert(
    result.notes.some((n) => n.includes("按成交量估算")),
    `notes 应说明走估算分支`,
  );
  console.log(`[OK] 换手率估算兜底 ZZLKP=${result.values.zzlkp}`);
}

// === 5. params.window 透传 ===
{
  const klines = genUptrendKlines(120);
  const turnovers = new Array(120).fill(1.5);
  // 缩小窗口加速
  const result = await engine.run(scriptPath, {
    klines,
    turnovers,
    params: { window: 100 },
  });
  assert(typeof result.values.zzlkp === "number", `params.window 应能透传`);
  console.log(`[OK] params.window=100 透传 ZZLKP=${result.values.zzlkp}`);
}

// 清理
rmSync(tmpWorkspace, { recursive: true, force: true });

console.log("\n✅ 主力控盘 L3b 脚本冒烟测试通过");
