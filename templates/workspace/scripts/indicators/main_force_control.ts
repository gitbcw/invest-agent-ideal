/**
 * L3b 沙箱脚本:主力控盘指标
 *
 * 来源:通达信主力控盘公式(客户提供)
 *
 * 公式:
 *   ZLCM  := EMA(WINNER(CLOSE)*70, 3);                              // 主力筹码
 *   SHCM  := EMA((WINNER(CLOSE*1.1)-WINNER(CLOSE*0.9))*80, 3);      // 散户筹码
 *   ZSHTL := SHCM/(ZLCM+SHCM)*100;                                  // 散户套牢率
 *   ZZLKP := ZLCM/(ZLCM+SHCM)*100;                                  // 主力控盘度(核心)
 *   ZCMZL := MA(ZLCM+SHCM, 13);                                     // 总筹码量
 *   ZSHJJ := EMA(ZSHTL, 89);                                        // 散户套牢均线
 *   ZZLJJ := EMA(ZZLKP, 89);                                        // 主力控盘均线
 *   ZJLRQD:= INTPART(ZZLKP - ZZLJJ);                                // 资金流入强度
 *   DKB   := IF(ZZLKP-REF(ZZLKP,1) > ZSHTL-REF(ZSHTL,1), 1, 0);     // 控盘动作 1/0
 *
 * 数据源说明(必须告知):
 *   - 筹码分布基于换手率衰减模型估算(computeChipDistribution),非真实筹码
 *   - 70 / 80 / 13 / 89 系数为原作者经验值,适用性因股而异
 *   - 换手率优先用 ctx.turnovers,缺失时按成交量估算
 *
 * 输出(取最近一日):
 *   zzlkp    主力控盘度 0-100(核心)
 *   zjlrqd   资金流入强度(整数)
 *   dkb      控盘动作 1/0
 *   zshtl    散户套牢率 0-100
 *   zzljj    主力控盘均线(用于判断 ZZLKP 偏离)
 *
 * 注意:沙箱里不允许 console.log,调试信息走 notes。
 */

import {
  computeEMA,
  computeMA,
  computeChipDistribution,
  winner,
  estimateTurnoversFromVolume,
  type IndicatorContext,
  type IndicatorResult,
} from "invest-agent-runtime";

export const definition = {
  key: "main_force_control",
  name: "主力控盘度(通达信 ZZLKP 模型)",
  reliability: "experimental" as const,
  dataRequirements: ["daily_kline", "turnover"],
  outputSchema: {
    zzlkp: "number",
    zjlrqd: "number",
    dkb: "number",
    zshtl: "number",
    zzljj: "number",
    zcmzl: "number",
  },
};

const EMA_ZLCM_PERIOD = 3;
const EMA_SHCM_PERIOD = 3;
const MA_ZCMZL_PERIOD = 13;
const EMA_LONG_PERIOD = 89;

