#!/usr/bin/env node
// T-484 · mg 控盘度最小 S1 历史序列回放引擎（隔离回放，只读冻结输入）
//
// 用法：node scripts/s1-chip-control-replay.mjs
// 输入：data/t484-s1/inputs/（klines / chips / fund-flows / excel-parsed-rows，全部冻结副本）
//       data/t484-s1/indicator-definition.json（mg-chip-control-v1.2-s1，引擎唯一口径来源）
// 输出：data/t484-s1/replay-rows.json、replay-summary.md、diff-vs-excel.md
//
// 边界：不联网、不接生产信号、不写生产用户资产；重跑对同一输入产生逐字节相同结果。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IN = join(ROOT, 'data/t484-s1/inputs');
const OUT = join(ROOT, 'data/t484-s1');
const DEF = JSON.parse(readFileSync(join(OUT, 'indicator-definition.json'), 'utf8'));

const REPLAY_DATES = [
  '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-31',
  '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
];

const klines = JSON.parse(readFileSync(join(IN, 'klines-tencent-qfq.json'), 'utf8'));
const chipsRaw = JSON.parse(readFileSync(join(IN, 'chips-history-prod.json'), 'utf8'));
const fundsRaw = JSON.parse(readFileSync(join(IN, 'fund-flows-tencent.json'), 'utf8'));
const excelRows = JSON.parse(readFileSync(join(IN, 'excel-parsed-rows.json'), 'utf8'));

// ---------- 基础工具 ----------
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r1 = (x) => Math.round(x * 10) / 10;

