import { db } from "../db/index.js";
import { alerts, alertEvents } from "../db/schema.js";
import { and, desc, eq } from "drizzle-orm";
import { getAlertInterval } from "../scheduler/index.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID, type UserContext } from "../lib/user-context.js";
import { portfolioBackend, watchlistBackend, planBackend } from "../lib/data-backend.js";

interface MonitorOverviewInput {
  operation: "overview";
}

export async function handleMonitorTool(_input: MonitorOverviewInput, ctx: UserContext = { userId: DEFAULT_USER_ID }): Promise<string> {
  const userId = ctx.userId;
  const instanceId = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  const [holdings, watchItems, alertRules, plans, recentEvents, intervalMin] = await Promise.all([
    portfolioBackend.listActive(userId, instanceId),
    watchlistBackend.list(userId, instanceId),
    db.select().from(alerts).where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId))),
    planBackend.list(userId, instanceId),
    db.select().from(alertEvents).where(and(eq(alertEvents.userId, userId), eq(alertEvents.instanceId, instanceId))).orderBy(desc(alertEvents.createdAt)).limit(10),
    getAlertInterval(),
  ]);

  const enabledRules = alertRules.filter((r) => r.enabled);

  const sections: string[] = [];

  // 监控股票池(场景 A:无预案标注)
  const planCodes = new Set(plans.map((p) => p.code));
  const holdingCodes = holdings.map((h) => {
    const tag = planCodes.has(h.code) ? "" : "(暂无交易预案)";
    return `${h.name}(${h.code})${tag}`;
  });
  const watchCodes = watchItems.map((w) => `${w.name}(${w.code})`);
  sections.push(`【监控股票】`);
  sections.push(`持有股票池(${holdingCodes.length}只): ${holdingCodes.join("、") || "空"}`);
  sections.push(`自选池(${watchCodes.length}只): ${watchCodes.join("、") || "空"}`);

  // 用户显式提醒规则
  sections.push(``);
  sections.push(`【用户设置的提醒规则】`);
  if (enabledRules.length === 0) {
    sections.push(`暂无用户显式设置的提醒规则。`);
  } else {
    for (const rule of enabledRules) {
      const threshold = safeParseThreshold(rule.threshold);
      sections.push(`- ${rule.stockCode} | ${rule.indicator} | 阈值: ${threshold} | 状态: 开启`);
    }
  }

  // 人工交易预案
  sections.push(``);
  sections.push(`【人工交易预案】`);
  if (plans.length === 0) {
    sections.push(`暂无交易预案。`);
  } else {
    for (const plan of plans) {
      const parts = [`支撑${plan.support ?? "-"}`, `压力${plan.resistance ?? "-"}`];
      if (plan.targetPrice != null) parts.push(`目标${plan.targetPrice}`);
      if (plan.stopLoss != null) parts.push(`止损${plan.stopLoss}`);
      sections.push(`- ${plan.name}(${plan.code}): ${parts.join(" ")}${plan.notes ? ` | ${plan.notes}` : ""}`);
    }
  }

  // 系统默认巡检规则
  sections.push(``);
  sections.push(`【巡检间隔】当前每 ${intervalMin} 分钟检查一次(可调整)`);
  sections.push(``);
  sections.push(`【系统默认巡检规则】(无需用户设置,自动执行)`);
  sections.push(`- 涨跌幅异动: ≥3% (可被用户规则覆盖阈值)`);
  sections.push(`- 接近/突破预案支撑位、压力位、目标位、止损位`);
  sections.push(`- 放量突破预案压力位 (量比≥1.5配合突破)`);
  sections.push(`- 跌破预案支撑位 (配合量能状态判断)`);
  sections.push(`- 用户设置的目标价/支撑价提醒`);
  sections.push(`- 提醒冷却: 同一信号1小时内不重复触发`);

  // 最近触发提醒
  sections.push(``);
  sections.push(`【最近触发提醒】(最近${recentEvents.length}条)`);
  if (recentEvents.length === 0) {
    sections.push(`暂无触发记录。`);
  } else {
    for (const event of recentEvents) {
      const feedback = event.feedback ? ` | 反馈: ${event.feedback}` : "";
      sections.push(
        `- ${event.stockName}(${event.stockCode}) ${event.eventDate} ${event.signalKey} [${event.severity}]${feedback}`
      );
    }
  }

  // 当前数据缺口
  sections.push(``);
  sections.push(`【当前数据缺口】`);
  sections.push(`- 主力控盘、筹码集中度、筹码峰、主力成本: 无直接数据源`);
  sections.push(`- 分钟级K线: 暂不可用`);
  sections.push(`- 盘口五档深度: 仅有粗略买卖量差,无逐笔成交`);
  sections.push(`- 已接入: 主力/超大单/大单/中单/小单净流入(东方财富)`);

  return sections.join("\n");
}

function safeParseThreshold(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { value?: string | number };
    return String(parsed.value ?? raw);
  } catch {
    return raw;
  }
}
