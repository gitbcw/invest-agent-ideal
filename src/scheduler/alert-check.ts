import { db } from "../db/index.js";
import { alertEvents, alertRules, alertSignalStates, alerts, indicatorResults } from "../db/schema.js";
import { getQuote } from "../services/stock.js";
import { getKline, getMinuteKline } from "../services/stock.js";
import { analyzeIndicators, computeMA, computeMACD, computeKDJ } from "../services/indicators.js";
import { logger } from "../lib/logger.js";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getSignalSetting } from "../handlers/signal-config.js";
import { getCapitalFlowBatch, type CapitalFlow } from "../services/eastmoney.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { portfolioBackend, watchlistBackend, planBackend } from "../lib/data-backend.js";
import { dailyPlanBackend } from "../lib/daily-plan-backend.js";
import { ensureWorkspace } from "../lib/workspace.js";
import { WorkspaceStore, type RiskLevel } from "../lib/workspace-store.js";
import { runL3aIndicatorsForStock } from "../services/l3a-indicator-runner.js";
import { runL3bIndicatorsForStock } from "../services/l3b-indicator-runner.js";

/** 巡检结果 */
export interface AlertItem {
  stockCode: string;
  stockName: string;
  type: "price" | "volume" | "indicator";
  message: string;
  severity: "high" | "medium" | "low";
  /** WP3a 引入:更细粒度的风险分级,由 risk_taxonomy.yaml 决定。 */
  priority: RiskLevel;
  signalKey: string;
  relationToPlan: string;
  price?: number;
}

interface PlanItem {
  code: string;
  name: string;
  pool: "holding" | "watchlist" | "manual";
  support: number | null;
  resistance: number | null;
  targetPrice?: number | null;
  stopLoss?: number | null;
  observe: string[];
  notes?: string | null;
  source?: "daily_review" | "manual";
}

interface ParsedThreshold {
  value?: string | number;
}

/**
 * 行情巡检 — 检查自选股异动
 * A 股开盘期间每 5 分钟调用一次
 */