function maAt(series, n, i) {
  if (i + 1 < n) return null;
  return mean(series.slice(i - n + 1, i + 1));
}
function emaSeries(values, n) {
  const k = 2 / (n + 1);
  const out = [];
  let prev;
  for (const v of values) {
    prev = prev === undefined ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sun
  const diff = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

// ---------- 名称映射（以 6 位代码为唯一主键，名称仅展示） ----------
const nameMap = {};
for (const row of excelRows) {
  const m = row.stock.match(/(\d{6})/) || (row.stock.match(/^([^\s（(]+)/) ? null : null);
  const code = m ? m[1] : null;
  const nm = row.stock.match(/(?:^|\s)([\u4e00-\u9fa5A-Za-z*]+?)(?=[\s（(]|$)/);
  if (code && nm && !nameMap[code]) nameMap[code] = nm[1];
}

// ---------- 每标的序列构建 ----------
const symbols = Object.keys(klines);

function buildContext(symbol) {
  const bars = klines[symbol].slice().sort((a, b) => a.date < b.date ? -1 : 1);
  const dates = bars.map((b) => b.date);
  const closes = bars.map((b) => b.close);
  const vols = bars.map((b) => b.vol);
  // V1.0 综合价：(3*CLOSE+OPEN+HIGH+LOW)/6（生产 methods/控盘度指标V1.0.md 原文）
  const comp = bars.map((b) => (3 * b.close + b.open + b.high + b.low) / 6);
  const ema12 = emaSeries(comp, 12);
  const ema36 = emaSeries(comp, 36);

  const chips = {};
  for (const r of chipsRaw[symbol] || []) {
    chips[r.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')] = r;
  }
  const fund = {};
  for (const r of (fundsRaw[symbol] || [])) fund[r.date] = r;

  // 月聚合（周期收盘确认：只用最后交易日 <= T 的已收月）
  const monthGroups = new Map();
  for (const b of bars) {
    const key = b.date.slice(0, 7);
    if (!monthGroups.has(key)) monthGroups.set(key, []);
    monthGroups.get(key).push(b);
  }
  const monthCloses = [...monthGroups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, bs]) => ({ month: key, close: bs[bs.length - 1].close, lastDate: bs[bs.length - 1].date }));

  // 周聚合（ISO 周，周一为界，周收盘=该周最后交易日收盘）
  const weekGroups = new Map();
  for (const b of bars) {
    const key = mondayOf(b.date);
    if (!weekGroups.has(key)) weekGroups.set(key, []);
    weekGroups.get(key).push(b);
  }
  const weekCloses = [...weekGroups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, bs]) => ({ week: key, close: bs[bs.length - 1].close, lastDate: bs[bs.length - 1].date }));

  // 筹码相邻同值检测：连续 >= 3 个可得快照同值（上游疑似未更新）
  const chipsDates = Object.keys(chips).sort();
  const staleRun = {};
  let runStart = 0;
  for (let i = 1; i <= chipsDates.length; i++) {
    const prev = chipsDates[i - 1];
    const cur = chipsDates[i];
    if (cur && chips[cur].conc90 === chips[prev].conc90) continue;
    if (i - runStart >= 3) {
      for (let j = runStart; j < i; j++) staleRun[chipsDates[j]] = i - runStart;
    }
    runStart = i;
  }

  return { symbol, bars, dates, closes, vols, ema12, ema36, chips, fund, monthCloses, weekCloses, staleRun };
}

function monthlyPermission(ctx, di) {
  const asOf = ctx.dates[di];
  const completed = ctx.monthCloses.filter((m) => m.lastDate <= asOf);
  if (completed.length < 10) return { ok: false, insufficient: true, detail: `已收月仅 ${completed.length} 个` };
  const last = completed[completed.length - 1];
  const ma10 = mean(completed.slice(-10).map((m) => m.close));
  return {
    ok: last.close > ma10,
    insufficient: false,
    lastMonth: last.month,
    lastMonthClose: last.close,
    ma10Month: Math.round(ma10 * 1000) / 1000,
  };
}

function weeklyStructure(ctx, di) {
  const asOf = ctx.dates[di];
  const completed = ctx.weekCloses.filter((w) => w.lastDate <= asOf);
  if (completed.length < 10) return { ok: false, weak: true, insufficient: true, detail: `已收周仅 ${completed.length} 个` };
  const last = completed[completed.length - 1];
  const ma5 = mean(completed.slice(-5).map((w) => w.close));
  const ma10 = mean(completed.slice(-10).map((w) => w.close));
  const structureOk = ma5 > ma10 && last.close >= ma10;
  return {
    ok: structureOk,
    weak: !(ma5 > ma10), // G-F：MA5周 <= MA10周 视为周线转弱
    insufficient: false,
    lastWeek: last.week,
    ma5w: Math.round(ma5 * 1000) / 1000,
    ma10w: Math.round(ma10 * 1000) / 1000,
  };
}

// ---------- 逐 (symbol, date) 回放 ----------
function replayCell(ctx, dateStr) {
  const di = ctx.dates.indexOf(dateStr);
  if (di < 0) return { symbol: ctx.symbol, date: dateStr, error: 'K 线无该交易日' };
  const bar = ctx.bars[di];
  const gaps = [];       // S1 裁定使用记录
  const missing = [];    // 缺失链路
  const notes = [];

  const ma5v = maAt(ctx.vols, 5, di);
  const ma20v = maAt(ctx.vols, 20, di);
  const ma60v = maAt(ctx.vols, 60, di);
  const ma5vPrev = maAt(ctx.vols, 5, di - 1);
  const ma5vPrev2 = maAt(ctx.vols, 5, di - 2);
  const ma60vPrev = maAt(ctx.vols, 60, di - 1);
  const ma25 = maAt(ctx.closes, 25, di);
  const ma25Prev = maAt(ctx.closes, 25, di - 1);
  const ma14 = maAt(ctx.closes, 14, di);
  const close = bar.close;

  // ---- 因子② 量能（CAL-2 真实 MA60）----
  let f2 = null;
  const ratio20 = ma5v != null && ma20v != null ? r1((ma5v / ma20v) * 1000) / 1000 : null; // 旧记录事实（MA20 代理），仅对照
  if (ma60v == null) {
    missing.push('②K线不足60根');
  } else {
    const ratio = ma5v / ma60v;
    const rising3 = ma5vPrev != null && ma5vPrev2 != null && ma5v > ma5vPrev && ma5vPrev > ma5vPrev2;
    const justCrossed = ma60vPrev != null && ma5vPrev != null && ma5vPrev <= ma60vPrev && ma5v > ma60v;
    const improving = ma5vPrev != null && ma5v > ma5vPrev;
    const hugeVol = bar.vol > 3 * ma60v;
    const stagnant = ctx.closes[di - 1] !== undefined && close <= ctx.closes[di - 1];
    let score, tier;
    if (ratio >= 1.0) {
      if (rising3) { score = 85; tier = 'MA5量>MA60量 且连续3日上行'; }
      else if (justCrossed) { score = 75; tier = '当日刚上穿MA60量'; }
      else { score = 75; tier = '站上MA60量但未确认持续性'; gaps.push('G-A'); }
    } else if (ratio >= 0.95) {
      if (improving) { score = 60; tier = '接近MA60量(0.95-1.00)且MA5量改善'; }
      else { score = 45; tier = '接近MA60量但MA5量无改善'; gaps.push('G-B'); }
    } else if (ratio >= 0.85) {
      score = 45; tier = '低于MA60量但差距不大(0.85-0.95)';
    } else {
      score = 25; tier = 'ratio<0.85'; gaps.push('G-C');
    }
    if (hugeVol && stagnant) {
      if (score > 40) score = 40;
      tier += '+单日巨量滞涨封顶40'; gaps.push('G-D');
    }
    f2 = {
      score,
      ratio: Math.round(ratio * 1000) / 1000,
      ratio_ma20_proxy: ratio20,
      ma5v: Math.round(ma5v), ma60v: Math.round(ma60v),
      rising3, justCrossed, hugeVol, stagnant,
      tier,
    };
  }

  // ---- 因子③ 价格趋势 ----
  const monthly = monthlyPermission(ctx, di);
  const weekly = weeklyStructure(ctx, di);
  let f3 = null;
  if (ma25 == null || ma14 == null || monthly.insufficient) {
    missing.push('③均线或月线窗口不足');
    if (monthly.insufficient) notes.push(`月线数据不足：${monthly.detail}`);
  } else {
    const above25 = close > ma25;
    const ma25Up = ma25Prev != null && ma25 > ma25Prev;
    let score, tier;
    if (monthly.ok && weekly.ok && above25 && ma25Up) { score = 90; tier = '月许可+周未坏+站上MA25且MA25向上'; }
    else if (monthly.ok && weekly.ok && above25) { score = 75; tier = '月许可+周未坏+突破MA25'; }
    else if (monthly.ok && !weekly.ok && above25) { score = 60; tier = '月许可+周线修复中+站上MA25'; }
    else if (!monthly.ok && above25) { score = 45; tier = '月线未修复+短暂站上MA25'; }
    else if (!above25 && !ma25Up) { score = 25; tier = '收盘<MA25且MA25向下'; }
    else { score = 40; tier = '收盘<MA25但MA25未向下'; gaps.push('G-G'); }
    const below14 = close < ma14;
    if ((below14 || weekly.weak) && score > 40) {
      score = 40;
      tier += below14 ? '+跌破MA14封顶40' : '+周线转弱封顶40';
    }
    f3 = {
      score,
      tier,
      above25, ma25Up, below14,
      monthly: `${monthly.ok ? '许可' : '未修复'}（${monthly.lastMonth}收${monthly.lastMonthClose} vs MA10月${monthly.ma10Month}）`,
      weekly: `${weekly.ok ? '未坏' : weekly.weak ? '转弱' : '修复中'}（MA5周${weekly.ma5w} vs MA10周${weekly.ma10w}）`,
      monthly_ok: monthly.ok,
      weekly_ok: weekly.ok,
      weekly_weak: !!weekly.weak,
    };
  }

  // ---- 因子④ 资金流 ----
  let f4 = null;
  const winDates = ctx.dates.slice(Math.max(0, di - 4), di + 1);
  const winRows = winDates.map((d) => ctx.fund[d]);
  if (winRows.length < 5 || winRows.some((r) => !r)) {
    missing.push('④资金流5日窗口不完整');
  } else {
    const sum = winRows.reduce((s, r) => s + r.main_net, 0);
    const posDays = winRows.filter((r) => r.main_net > 0).length;
    let score, tier;
    if (sum > 0 && posDays >= 3) { score = 80; tier = `5日净流入+${(sum / 1e6).toFixed(2)}百万/${posDays}日为正`; gaps.push('G-H'); }
    else if (sum > 0 && posDays <= 2) { score = 65; tier = `5日净流入+${(sum / 1e6).toFixed(2)}百万/集中${posDays}日`; }
    else if (sum === 0) { score = 50; tier = '5日合计为零'; }
    else if (sum < 0 && ma25 != null && close >= ma25) { score = 35; tier = `5日净流出${(sum / 1e6).toFixed(2)}百万/价格未破MA25`; gaps.push('G-I'); }
    else { score = 20; tier = `5日净流出${(sum / 1e6).toFixed(2)}百万/价格破位`; }
    if (sum > 0 && ma25 != null && close < ma25 && score > 50) { score = 50; tier += '+净流入但价格破位封顶50'; }
    f4 = {
      score, tier,
      window: `${winDates[0]}~${winDates[winDates.length - 1]}`,
      sum_m: Math.round((sum / 1e6) * 100) / 100,
      pos_days: posDays,
    };
  }

  // ---- 因子① 筹码（CAL-1 腾讯口径 + V1.2 修正）----
  let f1 = null;
  const isEtf = ctx.symbol.startsWith('15') || ctx.symbol.startsWith('51') || ctx.symbol.startsWith('58');
  const chipT = ctx.chips[dateStr];
  if (isEtf) {
    missing.push('①ETF筹码概念不适用（永不计分，评分层显式跳过）');
  } else if (!chipT) {
    missing.push(`①${dateStr}筹码快照缺失`);
  } else {
    const conc90 = chipT.conc90;
    let base;
    if (conc90 <= 12) base = 90;
    else if (conc90 <= 18) base = 80;
    else if (conc90 <= 25) base = 65;
    else if (conc90 <= 35) base = 45;
    else base = 25;

    // T-5 同口径值（按 K 线交易日历回数）
    const d5 = ctx.dates[di - 5];
    const chipT5 = d5 ? ctx.chips[d5] : null;
    let delta = null, dirLabel = '未知', dirKnown = false;
    if (chipT5) {
      delta = Math.round((conc90 - chipT5.conc90) * 100) / 100;
      dirKnown = true;
      dirLabel = delta <= -0.5 ? '明显集中' : delta <= 0.5 ? '基本不变' : delta <= 1.5 ? '开始松动' : '明显松动';
    } else if (d5) {
      notes.push(`筹码方向未知：T-5(${d5})快照缺失，只用绝对分档不加减分`);
    }

    let adjust = 0; let corr = [];
    const highControl = base >= 80;
    const max5Close = Math.max(...ctx.closes.slice(Math.max(0, di - 4), di + 1));
    const pullback = close < max5Close;
    if (highControl && pullback && dirKnown) {
      const shrink = ma5v != null && bar.vol < 0.8 * ma5v;
      const support = ma25 != null && ma14 != null && close >= ma25 && close >= ma14;
      if (delta <= -0.5 && shrink && support) { adjust = 10; corr = ['高控回调+明显集中+缩量+支撑未破']; }
      else if (delta <= 0.5 && shrink && support) { adjust = 5; corr = ['高控回调+未松动+缩量+支撑未破']; }
      else if (delta > 1.5) { adjust = -20; corr = ['高控回调+明显松动']; }
      else if (delta > 0.5) { adjust = -10; corr = ['高控回调+开始松动']; }
    } else if (!highControl && dirKnown) {
      const priceBelowCost = chipT.close < chipT.avg_cost;
      const lowProfit = chipT.profit_rate < 50;
      if (priceBelowCost && lowProfit && delta > 0) { adjust = -10; corr = ['中低控+现价<成本+获利<50%+浓度扩大']; }
    }
    const f1Score = clamp(base + adjust, 0, 100);

    const stale = ctx.staleRun[dateStr];
    if (stale) notes.push(`数据质量：conc90 与前 ${stale - 1} 个可得快照同值（上游疑似隔日更新，方向判定可能失真）`);
    if (chipT.close && Math.abs(chipT.close - close) / close > 0.005) {
      notes.push(`口径提示：筹码快照收盘价(${chipT.close})与前复权K线收盘(${close})差异>0.5%`);
    }

    f1 = {
      score: f1Score, base, adjust, correction: corr,
      conc90, conc90_t5: chipT5 ? chipT5.conc90 : null, delta, dir: dirLabel, dir_known: dirKnown,
      t5_date: d5 || null,
      profit_rate: chipT.profit_rate, avg_cost: chipT.avg_cost,
      tier: `conc90=${conc90}→基础${base}${adjust ? `${adjust > 0 ? '+' : ''}${adjust}` : ''}（方向${dirLabel}）`,
    };
  }

  // ---- KP（V1.0 对照项：((EMA12 − REF(EMA36,1)) / REF(EMA36,1) × 100 + 50) × 1.25）----
  const e12 = ctx.ema12[di], e36p = ctx.ema36[di - 1];
  const kp = e12 != null && e36p ? Math.round((((e12 - e36p) / Math.max(e36p, 0.01)) * 100 + 50) * 1.25 * 10) / 10 : null;

  // ---- 总分与状态（CAL-3）----
  const factors = { f1, f2, f3, f4 };
  const anyMissing = missing.length > 0;
  let total = null, band = null, status, hardDown = [];
  if (!anyMissing) {
    total = r1(f1.score * DEF.weights.f1_chips + f2.score * DEF.weights.f2_volume + f3.score * DEF.weights.f3_trend + f4.score * DEF.weights.f4_fund);
    band = total >= 70 ? '关注买入（弱信号）' : total >= 60 ? '观察池候选' : '不触发关注';
    if (!f3.monthly_ok) hardDown.push('月线未修复');
    if (f2.ratio < 0.85) hardDown.push('MA5量长期低于MA60量');
    if (!f3.above25) hardDown.push('收盘未站上MA25');
    if (f3.below14) hardDown.push('收盘跌破MA14');
    const candidate = total >= 70 && f3.above25 && f2.ratio > 1.0 && f3.monthly_ok && f3.weekly_ok && hardDown.length === 0;
    status = hardDown.length ? `观察（硬性降级：${hardDown.join('、')}）` : candidate ? '建仓候选' : band;
  } else {
    status = '不可完整评分（观察）';
  }

  return {
    symbol: ctx.symbol, name: nameMap[ctx.symbol] || '', date: dateStr,
    close, as_of: {
      kline: dateStr,
      chips_t: chipT ? dateStr : null,
      chips_t5: f1 ? f1.t5_date : null,
      fund_window: f4 ? f4.window : null,
    },
    f1, f2, f3, f4, kp,
    total, band, status, hard_downgrade: hardDown,
    missing, gaps, notes,
  };
}

// ---------- 主流程 ----------
const cells = [];
for (const symbol of symbols) {
  const ctx = buildContext(symbol);
  for (const d of REPLAY_DATES) cells.push(replayCell(ctx, d));
}

writeFileSync(join(OUT, 'replay-rows.json'), JSON.stringify({
  definition: DEF.id,
  definition_version: DEF.version,
  replay_window: REPLAY_DATES,
  generated_by: 'scripts/s1-chip-control-replay.mjs',
  rows: cells,
}, null, 1));

// ---------- 汇总矩阵 ----------
const etfs = symbols.filter((s) => s.startsWith('15') || s.startsWith('51'));
const stocks = symbols.filter((s) => !etfs.includes(s));
const lines = [];
lines.push(`# mg 控盘度 V1.2-S1 回放汇总矩阵（${REPLAY_DATES[0]} ~ ${REPLAY_DATES[REPLAY_DATES.length - 1]}）`);
lines.push('');
lines.push(`口径：${DEF.id} v${DEF.version}｜${stocks.length} 股 + ${etfs.length} ETF｜单位格=总评分/状态`);
lines.push('');
const head = '| 标的 | ' + REPLAY_DATES.map((d) => d.slice(5)).join(' | ') + ' |';
lines.push(head);
lines.push('|' + '---|'.repeat(REPLAY_DATES.length + 1));
for (const s of symbols) {
  const row = [`**${s}** ${nameMap[s] || ''}`];
  for (const d of REPLAY_DATES) {
    const c = cells.find((x) => x.symbol === s && x.date === d);
    if (!c) { row.push('—'); continue; }
    if (c.total == null) row.push(`不可评分·观察`);
    else {
      const tag = c.status === '建仓候选' ? '★' : c.hard_downgrade.length ? '▽' : '';
      row.push(`${c.total}${tag}`);
    }
  }
  lines.push('| ' + row.join(' | ') + ' |');
}
lines.push('');
lines.push('★=建仓候选｜▽=硬性降级为观察｜不可评分·观察=缺关键因子不生成总分（CAL-3，含 ETF 筹码永不适用）');
lines.push('');
writeFileSync(join(OUT, 'replay-summary.md'), lines.join('\n'));

// ---------- 与 Excel 对照 ----------
function excelComparable() {
  const map = new Map();
  for (const r of excelRows) {
    const code = (r.stock.match(/(\d{6})/) || [])[1];
    if (!code) continue;
    const e = map.get(`${code}|${r.date}`) || {};
    const chipNum = /(\d{1,2}\.\d{1,2})/.exec((r.chip90 || '').replace('缺失', ''));
    if (chipNum) e.chip90_excel = parseFloat(chipNum[1]);
    const fundNum = /([+-]\d+\.\d+)百[万一]/.exec(r.fund || '');
    if (fundNum) e.fund_excel_m = parseFloat(fundNum[1]);
    const ratio = /(\d\.\d{3})/.exec(r.score || '');
    if (ratio) e.ratio_excel = parseFloat(ratio[1]);
    const norm = /归一化\s*(\d+(?:\.\d+)?)/.exec(r.score || '');
    if (norm) e.norm_excel = parseFloat(norm[1]);
    e.score_text = r.score;
    map.set(`${code}|${r.date}`, e);
  }
  return map;
}
const exMap = excelComparable();

const diffLines = [];
diffLines.push('# T-484 S1 回放 vs Excel 历史行：逐因子差异表');
diffLines.push('');
diffLines.push('对照基准：mg Excel 8/26~9/4 共 115 行（engine 覆盖 120 格，Excel 缺 5 格）。差异码：MATCH=一致；D1=量能 MA20 代理修正（CAL-2）；D4=归一化 vs 缺因子不计分（CAL-3）；D2=筹码口径已裁决为腾讯（CAL-1）；EX-ARITH=Excel 算术疑误；NO-ROW=Excel 无该行。');
diffLines.push('');
diffLines.push('## 因子① 筹码绝对值（chip90）');
diffLines.push('');
diffLines.push('| 标的 | 日期 | Excel | 引擎(腾讯) | 差异 |');
diffLines.push('|---|---|---|---|---|');
let chipMatch = 0, chipDiff = 0, chipNoExcel = 0;
for (const c of cells) {
  const e = exMap.get(`${c.symbol}|${c.date}`);
  if (!e || e.chip90_excel === undefined) continue;
  const eng = c.f1 ? c.f1.conc90 : null;
  if (eng == null) continue;
  if (Math.abs(eng - e.chip90_excel) <= 0.01) { chipMatch++; diffLines.push(`| ${c.symbol} | ${c.date} | ${e.chip90_excel} | ${eng} | MATCH |`); }
  else { chipDiff++; diffLines.push(`| ${c.symbol} | ${c.date} | ${e.chip90_excel} | ${eng} | D2/需核 |`); }
}

diffLines.push('');
diffLines.push('## 因子④ 主力资金 5 日合计（百万）');
diffLines.push('');
diffLines.push('| 标的 | 日期 | Excel | 引擎 | 差异 |');
diffLines.push('|---|---|---|---|---|');
let fundMatch = 0, fundRound = 0, fundDiff = 0;
for (const c of cells) {
  const e = exMap.get(`${c.symbol}|${c.date}`);
  if (!e || e.fund_excel_m === undefined || !c.f4) continue;
  const eng = c.f4.sum_m;
  if (Math.abs(eng - e.fund_excel_m) < 0.005) { fundMatch++; diffLines.push(`| ${c.symbol} | ${c.date} | ${e.fund_excel_m.toFixed(2)} | ${eng.toFixed(2)} | MATCH |`); }
  else if (Math.abs(eng - e.fund_excel_m) <= 0.06) { fundRound++; diffLines.push(`| ${c.symbol} | ${c.date} | ${e.fund_excel_m.toFixed(2)} | ${eng.toFixed(2)} | ROUND(舍入级) |`); }
  else { fundDiff++; diffLines.push(`| ${c.symbol} | ${c.date} | ${e.fund_excel_m.toFixed(2)} | ${eng.toFixed(2)} | EX-ARITH(疑)/差${(eng - e.fund_excel_m).toFixed(2)} |`); }
}

diffLines.push('');
diffLines.push('## 因子② 量能 ratio（Excel 标注值=MA20 代理 vs 引擎真实 MA60）');
diffLines.push('');
diffLines.push('| 标的 | 日期 | Excel标注(MA20) | 引擎MA20(旧事实) | 引擎MA60(正式) | 引擎分 |');
diffLines.push('|---|---|---|---|---|---|');
let ratioRows = 0;
for (const c of cells) {
  const e = exMap.get(`${c.symbol}|${c.date}`);
  if (!e || e.ratio_excel === undefined || !c.f2) continue;
  ratioRows++;
  diffLines.push(`| ${c.symbol} | ${c.date} | ${e.ratio_excel} | ${c.f2.ratio_ma20_proxy ?? '—'} | ${c.f2.ratio} | ${c.f2.score} |`);
}

diffLines.push('');
diffLines.push('## 总分口径（Excel 临时归一化 vs 引擎缺因子不计分）');
diffLines.push('');
diffLines.push('| 标的 | 日期 | Excel 表述 | 引擎总分/状态 | 差异解释 |');
diffLines.push('|---|---|---|---|---|');
for (const c of cells) {
  const e = exMap.get(`${c.symbol}|${c.date}`);
  if (!e || e.norm_excel === undefined) continue;
  const eng = c.total == null ? '不可完整评分（观察）' : `${c.total}/${c.status}`;
  diffLines.push(`| ${c.symbol} | ${c.date} | 临时归一化 ${e.norm_excel} | ${eng} | D4：CAL-3 裁决缺因子不归一化${c.f1 ? '' : '（当日筹码/T-5 缺失）'} |`);
}

diffLines.push('');
diffLines.push('## 统计');
diffLines.push('');
const scored = cells.filter((c) => c.total != null);
const unscored = cells.filter((c) => c.total == null);
diffLines.push(`- 筹码绝对值：MATCH ${chipMatch} / 差异 ${chipDiff}`);
diffLines.push(`- 资金流合计：MATCH ${fundMatch} / 舍入级 ${fundRound} / 实质差异 ${fundDiff}${fundDiff ? '（见 EX-ARITH 行）' : ''}`);
diffLines.push(`- 量能 ratio 可对照行：${ratioRows}（Excel 全部为 MA20 代理口径，D1 修正见汇总）`);
diffLines.push(`- 引擎 120 格：可完整评分 ${scored.length} / 不可完整评分 ${unscored.length}（其中 ETF ${etfs.length * REPLAY_DATES.length} 格、股票缺口 ${unscored.length - etfs.length * REPLAY_DATES.length} 格）`);
writeFileSync(join(OUT, 'diff-vs-excel.md'), diffLines.join('\n'));

// ---------- 控制台摘要 ----------
console.log(`definition: ${DEF.id} v${DEF.version}`);
console.log(`cells: ${cells.length} (${symbols.length} symbols × ${REPLAY_DATES.length} dates)`);
console.log(`scored: ${scored.length}, unscored: ${unscored.length} (etf ${etfs.length}, stock-gap ${unscored.length - etfs.length * REPLAY_DATES.length})`);
console.log(`chip90 match ${chipMatch}/${chipMatch + chipDiff}; fund match ${fundMatch}/${fundMatch + fundDiff}`);
const kp420 = cells.filter((c) => c.symbol === '000420').map((c) => `${c.date.slice(5)}:${c.kp}`).join(' ');
console.log(`KP(000420) 参照 T-478 应为 59~61 区间: ${kp420}`);
const gapUse = {};
for (const c of cells) for (const g of c.gaps) gapUse[g] = (gapUse[g] || 0) + 1;
console.log('S1 裁定使用统计:', JSON.stringify(gapUse));