export function compute(ctx: IndicatorContext): IndicatorResult {
  const { klines, turnovers: rawTurnovers, params } = ctx;

  // 数据最少要 EMA_LONG_PERIOD + 几天预热
  const minLen = EMA_LONG_PERIOD + 5;
  if (klines.length < minLen) {
    return {
      values: { zzlkp: 0, zjlrqd: 0, dkb: 0, zshtl: 0, zzljj: 0, zcmzl: 0 },
      notes: [`数据不足 ${minLen} 日(实际 ${klines.length} 日),无法计算主力控盘`],
      reliability: "manual_review",
    };
  }

  // 换手率兜底:有则用,无则按成交量估算
  let turnovers = rawTurnovers;
  const needEstimate =
    !turnovers ||
    turnovers.length !== klines.length ||
    turnovers.every((t) => typeof t !== "number");
  if (needEstimate) {
    turnovers = estimateTurnoversFromVolume(klines, 60);
  }

  // 限制滚动窗口:越大越准但越慢。默认 120 天,可被 params.window 覆盖
  const windowSize = Math.min(
    klines.length,
    typeof params?.window === "number" ? params.window : 120,
  );
  const startIdx = klines.length - windowSize;
  const windowKlines = klines.slice(startIdx);
  const windowTurnovers = turnovers.slice(startIdx);

  // 第 1 步:对每天 i 用 [0..i] 滚动窗口算 chipDistribution + WINNER
  // 复杂度 O(N^2 * bins),N=120 bins~5000 ≈ 7M 次操作,5s 内可完成
  const winnerClose: number[] = new Array(windowKlines.length);
  const winnerUp: number[] = new Array(windowKlines.length);
  const winnerDn: number[] = new Array(windowKlines.length);

  for (let i = 0; i < windowKlines.length; i++) {
    const sub = windowKlines.slice(0, i + 1);
    const subT = windowTurnovers.slice(0, i + 1);
    const dist = computeChipDistribution(sub, subT);

    const close = windowKlines[i].close;
    winnerClose[i] = winner(close, dist);
    winnerUp[i] = winner(close * 1.1, dist);
    winnerDn[i] = winner(close * 0.9, dist);
  }

  // 第 2 步:ZLCM / SHCM 时间序列
  const zlcmRaw = winnerClose.map((w) => w * 70);
  const shcmRaw = winnerUp.map((wUp, i) => (wUp - winnerDn[i]) * 80);

  const zlcmSeries = computeEMA(zlcmRaw, EMA_ZLCM_PERIOD).values;
  const shcmSeries = computeEMA(shcmRaw, EMA_SHCM_PERIOD).values;

  // 第 3 步:派生比率(避免除零)
  const zshtlSeries = zlcmSeries.map((z, i) => {
    const denom = z + shcmSeries[i];
    return denom > 1e-9 ? (shcmSeries[i] / denom) * 100 : 0;
  });
  const zzlkpSeries = zlcmSeries.map((z, i) => {
    const denom = z + shcmSeries[i];
    return denom > 1e-9 ? (z / denom) * 100 : 0;
  });

  // 第 4 步:总筹码量 MA(13)
  const zcmzlSeries = computeMA(
    zlcmSeries.map((z, i) => z + shcmSeries[i]),
    MA_ZCMZL_PERIOD,
  ).values.map((v) => (v === null ? 0 : v));

  // 第 5 步:长期均线
  const zshjjSeries = computeEMA(zshtlSeries, EMA_LONG_PERIOD).values;
  const zzljjSeries = computeEMA(zzlkpSeries, EMA_LONG_PERIOD).values;

  // 第 6 步:取最后一日
  const last = windowKlines.length - 1;
  const zzlkp = zzlkpSeries[last];
  const zshtl = zshtlSeries[last];
  const zzljj = zzljjSeries[last];
  const zcmzl = zcmzlSeries[last];

  // 资金流入强度:INTPART(ZZLKP - ZZLJJ)
  const zjlrqdRaw = zzlkp - zzljj;
  const zjlrqd = zjlrqdRaw >= 0 ? Math.floor(zjlrqdRaw) : Math.ceil(zjlrqdRaw);

  // 控盘动作:今日 ZZLKP 增量是否 > 今日 ZSHTL 增量
  const dkb =
    last >= 1 &&
    zzlkpSeries[last] - zzlkpSeries[last - 1] >
      zshtlSeries[last] - zshtlSeries[last - 1]
      ? 1
      : 0;

  // 第 7 步:简单信号判断(进 notes,不做决策)
  const notes: string[] = [];
  if (zzlkp > 75) {
    notes.push(`ZZLKP=${zzlkp.toFixed(2)} 高度控盘(>75)`);
  } else if (zzlkp > 50) {
    notes.push(`ZZLKP=${zzlkp.toFixed(2)} 中度控盘(50-75)`);
  } else if (zzlkp < 10) {
    notes.push(`ZZLKP=${zzlkp.toFixed(2)} 控盘较弱(<10)`);
  } else {
    notes.push(`ZZLKP=${zzlkp.toFixed(2)}`);
  }
  if (zjlrqd >= 10) {
    notes.push(`ZJLRQD=${zjlrqd} 主力资金流入明显(>=10)`);
  } else if (zjlrqd <= -10) {
    notes.push(`ZJLRQD=${zjlrqd} 主力资金流出明显(<=-10)`);
  }
  if (dkb === 1) {
    notes.push(`DKB=1 主力行为强于散户(今日 ZZLKP 增量 > ZSHTL 增量)`);
  }
  notes.push(
    `数据基础:换手率${needEstimate ? "按成交量估算" : "来自行情源"},窗口 ${windowSize} 日`,
  );

  return {
    values: {
      zzlkp: round2(zzlkp),
      zjlrqd,
      dkb,
      zshtl: round2(zshtl),
      zzljj: round2(zzljj),
      zcmzl: round2(zcmzl),
    },
    notes,
    reliability: "experimental",
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