export async function runAlertCheck(options: { force?: boolean; userId?: string; instanceId?: string } = {}): Promise<AlertItem[]> {
  const userId = options.userId ?? DEFAULT_USER_ID;
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  // 检查是否在交易时间
  if (!options.force && !isTradingTime()) {
    return [];
  }

  const [watchItemsRaw, positionsRaw, customAlerts] = await Promise.all([
    watchlistBackend.list(userId, instanceId),
    portfolioBackend.listActive(userId, instanceId),
    db.select().from(alerts).where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId), eq(alerts.enabled, true))),
  ]);
  // 适配 backend 返回的字段名(legacy 调用方仍用 stockCode/stockName)
  const watchItems = watchItemsRaw.map((w) => ({ stockCode: w.code, stockName: w.name }));
  const positions = positionsRaw.map((p) => ({ stockCode: p.code, stockName: p.name }));
  if (watchItems.length === 0 && positions.length === 0 && customAlerts.length === 0) return [];

  const customAlertCodes = [...new Set(customAlerts.map((alert) => alert.stockCode))];
  const customAlertNameMap = new Map<string, string>();
  if (customAlertCodes.length > 0) {
    const rules = await db
      .select({ stockCode: alertRules.stockCode, stockName: alertRules.stockName })
      .from(alertRules)
      .where(and(
        eq(alertRules.userId, userId),
        eq(alertRules.instanceId, instanceId),
        eq(alertRules.enabled, true),
        inArray(alertRules.stockCode, customAlertCodes),
      ));
    for (const rule of rules) {
      if (rule.stockName) customAlertNameMap.set(rule.stockCode, rule.stockName);
    }
  }

  const stockMap = new Map<string, { stockCode: string; stockName: string }>();
  for (const item of watchItems) stockMap.set(item.stockCode, item);
  for (const pos of positions) {
    if (!stockMap.has(pos.stockCode)) {
      stockMap.set(pos.stockCode, { stockCode: pos.stockCode, stockName: pos.stockName });
    }
  }
  for (const alert of customAlerts) {
    if (!stockMap.has(alert.stockCode)) {
      stockMap.set(alert.stockCode, {
        stockCode: alert.stockCode,
        stockName: customAlertNameMap.get(alert.stockCode) ?? alert.stockCode,
      });
    }
  }

  const items = [...stockMap.values()];
  const codes = items.map((w) => w.stockCode);
  const quotes = await getQuote(codes);
  const quoteMap = new Map(quotes.map((q) => [q.code, q]));
  const customAlertMap = new Map<string, typeof customAlerts>();

  // WP3a:加载信号优先级配置(yaml 或硬编码),后续 push 时查表得到 priority + severity。
  const priorityCfg = await loadPriorityConfig();

  // 加载系统信号配置
  const [sigPriceChange, sigNearSupport, sigNearResistance, sigNearTarget, sigStopLoss, sigBreakout, sigBreakSupport, , , , , sigCapitalMain, sigCapitalSuperLarge, sigVolPriceDiv, sigMaBreakoutAbove, sigMaBreakoutBelow, sigMacdGoldenCross, sigMacdDeathCross, sigKdjOversold, sigKdjOverbought] =
    await Promise.all([
      getSignalSetting("price_change"),
      getSignalSetting("near_support"),
      getSignalSetting("near_resistance"),
      getSignalSetting("near_target"),
      getSignalSetting("stop_loss"),
      getSignalSetting("breakout_with_volume"),
      getSignalSetting("break_support"),
      getSignalSetting("turnover"),
      getSignalSetting("volume_ratio"),
      getSignalSetting("macd"),
      getSignalSetting("bid_ask_imbalance"),
      getSignalSetting("capital_flow_main"),
      getSignalSetting("capital_flow_super_large"),
      getSignalSetting("volume_price_divergence"),
      getSignalSetting("ma_breakout_above"),
      getSignalSetting("ma_breakout_below"),
      getSignalSetting("macd_golden_cross"),
      getSignalSetting("macd_death_cross"),
      getSignalSetting("kdj_oversold"),
      getSignalSetting("kdj_overbought"),
    ]);

  // 资金流数据（仅在有信号启用时查询）
  let capitalFlowMap = new Map<string, CapitalFlow>();
  const needCapitalFlow = sigCapitalMain?.enabled || sigCapitalSuperLarge?.enabled;
  if (needCapitalFlow) {
    try {
      capitalFlowMap = await getCapitalFlowBatch(codes);
    } catch (error) {
      logger.warn(`资金流数据获取失败: ${(error as Error).message}`);
    }
  }

  for (const alert of customAlerts) {
    const list = customAlertMap.get(alert.stockCode) ?? [];
    list.push(alert);
    customAlertMap.set(alert.stockCode, list);
  }
  const alertOnlyCodes = new Set(customAlertCodes);
  for (const item of watchItems) alertOnlyCodes.delete(item.stockCode);
  for (const pos of positions) alertOnlyCodes.delete(pos.stockCode);
  const planMap = await loadLatestPlanMap(userId, instanceId);

  const alertItems: AlertItem[] = [];

  for (const item of items) {
    const quote = quoteMap.get(item.stockCode);
    if (!quote) continue;

    const plan = planMap.get(item.stockCode);
    const relationToPlan = describePlanRelation(quote.price, plan);
    const configured = customAlertMap.get(item.stockCode) ?? [];
    const priceThreshold = getConfiguredThreshold(configured, "price", Number(sigPriceChange?.params.threshold) || 3);
    const shouldCheckSystemPriceChange = !alertOnlyCodes.has(item.stockCode) || hasConfiguredIndicator(configured, "price");

    // 涨跌幅异动
    if (shouldCheckSystemPriceChange && sigPriceChange?.enabled && Math.abs(quote.changePercent) >= priceThreshold) {
      const signalKey = `${item.stockCode}:price:${quote.changePercent >= 0 ? "up" : "down"}`;
      const priority = resolvePrioritySync(signalKey, priorityCfg, Math.abs(quote.changePercent));
      alertItems.push({
        stockCode: item.stockCode,
        stockName: item.stockName,
        type: "price",
        signalKey,
        relationToPlan,
        price: quote.price,
        priority,
        severity: severityFromPriority(priority),
        message: `${item.stockName}(${item.stockCode}) ${quote.changePercent >= 0 ? "大涨" : "大跌"} ${quote.changePercent}%，现价 ${quote.price}`,
      });
    }

    if (sigNearSupport?.enabled && plan?.support && quote.price <= plan.support * 1.01) {
      const signalKey = `${item.stockCode}:near-support`;
      const priority = resolvePrioritySync(signalKey, priorityCfg);
      alertItems.push({
        stockCode: item.stockCode,
        stockName: item.stockName,
        type: "indicator",
        signalKey,
        relationToPlan,
        price: quote.price,
        priority,
        severity: severityFromPriority(priority),
        message: `${item.stockName}(${item.stockCode}) 接近预案支撑位 ${plan.support}，现价 ${quote.price}`,
      });
    }

    if (sigNearResistance?.enabled && plan?.resistance && quote.price >= plan.resistance * 0.99) {
      const signalKey = `${item.stockCode}:near-resistance`;
      const priority = resolvePrioritySync(signalKey, priorityCfg);
      alertItems.push({
        stockCode: item.stockCode,
        stockName: item.stockName,
        type: "indicator",
        signalKey,
        relationToPlan,
        price: quote.price,
        priority,
        severity: severityFromPriority(priority),
        message: `${item.stockName}(${item.stockCode}) 接近预案压力位 ${plan.resistance}，现价 ${quote.price}`,
      });
    }

    if (sigNearTarget?.enabled && plan?.targetPrice && quote.price >= plan.targetPrice * 0.99) {
      const signalKey = `${item.stockCode}:near-target`;
      const priority = resolvePrioritySync(signalKey, priorityCfg);
      alertItems.push({
        stockCode: item.stockCode,
        stockName: item.stockName,
        type: "indicator",
        signalKey,
        relationToPlan,
        price: quote.price,
        priority,
        severity: severityFromPriority(priority),
        message: `${item.stockName}(${item.stockCode}) 接近预案目标位 ${plan.targetPrice}，现价 ${quote.price}`,
      });
    }

    if (sigStopLoss?.enabled && plan?.stopLoss && quote.price <= plan.stopLoss) {
      const signalKey = `${item.stockCode}:stop-loss`;
      const priority = resolvePrioritySync(signalKey, priorityCfg);
      alertItems.push({
        stockCode: item.stockCode,
        stockName: item.stockName,
        type: "indicator",
        signalKey,
        relationToPlan,
        price: quote.price,
        priority,
        severity: severityFromPriority(priority),
        message: `${item.stockName}(${item.stockCode}) 跌破预案止损位 ${plan.stopLoss}，现价 ${quote.price}`,
      });
    }

    // 用户设置的目标价提醒：股价涨到目标价时触发
    const targetPriceThreshold = getConfiguredThreshold(configured, "target_price", 0);
    if (targetPriceThreshold > 0 && quote.price >= targetPriceThreshold) {
      const signalKey = `${item.stockCode}:target-price:${targetPriceThreshold}`;
      const priority = resolvePrioritySync(signalKey, priorityCfg);
      alertItems.push({
        stockCode: item.stockCode,
        stockName: item.stockName,
        type: "price",
        signalKey,
        relationToPlan,
        price: quote.price,
        priority,
        severity: severityFromPriority(priority),
        message: `${item.stockName}(${item.stockCode}) 已达到目标价 ${targetPriceThreshold}，现价 ${quote.price}`,
      });
    }

    // 用户设置的支撑价提醒：股价跌到支撑价时触发
    const supportPriceThreshold = getConfiguredThreshold(configured, "support_price", 0);
    if (supportPriceThreshold > 0 && quote.price <= supportPriceThreshold) {
      const signalKey = `${item.stockCode}:support-price:${supportPriceThreshold}`;
      const priority = resolvePrioritySync(signalKey, priorityCfg);
      alertItems.push({
        stockCode: item.stockCode,
        stockName: item.stockName,
        type: "price",
        signalKey,
        relationToPlan,
        price: quote.price,
        priority,
        severity: severityFromPriority(priority),
        message: `${item.stockName}(${item.stockCode}) 已跌到支撑价 ${supportPriceThreshold}，现价 ${quote.price}`,
      });
    }
  }

  // 资金流信号检查
  if (needCapitalFlow && capitalFlowMap.size > 0) {
    for (const item of items) {
      const flow = capitalFlowMap.get(item.stockCode);
      if (!flow) continue;
      const quote = quoteMap.get(item.stockCode);
      const plan = planMap.get(item.stockCode);
      const relationToPlan = describePlanRelation(quote?.price, plan);

      if (sigCapitalMain?.enabled) {
        const threshold = (Number(sigCapitalMain.params.threshold) || 5000) * 10000;
        if (Math.abs(flow.mainNetInflow) >= threshold) {
          const signalKey = `${item.stockCode}:capital-flow-main`;
          const priority = resolvePrioritySync(signalKey, priorityCfg);
          const direction = flow.mainNetInflow > 0 ? "净流入" : "净流出";
          alertItems.push({
            stockCode: item.stockCode,
            stockName: item.stockName,
            type: "indicator",
            signalKey,
            relationToPlan,
            price: quote?.price,
            priority,
            severity: severityFromPriority(priority),
            message: `${item.stockName}(${item.stockCode}) 主力资金${direction} ${formatWan(flow.mainNetInflow)}，现价 ${quote?.price ?? "未知"}`,
          });
        }
      }

      if (sigCapitalSuperLarge?.enabled) {
        const threshold = (Number(sigCapitalSuperLarge.params.threshold) || 3000) * 10000;
        if (Math.abs(flow.superLargeNetInflow) >= threshold) {
          const signalKey = `${item.stockCode}:capital-flow-super-large`;
          const priority = resolvePrioritySync(signalKey, priorityCfg);
          const direction = flow.superLargeNetInflow > 0 ? "净流入" : "净流出";
          alertItems.push({
            stockCode: item.stockCode,
            stockName: item.stockName,
            type: "indicator",
            signalKey,
            relationToPlan,
            price: quote?.price,
            priority,
            severity: severityFromPriority(priority),
            message: `${item.stockName}(${item.stockCode}) 超大单资金${direction} ${formatWan(flow.superLargeNetInflow)}，现价 ${quote?.price ?? "未知"}`,
          });
        }
      }
    }
  }

  // 收集每只股票已触发的 builtin 信号 suffix(供 L3a source resolver 使用)
  // alert-check 用横线后缀,YAML 模板用下划线,这里 normalize 到下划线格式
  const stockSignalCache = new Map<string, Set<string>>();
  for (const ai of alertItems) {
    const suffix = ai.signalKey.split(":").slice(1).join(":");
    if (!suffix) continue;
    const base = suffix.split(":")[0];
    const normalized = base.replace(/-/g, "_");
    let set = stockSignalCache.get(ai.stockCode);
    if (!set) {
      set = new Set();
      stockSignalCache.set(ai.stockCode, set);
    }
    set.add(normalized);
  }

  // 技术指标检查（放量突破 / 跌破支撑 — 仅与预案关联的信号）
  for (const item of items) {
    try {
      const klines = await getKline(item.stockCode, 120);
      if (klines.length < 30) continue;

      const report = analyzeIndicators(klines);
      const quote = quoteMap.get(item.stockCode);
      const plan = planMap.get(item.stockCode);
      const relationToPlan = describePlanRelation(quote?.price, plan);

      const configured = customAlertMap.get(item.stockCode) ?? [];
      const breakoutVolumeThreshold = Number(sigBreakout?.params.volumeThreshold) || 1.5;

      if (
        sigBreakout?.enabled &&
        quote?.price &&
        plan?.resistance &&
        quote.price >= plan.resistance &&
        report.volume.ratioToAvg5 >= breakoutVolumeThreshold
      ) {
        const signalKey = `${item.stockCode}:breakout-with-volume`;
        const priority = resolvePrioritySync(signalKey, priorityCfg);
        alertItems.push({
          stockCode: item.stockCode,
          stockName: item.stockName,
          type: "indicator",
          signalKey,
          relationToPlan,
          price: quote.price,
          priority,
          severity: severityFromPriority(priority),
          message: `${item.stockName}(${item.stockCode}) 放量突破预案压力位 ${plan.resistance}，现价 ${quote.price}，量比 ${report.volume.ratioToAvg5}`,
        });
      }

      if (
        sigBreakSupport?.enabled &&
        quote?.price &&
        plan?.support &&
        quote.price <= plan.support
      ) {
        const signalKey = `${item.stockCode}:break-support`;
        const priority = resolvePrioritySync(signalKey, priorityCfg);
        alertItems.push({
          stockCode: item.stockCode,
          stockName: item.stockName,
          type: "indicator",
          signalKey,
          relationToPlan,
          price: quote.price,
          priority,
          severity: severityFromPriority(priority),
          message: `${item.stockName}(${item.stockCode}) 跌破预案支撑位 ${plan.support}，现价 ${quote.price}，量能状态 ${report.volume.status}`,
        });
      }

      // === L1 技术指标巡检(2026-06-22) ===
      // 6 个新分支:MA 突破/跌破、MACD 金叉/死叉、KDJ 超卖/超买
      // 优先级:用户对该股的 customAlert 参数 > 全局 sig 参数 > 默认
      const closes = klines.map((k) => k.close);
      const lastIdx = closes.length - 1;
      const prevIdx = lastIdx - 1;
      if (prevIdx >= 1) {
        const closeToday = closes[lastIdx];
        const closePrev = closes[prevIdx];

        // --- MA 突破/跌破 ---
        const customMaAbove = configured.find((a) => a.indicator === "ma_breakout_above");
        const customMaBelow = configured.find((a) => a.indicator === "ma_breakout_below");
        const checkMaAbove = !!customMaAbove || !!sigMaBreakoutAbove?.enabled;
        const checkMaBelow = !!customMaBelow || !!sigMaBreakoutBelow?.enabled;
        if (checkMaAbove || checkMaBelow) {
          const periodAbove = customMaAbove
            ? readThresholdParam(customMaAbove.threshold, "period", 20)
            : Number(sigMaBreakoutAbove?.params.period) || 20;
          const periodBelow = customMaBelow
            ? readThresholdParam(customMaBelow.threshold, "period", 20)
            : Number(sigMaBreakoutBelow?.params.period) || 20;
          // 同周期可复用一次计算
          const maCache = new Map<number, { today: number; prev: number } | null>();
          const getMaPair = (period: number) => {
            if (maCache.has(period)) return maCache.get(period)!;
            const vals = computeMA(closes, period).values;
            const today = vals[lastIdx];
            const prev = vals[prevIdx];
            const pair = today != null && prev != null ? { today: today as number, prev: prev as number } : null;
            maCache.set(period, pair);
            return pair;
          };
          if (checkMaAbove) {
            const pair = getMaPair(periodAbove);
            if (pair && closePrev <= pair.prev && closeToday > pair.today) {
              const signalKey = `${item.stockCode}:ma-breakout-above:${periodAbove}`;
              const priority = resolvePrioritySync(signalKey, priorityCfg);
              alertItems.push({
                stockCode: item.stockCode,
                stockName: item.stockName,
                type: "indicator",
                signalKey,
                relationToPlan,
                price: closeToday,
                priority,
                severity: severityFromPriority(priority),
                message: `${item.stockName}(${item.stockCode}) 突破 ${periodAbove} 日均线,现价 ${closeToday.toFixed(2)} > MA${periodAbove} ${pair.today.toFixed(2)}`,
              });
            }
          }
          if (checkMaBelow) {
            const pair = getMaPair(periodBelow);
            if (pair && closePrev >= pair.prev && closeToday < pair.today) {
              const signalKey = `${item.stockCode}:ma-breakout-below:${periodBelow}`;
              const priority = resolvePrioritySync(signalKey, priorityCfg);
              alertItems.push({
                stockCode: item.stockCode,
                stockName: item.stockName,
                type: "indicator",
                signalKey,
                relationToPlan,
                price: closeToday,
                priority,
                severity: severityFromPriority(priority),
                message: `${item.stockName}(${item.stockCode}) 跌破 ${periodBelow} 日均线,现价 ${closeToday.toFixed(2)} < MA${periodBelow} ${pair.today.toFixed(2)}`,
              });
            }
          }
        }

        // --- MACD 金叉/死叉 ---
        const customMacdGolden = configured.find((a) => a.indicator === "macd_golden_cross");
        const customMacdDeath = configured.find((a) => a.indicator === "macd_death_cross");
        if (customMacdGolden || sigMacdGoldenCross?.enabled || customMacdDeath || sigMacdDeathCross?.enabled) {
          const { dif, dea } = computeMACD(closes);
          if (dif.length >= 2 && dea.length >= 2) {
            const difToday = dif[lastIdx];
            const deaToday = dea[lastIdx];
            const difPrev = dif[prevIdx];
            const deaPrev = dea[prevIdx];
            if ((customMacdGolden || sigMacdGoldenCross?.enabled) && difPrev <= deaPrev && difToday > deaToday) {
              const signalKey = `${item.stockCode}:macd-golden-cross`;
              const priority = resolvePrioritySync(signalKey, priorityCfg);
              alertItems.push({
                stockCode: item.stockCode,
                stockName: item.stockName,
                type: "indicator",
                signalKey,
                relationToPlan,
                price: closeToday,
                priority,
                severity: severityFromPriority(priority),
                message: `${item.stockName}(${item.stockCode}) MACD 金叉,DIF ${difToday.toFixed(3)} 上穿 DEA ${deaToday.toFixed(3)},现价 ${closeToday.toFixed(2)}`,
              });
            }
            if ((customMacdDeath || sigMacdDeathCross?.enabled) && difPrev >= deaPrev && difToday < deaToday) {
              const signalKey = `${item.stockCode}:macd-death-cross`;
              const priority = resolvePrioritySync(signalKey, priorityCfg);
              alertItems.push({
                stockCode: item.stockCode,
                stockName: item.stockName,
                type: "indicator",
                signalKey,
                relationToPlan,
                price: closeToday,
                priority,
                severity: severityFromPriority(priority),
                message: `${item.stockName}(${item.stockCode}) MACD 死叉,DIF ${difToday.toFixed(3)} 下穿 DEA ${deaToday.toFixed(3)},现价 ${closeToday.toFixed(2)}`,
              });
            }
          }
        }

        // --- KDJ 超卖/超买 ---
        const customKdjOversold = configured.find((a) => a.indicator === "kdj_oversold");
        const customKdjOverbought = configured.find((a) => a.indicator === "kdj_overbought");
        if (customKdjOversold || sigKdjOversold?.enabled || customKdjOverbought || sigKdjOverbought?.enabled) {
          const { k: kArr, d: dArr } = computeKDJ(klines);
          if (kArr.length >= 2 && dArr.length >= 2) {
            const kToday = kArr[lastIdx];
            const dToday = dArr[lastIdx];
            const kPrev = kArr[prevIdx];
            const dPrev = dArr[prevIdx];
            if (customKdjOversold || sigKdjOversold?.enabled) {
              const th = customKdjOversold
                ? readThresholdParam(customKdjOversold.threshold, "threshold", 20)
                : Number(sigKdjOversold?.params.threshold) || 20;
              if (dToday < th && kPrev <= dPrev && kToday > dToday) {
                const signalKey = `${item.stockCode}:kdj-oversold:${th}`;
                const priority = resolvePrioritySync(signalKey, priorityCfg);
                alertItems.push({
                  stockCode: item.stockCode,
                  stockName: item.stockName,
                  type: "indicator",
                  signalKey,
                  relationToPlan,
                  price: closeToday,
                  priority,
                  severity: severityFromPriority(priority),
                  message: `${item.stockName}(${item.stockCode}) KDJ 超卖反弹,D=${dToday.toFixed(2)} < ${th},K 上穿 D,现价 ${closeToday.toFixed(2)}`,
                });
              }
            }
            if (customKdjOverbought || sigKdjOverbought?.enabled) {
              const th = customKdjOverbought
                ? readThresholdParam(customKdjOverbought.threshold, "threshold", 80)
                : Number(sigKdjOverbought?.params.threshold) || 80;
              if (dToday > th && kPrev >= dPrev && kToday < dToday) {
                const signalKey = `${item.stockCode}:kdj-overbought:${th}`;
                const priority = resolvePrioritySync(signalKey, priorityCfg);
                alertItems.push({
                  stockCode: item.stockCode,
                  stockName: item.stockName,
                  type: "indicator",
                  signalKey,
                  relationToPlan,
                  price: closeToday,
                  priority,
                  severity: severityFromPriority(priority),
                  message: `${item.stockName}(${item.stockCode}) KDJ 超买回落,D=${dToday.toFixed(2)} > ${th},K 下穿 D,现价 ${closeToday.toFixed(2)}`,
                });
              }
            }
          }
        }
      }

      // === L3a 复合指标巡检(2026-06-22) ===
      // 共享 klines,调用 l3a-indicator-runner 跑 YAML 规则树
      try {
        const builtinSignals = new Set<string>(stockSignalCache.get(item.stockCode));
        // 把本轮新触发的技术指标信号也补进来(上面 push 完成但 stockSignalCache 是循环前快照)
        for (const ai of alertItems) {
          if (ai.stockCode !== item.stockCode) continue;
          const suffix = ai.signalKey.split(":").slice(1).join(":");
          if (!suffix) continue;
          const base = suffix.split(":")[0];
          builtinSignals.add(base.replace(/-/g, "_"));
        }
        const l3aTriggered = await runL3aIndicatorsForStock({
          stockCode: item.stockCode,
          klines,
          builtinSignals,
        });
        for (const t of l3aTriggered) {
          const signalKey = `${item.stockCode}:composite:${t.configKey}`;
          const priority = resolvePrioritySync(signalKey, priorityCfg);
          const expTag = t.reliability === "experimental" ? "[experimental] " : "";
          const scoreText = t.score != null ? `,得分 ${(t.score * 100).toFixed(0)}` : "";
          const notesText = t.notes.length > 0 ? `;${t.notes.join(";")}` : "";
          alertItems.push({
            stockCode: item.stockCode,
            stockName: item.stockName,
            type: "indicator",
            signalKey,
            relationToPlan,
            price: quote?.price ?? klines[klines.length - 1]?.close,
            priority,
            severity: severityFromPriority(priority),
            message: `${expTag}${item.stockName}(${item.stockCode}) 触发复合指标「${t.configName}」${scoreText}${notesText}`,
          });
        }
      } catch (err) {
        logger.warn(`L3a 巡检失败 ${item.stockCode}: ${(err as Error).message}`);
      }

      // === L3b 沙箱脚本巡检(2026-06-22) ===
      // 只跑 schedule: intraday 的脚本(daily_post_market 默认不进巡检)
      try {
        const l3bTriggered = await runL3bIndicatorsForStock({
          stockCode: item.stockCode,
          klines,
        });
        for (const t of l3bTriggered) {
          const signalKey = `${item.stockCode}:script:${t.registryKey}:${t.triggeredField}`;
          const priority = resolvePrioritySync(signalKey, priorityCfg);
          const expTag = t.reliability === "experimental" ? "[experimental] " : "";
          const notesText = t.notes.length > 0 ? `;${t.notes.join(";")}` : "";
          alertItems.push({
            stockCode: item.stockCode,
            stockName: item.stockName,
            type: "indicator",
            signalKey,
            relationToPlan,
            price: quote?.price ?? klines[klines.length - 1]?.close,
            priority,
            severity: severityFromPriority(priority),
            message: `${expTag}${item.stockName}(${item.stockCode}) 触发脚本指标「${t.registryName}.${t.triggeredField}」${notesText}`,
          });
        }
      } catch (err) {
        logger.warn(`L3b 巡检失败 ${item.stockCode}: ${(err as Error).message}`);
      }
    } catch {
      logger.warn(`技术指标检查失败: ${item.stockCode}`);
    }
  }

  // 放量滞涨/滞跌检查（5分钟K线）
  if (sigVolPriceDiv?.enabled) {
    const volMultiplier = Number(sigVolPriceDiv.params.volumeMultiplier) || 3;
    const priceRangePct = Number(sigVolPriceDiv.params.priceRangePercent) || 0.5;

    for (const item of items) {
      try {
        const minuteBars = await getMinuteKline(item.stockCode, 48);
        if (minuteBars.length < 10) continue;

        const bars = minuteBars.slice(0, -1);
        const avgVol = bars.reduce((s, b) => s + b.volume, 0) / bars.length;

        for (const bar of bars.slice(-6)) {
          if (bar.volume < avgVol * volMultiplier) continue;
          const priceRange = bar.high > 0 ? ((bar.high - bar.low) / bar.high) * 100 : 0;
          if (priceRange >= priceRangePct) continue;

          const direction = bar.close >= bar.open ? "滞涨" : "滞跌";
          const signalKey = `${item.stockCode}:vol-price-div:${bar.time}`;
          const priority = resolvePrioritySync(signalKey, priorityCfg);
          alertItems.push({
            stockCode: item.stockCode,
            stockName: item.stockName,
            type: "volume",
            signalKey,
            relationToPlan: "未找到预案",
            price: bar.close,
            priority,
            severity: severityFromPriority(priority),
            message: `${item.stockName}(${item.stockCode}) ${bar.time.slice(8)} 放量${direction}，量${(bar.volume / 10000).toFixed(1)}万手（均量${(avgVol / 10000).toFixed(1)}万手的${(bar.volume / avgVol).toFixed(1)}倍），振幅仅${priceRange.toFixed(2)}%`,
          });
          break;
        }
      } catch {
        logger.warn(`放量滞涨检查失败: ${item.stockCode}`);
      }
    }
  }

  const deduped = await filterAndRecordAlerts(userId, instanceId, alertItems, quoteMap);

  if (deduped.length > 0) {
    logger.info(`巡检发现 ${deduped.length} 条提醒`);
  }

  return deduped;
}

/** 是否在 A 股交易时间 */
function isTradingTime(): boolean {
  const now = new Date();
  // 转为北京时间
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const bjTime = new Date(utc + 8 * 3600000);
  const hour = bjTime.getHours();
  const minute = bjTime.getMinutes();
  const day = bjTime.getDay();

  // 周末不交易
  if (day === 0 || day === 6) return false;

  const timeNum = hour * 100 + minute;
  // 9:30 - 11:30, 13:00 - 15:00
  return (timeNum >= 930 && timeNum <= 1130) || (timeNum >= 1300 && timeNum <= 1500);
}

/** 格式化提醒列表为推送文本 */
export function formatAlerts(alerts: AlertItem[]): string {
  if (alerts.length === 0) return "";

  const high = alerts.filter((a) => a.severity === "high");
  const medium = alerts.filter((a) => a.severity === "medium");
  const low = alerts.filter((a) => a.severity === "low");

  const lines: string[] = ["⏰ 行情提醒\n"];

  if (high.length > 0) {
    lines.push("【重要】");
    for (const a of high) lines.push(formatAlertLine(a));
    lines.push("");
  }

  if (medium.length > 0) {
    lines.push("【关注】");
    for (const a of medium) lines.push(formatAlertLine(a));
  }

  if (low.length > 0) {
    lines.push("");
    lines.push("【观察】");
    for (const a of low) lines.push(formatAlertLine(a));
  }

  lines.push("", "—", "仅供参考，不构成投资建议");
  return lines.join("\n");
}

function formatAlertLine(alert: AlertItem): string {
  const planNote = shouldShowPlan(alert.relationToPlan)
    ? `（${alert.relationToPlan}）`
    : "";
  return `  ${alert.message}${planNote}`;
}

function shouldShowPlan(relation: string): boolean {
  if (!relation || relation === "未找到预案") return false;
  if (relation.startsWith("已找到预案，当前未触及")) return false;
  if (relation.startsWith("找到预案，但")) return false;
  return true;
}

async function loadLatestPlanMap(userId = DEFAULT_USER_ID, instanceId = DEFAULT_INSTANCE_ID): Promise<Map<string, PlanItem>> {
  const manualPlans = await planBackend.list(userId, instanceId);
  const latest = await dailyPlanBackend.getLatest(userId, instanceId);

  const map = new Map<string, PlanItem>();

  if (latest) {
    try {
      // workspace 路径 data 是对象,sqlite 路径 data 是反序列化后的对象(JSON.parse 已在 backend 内做)
      const parsed = (latest.data ?? {}) as { items?: PlanItem[] };
      for (const item of parsed.items ?? []) {
        map.set(item.code, { ...item, source: "daily_review" });
      }
    } catch (error) {
      logger.warn(`解析每日预案失败: ${(error as Error).message}`);
    }
  }

  for (const plan of manualPlans) {
    map.set(plan.code, {
      code: plan.code,
      name: plan.name,
      pool: "manual",
      support: plan.support ?? null,
      resistance: plan.resistance ?? null,
      targetPrice: plan.targetPrice ?? null,
      stopLoss: plan.stopLoss ?? null,
      observe: plan.notes ? [plan.notes] : [],
      notes: plan.notes ?? null,
      source: "manual",
    });
  }

  return map;
}

function describePlanRelation(price: number | undefined, plan: PlanItem | undefined): string {
  if (!plan) return "未找到预案";
  if (price == null) return "找到预案，但当前行情缺失";
  if (plan.stopLoss && price <= plan.stopLoss) return withPlanNote("触发预案：跌破止损位", plan);
  if (plan.targetPrice && price >= plan.targetPrice * 0.99) return withPlanNote("符合预案：接近目标位", plan);
  if (plan.support && price <= plan.support * 1.01) return "符合预案：接近支撑位";
  if (plan.resistance && price >= plan.resistance * 0.99) return "符合预案：接近压力位";
  return withPlanNote("已找到预案，当前未触及关键价位", plan);
}

function withPlanNote(text: string, plan: PlanItem): string {
  return plan.notes ? `${text}；备注：${plan.notes}` : text;
}

function getConfiguredThreshold(
  configured: Array<{ indicator: string; threshold: string }>,
  indicator: string,
  fallback: number
): number {
  const item = configured.find((a) => a.indicator === indicator);
  if (!item) return fallback;
  try {
    const parsed = JSON.parse(item.threshold) as ParsedThreshold;
    const value = Number(parsed.value);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function hasConfiguredIndicator(
  configured: Array<{ indicator: string; threshold: string }>,
  indicator: string
): boolean {
  return configured.some((a) => a.indicator === indicator);
}

/** 从 customAlert 的 threshold JSON 里读出指定参数,fallback 到默认值 */
function readThresholdParam(thresholdJson: string, param: string, fallback: number): number {
  try {
    const parsed = JSON.parse(thresholdJson) as Record<string, unknown>;
    const v = Number(parsed[param]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

const MAX_DAILY_PER_STOCK = 8;
const PRICE_CHANGE_THRESHOLD = 0.01;
const STATEFUL_SIGNAL_SUFFIXES = new Set([
  "price",
  "near-support",
  "near-resistance",
  "near-target",
  "stop-loss",
  "support-price",
  "target-price",
  "break-support",
  "breakout-with-volume",
  "ma-breakout-above",
  "ma-breakout-below",
  "macd-golden-cross",
  "macd-death-cross",
  "kdj-oversold",
  "kdj-overbought",
  "composite",
  "script",
]);

async function filterAndRecordAlerts(
  userId: string,
  instanceId: string,
  items: AlertItem[],
  quoteMap: Map<string, { price: number }>
): Promise<AlertItem[]> {
  const now = new Date();
  const createdAt = now.toISOString();
  const eventDate = createdAt.slice(0, 10);
  const cooldownSince = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  const stockCodes = [...new Set([...quoteMap.keys(), ...items.map(i => i.stockCode)])];
  const triggeredKeys = new Set(items.map((item) => item.signalKey));
  await releaseInactiveSignalStates(userId, instanceId, stockCodes, triggeredKeys, now);
  if (items.length === 0) return [];

  const dailyCounts = new Map<string, number>();
  if (stockCodes.length > 0) {
    const dailyRows = await db
      .select({ stockCode: alertEvents.stockCode })
      .from(alertEvents)
      .where(and(eq(alertEvents.userId, userId), eq(alertEvents.instanceId, instanceId), inArray(alertEvents.stockCode, stockCodes), eq(alertEvents.eventDate, eventDate)));
    for (const row of dailyRows) {
      dailyCounts.set(row.stockCode, (dailyCounts.get(row.stockCode) ?? 0) + 1);
    }
  }

  const result: AlertItem[] = [];

  for (const item of items) {
    if ((dailyCounts.get(item.stockCode) ?? 0) >= MAX_DAILY_PER_STOCK) continue;

    if (isStatefulSignal(item.signalKey)) {
      const active = await db
        .select()
        .from(alertSignalStates)
        .where(and(eq(alertSignalStates.userId, userId), eq(alertSignalStates.instanceId, instanceId), eq(alertSignalStates.signalKey, item.signalKey), eq(alertSignalStates.active, true)))
        .limit(1);

      if (active.length > 0) {
        await db
          .update(alertSignalStates)
          .set({
            stockName: item.stockName,
            lastPrice: item.price,
            updatedAt: createdAt,
          })
          .where(and(eq(alertSignalStates.userId, userId), eq(alertSignalStates.instanceId, instanceId), eq(alertSignalStates.signalKey, item.signalKey)));
        continue;
      }

      const existingToday = await db
        .select()
        .from(alertEvents)
        .where(and(eq(alertEvents.userId, userId), eq(alertEvents.instanceId, instanceId), eq(alertEvents.signalKey, item.signalKey), eq(alertEvents.eventDate, eventDate)))
        .orderBy(desc(alertEvents.createdAt))
        .limit(1);

      if (existingToday.length > 0) {
        await upsertActiveSignalState(userId, instanceId, item, createdAt);
        continue;
      }
    }

    const recent = await db
      .select()
      .from(alertEvents)
      .where(and(eq(alertEvents.userId, userId), eq(alertEvents.instanceId, instanceId), eq(alertEvents.signalKey, item.signalKey), gte(alertEvents.createdAt, cooldownSince)))
      .limit(1);

    if (recent.length > 0) {
      const lastPrice = recent[0].price;
      if (item.price != null && lastPrice != null && lastPrice > 0) {
        const priceChange = Math.abs(item.price - lastPrice) / lastPrice;
        if (priceChange < PRICE_CHANGE_THRESHOLD) continue;
      } else {
        continue;
      }
    }

    await db.insert(alertEvents).values({
      userId,
      instanceId,
      stockCode: item.stockCode,
      stockName: item.stockName,
      eventDate,
      eventType: item.type,
      signalKey: item.signalKey,
      message: item.message,
      relationToPlan: item.relationToPlan,
      severity: item.severity,
      price: item.price,
      status: "pending",
      createdAt,
    });
    await recordIndicatorResultSnapshot(userId, instanceId, item, createdAt);
    if (isStatefulSignal(item.signalKey)) {
      await upsertActiveSignalState(userId, instanceId, item, createdAt);
    }
    dailyCounts.set(item.stockCode, (dailyCounts.get(item.stockCode) ?? 0) + 1);
    result.push(item);
  }

  return result;
}

async function recordIndicatorResultSnapshot(userId: string, instanceId: string, item: AlertItem, nowIso: string) {
  const indicatorKey = indicatorKeyFromSignal(item.signalKey);
  await db.insert(indicatorResults).values({
    userId,
    instanceId,
    indicatorKey,
    stockCode: item.stockCode,
    stockName: item.stockName,
    timeframe: timeframeFromIndicator(indicatorKey),
    calculatedAt: nowIso,
    dataTime: nowIso,
    value: JSON.stringify({
      triggered: true,
      signalKey: item.signalKey,
      type: item.type,
      price: item.price ?? null,
      severity: item.severity,
    }),
    level: item.severity,
    confidence: confidenceFromIndicator(indicatorKey),
    explanation: item.message,
    sourceSnapshot: JSON.stringify({
      relationToPlan: item.relationToPlan,
      price: item.price ?? null,
      source: "legacy_alert_check",
    }),
    missingData: JSON.stringify(missingDataForIndicator(indicatorKey)),
  });
}

function indicatorKeyFromSignal(signalKey: string) {
  const suffix = signalKey.split(":").slice(1).join(":");
  if (suffix.startsWith("price:")) return "price_change";
  if (suffix === "near-support") return "near_support";
  if (suffix === "near-resistance") return "near_resistance";
  if (suffix === "near-target") return "near_target";
  if (suffix === "stop-loss") return "stop_loss";
  if (suffix.startsWith("target-price")) return "custom_target_price";
  if (suffix.startsWith("support-price")) return "custom_support_price";
  if (suffix === "breakout-with-volume") return "breakout_with_volume";
  if (suffix === "break-support") return "break_support";
  if (suffix === "capital-flow-main") return "capital_flow_main";
  if (suffix === "capital-flow-super-large") return "capital_flow_super_large";
  if (suffix.startsWith("vol-price-div")) return "volume_price_divergence";
  if (suffix.startsWith("ma-breakout-above")) return "ma_breakout_above";
  if (suffix.startsWith("ma-breakout-below")) return "ma_breakout_below";
  if (suffix === "macd-golden-cross") return "macd_golden_cross";
  if (suffix === "macd-death-cross") return "macd_death_cross";
  if (suffix.startsWith("kdj-oversold")) return "kdj_oversold";
  if (suffix.startsWith("kdj-overbought")) return "kdj_overbought";
  if (suffix.startsWith("composite:")) return `composite_${suffix.split(":")[1] ?? "unknown"}`;
  if (suffix.startsWith("script:")) return `script_${suffix.split(":")[1] ?? "unknown"}`;
  return suffix || "unknown";
}

function timeframeFromIndicator(indicatorKey: string) {
  if (indicatorKey === "volume_price_divergence") return "1m";
  if (indicatorKey === "macd" || indicatorKey === "breakout_with_volume") return "daily";
  return "realtime";
}

function confidenceFromIndicator(indicatorKey: string) {
  if (indicatorKey.startsWith("capital_flow")) return "low";
  if (indicatorKey === "volume_price_divergence") return "medium";
  return "medium";
}

function missingDataForIndicator(indicatorKey: string) {
  if (indicatorKey.startsWith("capital_flow")) {
    return ["资金流不是主力控盘或建仓结论"];
  }
  if (indicatorKey === "volume_price_divergence") {
    return ["未接入逐笔成交和盘口队列"];
  }
  return [];
}

async function upsertActiveSignalState(userId: string, instanceId: string, item: AlertItem, nowIso: string) {
  await db.insert(alertSignalStates).values({
    userId,
    instanceId,
    signalKey: item.signalKey,
    stockCode: item.stockCode,
    stockName: item.stockName,
    active: true,
    lastPrice: item.price,
    activatedAt: nowIso,
    updatedAt: nowIso,
  }).onConflictDoUpdate({
    target: [alertSignalStates.userId, alertSignalStates.instanceId, alertSignalStates.signalKey],
    set: {
      stockCode: item.stockCode,
      stockName: item.stockName,
      active: true,
      lastPrice: item.price,
      updatedAt: nowIso,
    },
  });
}

async function releaseInactiveSignalStates(
  userId: string,
  instanceId: string,
  stockCodes: string[],
  triggeredKeys: Set<string>,
  now: Date
) {
  if (stockCodes.length === 0) return;
  const activeRows = await db
    .select()
    .from(alertSignalStates)
    .where(and(eq(alertSignalStates.userId, userId), eq(alertSignalStates.instanceId, instanceId), inArray(alertSignalStates.stockCode, stockCodes), eq(alertSignalStates.active, true)));

  const updatedAt = now.toISOString();
  for (const row of activeRows) {
    if (!isStatefulSignal(row.signalKey)) continue;
    if (triggeredKeys.has(row.signalKey)) continue;
    await db
      .update(alertSignalStates)
      .set({ active: false, updatedAt })
      .where(and(eq(alertSignalStates.userId, userId), eq(alertSignalStates.instanceId, instanceId), eq(alertSignalStates.signalKey, row.signalKey)));
  }
}

function isStatefulSignal(signalKey: string) {
  const suffix = signalKey.split(":").slice(1).join(":");
  if (STATEFUL_SIGNAL_SUFFIXES.has(suffix)) return true;
  return [...STATEFUL_SIGNAL_SUFFIXES].some((key) => suffix.startsWith(`${key}:`));
}

function formatWan(yuan: number): string {
  const wan = yuan / 10000;
  const abs = Math.abs(wan);
  const sign = wan >= 0 ? "" : "-";
  if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(2)}亿`;
  return `${sign}${abs.toFixed(0)}万`;
}

// ============ 信号优先级解析(WP3a 2026-06-21) ============
//
// 设计要点:
//   - signalKey 形如 "<code>:<suffix>" 或 "<code>:<suffix>:<param>",优先级由 suffix 决定
//   - suffix 可能是单段(stop-loss)、双段(price:up)、或带参数前缀(target-price:12.5)
//   - 查表顺序:精确 suffix → 前缀(去掉末段冒号后) → 默认值
//   - 价格异动达到 escalation 阈值时,suffix 自动加 ":extreme"
//   - yaml 不可用时走 HARDWIRED_PRIORITY_MAP 硬编码默认值,保持现有行为

const HARDWIRED_PRIORITY_MAP: Record<string, RiskLevel> = {
  "stop-loss": "P0",
  "break-support": "P0",
  "breakout-with-volume": "P0",
  "target-price": "P0",
  "support-price": "P0",
  "price:up:extreme": "P0",
  "price:down:extreme": "P0",
  "near-support": "P1",
  "near-resistance": "P1",
  "near-target": "P1",
  "capital-flow-main": "P1",
  "capital-flow-super-large": "P1",
  "vol-price-div": "P1",
  "price:up": "P1",
  "price:down": "P1",
  "ma-breakout-above": "P1",
  "ma-breakout-below": "P1",
  "macd-golden-cross": "P1",
  "macd-death-cross": "P1",
  "kdj-oversold": "P2",
  "kdj-overbought": "P2",
  "composite": "P1",
  "script": "P2",
};

const HARDWIRED_ESCALATION_THRESHOLD = 5;
const PRIORITY_TO_SEVERITY: Record<RiskLevel, "high" | "medium" | "low"> = {
  P0: "high",
  P1: "medium",
  P2: "low",
};

interface PriorityConfig {
  overrides: Record<string, RiskLevel>;
  defaultPriority: RiskLevel;
  escalationThreshold: number;
}

let cachedPriorityConfig: PriorityConfig | null = null;
let priorityWorkspaceInitialized = false;

async function loadPriorityConfig(): Promise<PriorityConfig> {
  if (cachedPriorityConfig) return cachedPriorityConfig;

  if (process.env.USE_YAML_CONFIG !== "true") {
    cachedPriorityConfig = {
      overrides: HARDWIRED_PRIORITY_MAP,
      defaultPriority: "P2",
      escalationThreshold: HARDWIRED_ESCALATION_THRESHOLD,
    };
    return cachedPriorityConfig;
  }

  try {
    if (!priorityWorkspaceInitialized) {
      await ensureWorkspace({ userId: DEFAULT_USER_ID });
      priorityWorkspaceInitialized = true;
    }
    const store = new WorkspaceStore(DEFAULT_USER_ID);
    const yaml = await store.readRiskTaxonomy();
    const sp = yaml?.signal_priority;
    if (!sp) {
      logger.warn("USE_YAML_CONFIG=true 但 risk_taxonomy.yaml 缺 signal_priority,使用硬编码默认值");
      cachedPriorityConfig = {
        overrides: HARDWIRED_PRIORITY_MAP,
        defaultPriority: "P2",
        escalationThreshold: HARDWIRED_ESCALATION_THRESHOLD,
      };
      return cachedPriorityConfig;
    }
    cachedPriorityConfig = {
      overrides: sp.overrides ?? {},
      defaultPriority: sp.default ?? "P2",
      escalationThreshold:
        typeof sp.price_escalation_threshold_percent === "number"
          ? sp.price_escalation_threshold_percent
          : HARDWIRED_ESCALATION_THRESHOLD,
    };
    logger.info(
      `signal_priority 配置从 yaml 加载: overrides<${Object.keys(cachedPriorityConfig.overrides).length}> default<${cachedPriorityConfig.defaultPriority}> escalation<${cachedPriorityConfig.escalationThreshold}%>`
    );
    return cachedPriorityConfig;
  } catch (error) {
    logger.warn(`signal_priority 配置读取失败,使用默认值: ${(error as Error).message}`);
    cachedPriorityConfig = {
      overrides: HARDWIRED_PRIORITY_MAP,
      defaultPriority: "P2",
      escalationThreshold: HARDWIRED_ESCALATION_THRESHOLD,
    };
    return cachedPriorityConfig;
  }
}

/**
 * 从 signalKey 解析出用于查表的 suffix。
 * 例如 "600519:price:up" → "price:up","600519:target-price:12.5" → "target-price:12.5"。
 */
function suffixFromSignalKey(signalKey: string): string {
  const idx = signalKey.indexOf(":");
  return idx >= 0 ? signalKey.slice(idx + 1) : signalKey;
}

/**
 * 查 overrides 表,支持精确匹配 + 前缀匹配(去掉末段冒号后)。
 */
function lookupPriority(
  suffix: string,
  cfg: PriorityConfig
): RiskLevel {
  if (cfg.overrides[suffix]) return cfg.overrides[suffix];
  const lastColon = suffix.lastIndexOf(":");
  if (lastColon > 0) {
    const prefix = suffix.slice(0, lastColon);
    if (cfg.overrides[prefix]) return cfg.overrides[prefix];
  }
  return cfg.defaultPriority;
}

/**
 * 同步计算一条信号的 priority。调用方需先 await loadPriorityConfig() 拿到 cfg。
 * absChangePercent 仅对 price:up / price:down 有效,达到阈值时升级到 :extreme。
 */
function resolvePrioritySync(
  signalKey: string,
  cfg: PriorityConfig,
  absChangePercent?: number
): RiskLevel {
  let suffix = suffixFromSignalKey(signalKey);
  if (
    absChangePercent !== undefined &&
    (suffix === "price:up" || suffix === "price:down") &&
    absChangePercent >= cfg.escalationThreshold
  ) {
    suffix = `${suffix}:extreme`;
  }
  return lookupPriority(suffix, cfg);
}

/** priority 反推 severity,兼容数据库列。 */
function severityFromPriority(p: RiskLevel): "high" | "medium" | "low" {
  return PRIORITY_TO_SEVERITY[p];
}
