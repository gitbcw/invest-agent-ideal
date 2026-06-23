import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { syncLegacyAlertToAlertRule } from "../handlers/alert-rules.js";
import { alerts, conversationTasks, investmentProfiles, portfolio, stockPlans, watchlist } from "../db/schema.js";
import { resolveStockRefDetails, type StockRef } from "../services/stock-resolver.js";
import type { UserContext } from "./user-context.js";
import { ACTIVE_BACKEND, portfolioBackend } from "./data-backend.js";
import { methodChangeBackend } from "./method-change-backend.js";
import { WorkspaceStore, type StrategyYaml } from "./workspace-store.js";

const TASK_TTL_MS = 24 * 60 * 60 * 1000;
const AI_INTENT_PATTERN = /<invest_agent_intent>\s*([\s\S]*?)\s*<\/invest_agent_intent>/i;

function parseJsonText(value: string | null | undefined, fallback: unknown) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonText(value: unknown) {
  return JSON.stringify(value ?? null);
}


function isConfirmText(text: string) {
  return /^(1|确认|可以|同意|是的|好的|写入|记住|保存|确认写入)$/i.test(text.trim());
}

function isRejectText(text: string) {
  return /^(3|取消|不确认|先不用|暂不|不要|不用)$/i.test(text.trim());
}

function buildInvestmentPreferenceDraft(text: string) {
  const styleParts: string[] = [];
  const buyRules: string[] = [];
  const riskRules: string[] = [];
  const decisionPolicy: Record<string, unknown> = {
    longTermChangesRequireConfirmation: true,
    defaultActionBias: "无触发则不操作",
  };

  if (/稳健|价值/.test(text)) styleParts.push("稳健价值型");
  if (/指数|ETF/.test(text)) styleParts.push("指数配置倾向");
  if (/趋势/.test(text)) styleParts.push("趋势辅助");
  if (/低频|不想频繁|不要频繁|少操作/.test(text)) {
    decisionPolicy.operationFrequency = "低频，避免无新增信息下频繁交易";
    riskRules.push("避免因为短期波动频繁调整长期策略");
  }
  if (/技术面/.test(text)) {
    buyRules.push("技术面只作为买卖节奏、位置和风险提示的辅助依据");
    decisionPolicy.technicalRole = "辅助节奏，不单独构成核心买入理由";
  }
  if (/基本面/.test(text)) {
    buyRules.push("优先参考基本面、估值、安全边际和中长期逻辑");
  }
  if (/仓位|单票|集中/.test(text)) {
    riskRules.push("控制单一标的集中度，避免单票过重");
  }

  const style = styleParts.length ? Array.from(new Set(styleParts)).join(" + ") : "用户自定义风格";
  return {
    style,
    selectedStylePack: /稳健|价值/.test(text) ? "稳健价值型" : null,
    customStyle: {
      source: "wechat_preference_task",
      rawText: text,
      summary: text.slice(0, 500),
    },
    riskPreference: /稳健|风险|低频|不想频繁|不要频繁/.test(text) ? "偏稳健，重视安全边际和执行纪律" : undefined,
    investmentHorizon: /长期|中长期|价值/.test(text) ? "中长期" : undefined,
    buyRules,
    riskRules,
    decisionPolicy,
    notes: `由微信偏好描述确认写入：${text.slice(0, 800)}`,
  };
}

function buildStrategyInstanceExpansionDraft(text: string) {
  const proposedChange = text.trim().slice(0, 1000);
  const affectedAreas: string[] = [];
  if (/提醒|通知|推送|关注升级|重点提醒|低打扰|低噪/.test(text)) affectedAreas.push("alerts");
  if (/复盘/.test(text)) affectedAreas.push("review");
  if (/上一条|观点|验证|新结论|闭环|先看|先检查|回顾/.test(text) && !affectedAreas.includes("review")) affectedAreas.push("review");
  if (/选股|候选|自选/.test(text)) affectedAreas.push("screening");
  if (/突破|回踩|放量|站稳|支撑|技术/.test(text)) affectedAreas.push("technical_entry");
  if (!affectedAreas.length) affectedAreas.push("strategy_behavior");

  const reason = [
    "用户在对话中表达了会影响当前实例长期行为的偏好。",
    "按 strategy skill 治理规则，这类变化应先作为实例展开候选，确认后进入候选记录，不得直接修改受保护骨架。",
  ].join("");

  return {
    proposedChange,
    reason,
    affectedAreas,
    affectedResource: "strategy_skill_instance_expansion",
    sourceType: "conversation_instance_expansion",
    rawText: text,
  };
}

function extractStockRef(segment: string): StockRef | null {
  const code = segment.match(/\b(\d{6})\b/)?.[1];
  if (code) {
    const cost = extractCostPriceFromSegment(segment);
    return cost != null ? { code, costPrice: cost } : { code };
  }

  const cost = extractCostPriceFromSegment(segment);
  const cleaned = segment
    .replace(/^(我)?(现在)?(持有|持仓|买了|观察|关注|自选|把|将|如果|，|,|\s)+/, "")
    .replace(/(如果)?(回调到|跌到|到|接近|提醒我|提醒|成本价?|均价|数量|股数|多少|附近|左右).*/, "")
    .replace(/\d+(?:\.\d+)?/g, "")
    .replace(/[；;，,。]/g, "")
    .trim();
  if (!cleaned) return null;
  return cost != null ? { name: cleaned.slice(0, 24), costPrice: cost } : { name: cleaned.slice(0, 24) };
}

function extractCostPriceFromSegment(segment: string): number | undefined {
  const patterns = [
    /(?:成本价?|买入价|均价|成本|买入)\s*(?:大概|是|为)?\s*(\d+(?:\.\d+)?)/,
    /(\d+(?:\.\d+)?)\s*(?:块|元)\s*(?:买的|入手|买入|买进|成本)/,
  ];
  for (const pattern of patterns) {
    const matched = segment.match(pattern)?.[1];
    if (matched) {
      const value = Number(matched);
      if (Number.isFinite(value) && value > 0 && value < 100000) return value;
    }
  }
  return undefined;
}

function extractAlertStockRef(text: string): StockRef | null {
  const code = text.match(/\b(\d{6})\b/)?.[1];
  if (code) return { code };

  const patterns = [
    /(?:持有|持仓|买了|观察|关注|自选|监控|盯一下|盯|提醒|看看|看一下)([\u4e00-\u9fa5A-Za-z0-9]{2,24}?)(?:，|。|；|,|;|\s|到|达到|涨到|跌到|突破|回调到|高于|低于|超过|价格)/,
    /^([\u4e00-\u9fa5A-Za-z0-9]{2,24}?)(?:到|达到|涨到|跌到|突破|回调到|高于|低于|超过)\s*\d/,
  ];
  for (const pattern of patterns) {
    const matched = text.match(pattern)?.[1];
    if (matched) {
      const cleaned = matched
        .replace(/^(我|帮我|你帮我|请|把|将|如果|当|它|价格)+/, "")
        .replace(/(股票|这个|这只|一下)+$/, "")
        .trim();
      if (cleaned.length >= 2) return { name: cleaned.slice(0, 24) };
    }
  }
  return null;
}

function resolveOneStockFast(segment: string): { code: string; name: string } | null {
  const ref = extractStockRef(segment);
  if (!ref) return null;
  if (!ref.code) return null;
  return { code: ref.code, name: ref.name || ref.code };
}

function parseAlertCondition(text: string): { indicator: "target_price" | "support_price" | "price"; threshold: number; label: string } | null {
  const percentMatched = text.match(/(?:上涨|涨幅|大涨|下跌|跌幅|大跌|涨跌幅|波动|异动|超过|达到|高于)\s*([0-9]+(?:\.[0-9]+)?)\s*%/);
  if (percentMatched) {
    const threshold = Number(percentMatched[1]);
    if (!Number.isFinite(threshold) || threshold <= 0) return null;
    return {
      indicator: "price",
      threshold,
      label: `涨跌幅达到 ${threshold}%`,
    };
  }

  const matched = text.match(/(?:价格)?(?:回调到|跌到|涨到|达到|突破|高于|低于|超过|到)\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!matched) return null;
  const threshold = Number(matched[1]);
  if (!Number.isFinite(threshold) || threshold <= 0) return null;
  const matchIndex = matched.index ?? 0;
  const prefix = text.slice(Math.max(0, matchIndex - 6), matchIndex + matched[0].length);
  const indicator = /(跌到|回调到|低于)/.test(prefix) ? "support_price" : "target_price";
  return {
    indicator,
    threshold,
    label: indicator === "support_price" ? `价格低于或到达 ${threshold} 元` : `价格达到或高于 ${threshold} 元`,
  };
}

async function buildAlertDraft(text: string) {
  const stockRef = extractAlertStockRef(text);
  const condition = parseAlertCondition(text);
  if (!stockRef || !condition) {
    return { status: "unresolved" as const, rawText: text, unresolved: [stockRef || { name: text.slice(0, 24) }], condition };
  }

  const resolved = await resolveStockRefDetails([stockRef]);
  const stock = resolved.resolved[0];
  if (!stock || stock.confidence !== "high") {
    return {
      status: "low_confidence" as const,
      rawText: text,
      unresolved: resolved.unresolved.length ? resolved.unresolved : [stockRef],
      candidates: stock?.candidates ?? [],
      condition,
    };
  }

  return {
    status: "ready" as const,
    rawText: text,
    stock: { code: stock.code, name: stock.name, confidence: stock.confidence },
    indicator: condition.indicator,
    threshold: condition.threshold,
    conditionLabel: condition.label,
  };
}

type AiIntentPayload = {
  intent?: string;
  operation?: string;
  alerts?: AiIntentPayload[];
  stockName?: string;
  stockCode?: string;
  code?: string;
  direction?: string;
  price?: number | string;
  threshold?: number | string;
  condition?: string;
  rawText?: string;
};

export function hasAiIntentReply(text: string) {
  return AI_INTENT_PATTERN.test(text);
}

function extractAiIntentPayload(text: string): AiIntentPayload | null {
  const rawJson = text.match(AI_INTENT_PATTERN)?.[1];
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as AiIntentPayload;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function buildAlertDraftFromAiIntent(intent: AiIntentPayload) {
  const stockRef: StockRef | null = intent.stockCode || intent.code
    ? { code: String(intent.stockCode || intent.code), name: intent.stockName }
    : intent.stockName
      ? { name: intent.stockName }
      : null;
  const threshold = Number(intent.price ?? intent.threshold);
  if (!stockRef || !Number.isFinite(threshold) || threshold <= 0) {
    return {
      status: "unresolved" as const,
      rawText: intent.rawText || "",
      unresolved: [stockRef || { name: intent.stockName || intent.rawText || "未识别标的" }],
      condition: null,
    };
  }

  const directionText = `${intent.direction || ""} ${intent.condition || ""}`;
  const isPercentAlert = /%|上涨|涨幅|下跌|跌幅|涨跌幅|波动|异动|percent/i.test(`${intent.rawText || ""} ${intent.condition || ""}`);
  const indicator: "target_price" | "support_price" | "price" = isPercentAlert
    ? "price"
    : /(below|down|support|跌|低于|回调|支撑)/i.test(directionText)
      ? "support_price"
      : "target_price";
  const resolved = await resolveStockRefDetails([stockRef]);
  const stock = resolved.resolved[0];
  if (!stock || stock.confidence !== "high") {
    return {
      status: "low_confidence" as const,
      rawText: intent.rawText || "",
      unresolved: resolved.unresolved.length ? resolved.unresolved : [stockRef],
      candidates: stock?.candidates ?? [],
      condition: {
        indicator,
        threshold,
        label: formatAlertConditionLabel(indicator, threshold),
      },
    };
  }

  return {
    status: "ready" as const,
    rawText: intent.rawText || "",
    stock: { code: stock.code, name: stock.name, confidence: stock.confidence },
    indicator,
    threshold,
    conditionLabel: formatAlertConditionLabel(indicator, threshold),
  };
}

function formatAlertConditionLabel(indicator: "target_price" | "support_price" | "price", threshold: number) {
  if (indicator === "price") return `涨跌幅达到 ${threshold}%`;
  if (indicator === "support_price") return `价格低于或到达 ${threshold} 元`;
  return `价格达到或高于 ${threshold} 元`;
}

async function buildPortfolioWatchlistDraft(text: string) {
  const parts = text.split(/[；;。]/).map((item) => item.trim()).filter(Boolean);
  const holdings: Array<{ code: string; name: string; costPrice?: number; note: string }> = [];
  const watchItems: Array<{ code: string; name: string; reason: string; support?: number; note: string }> = [];
  const unresolved: string[] = [];

  for (const part of parts) {
    if (/(持有|持仓|买了)/.test(part)) {
      const stock = resolveOneStockFast(part);
      if (!stock) {
        unresolved.push(part);
        continue;
      }
      holdings.push({
        ...stock,
        costPrice: extractCostPriceFromSegment(part),
        note: part,
      });
      continue;
    }

    if (/(观察|关注|自选|提醒)/.test(part)) {
      const stock = resolveOneStockFast(part);
      if (!stock) {
        unresolved.push(part);
        continue;
      }
      const support = Number(part.match(/(?:回调到|跌到|到|接近)\s*([\d.]+)/)?.[1] || 0) || undefined;
      watchItems.push({
        ...stock,
        support,
        reason: support ? `回调到 ${support} 附近提醒` : part,
        note: part,
      });
    }
  }

  return { holdings, watchItems, unresolved, rawText: text };
}

function formatDraft(taskId: string, draft: ReturnType<typeof buildInvestmentPreferenceDraft>) {
  const lines = [
    "我先整理成一条“长期投资偏好”草案，确认前不会正式生效：",
    "",
    `风格：${draft.style}`,
  ];
  if (draft.riskPreference) lines.push(`风险偏好：${draft.riskPreference}`);
  if (draft.investmentHorizon) lines.push(`周期：${draft.investmentHorizon}`);
  if (draft.buyRules.length) lines.push(`买入/判断规则：${draft.buyRules.join("；")}`);
  if (draft.riskRules.length) lines.push(`风控规则：${draft.riskRules.join("；")}`);
  lines.push(
    "",
    "确认后我再写入长期偏好。你可以直接回复“确认”；如果要改，直接说要改哪一条；不想保存就回复“取消”。",
    "",
    `任务号：${taskId.slice(0, 8)}`
  );
  return lines.join("\n");
}

function formatStrategyInstanceExpansionDraft(taskId: string, draft: ReturnType<typeof buildStrategyInstanceExpansionDraft>) {
  const lines = [
    "我先整理成一条“实例展开变更”草案，确认前不会生效：",
    "",
    `变更：${draft.proposedChange}`,
    `影响范围：${draft.affectedAreas.join("、")}`,
    "",
    "这只影响当前实例的个性化展开，不修改受保护的策略骨架。",
    "确认后我会写入实例展开候选记录，后续复盘和方法维护可以追踪；如果要改措辞，直接说要改哪一条；不保存就回复“取消”。",
    "",
    `任务号：${taskId.slice(0, 8)}`,
  ];
  return lines.join("\n");
}

function formatPortfolioWatchlistDraft(taskId: string, draft: Awaited<ReturnType<typeof buildPortfolioWatchlistDraft>>) {
  const lines = ["我先整理成一份“持仓/自选录入”草案，确认前不会写入：", ""];
  if (draft.holdings.length) {
    lines.push("持仓(记录标的与每股成本价,不记录数量/金额)：");
    for (const item of draft.holdings) {
      const costPart = item.costPrice != null ? ` 成本 ${item.costPrice}` : "";
      lines.push(`- ${item.name}(${item.code})${costPart}`);
    }
  }
  if (draft.watchItems.length) {
    lines.push("", "自选/观察：");
    for (const item of draft.watchItems) {
      lines.push(`- ${item.name}(${item.code})，${item.reason}`);
    }
  }
  if (draft.unresolved.length) {
    lines.push("", "还没识别清楚：", ...draft.unresolved.map((item) => `- ${item}`));
  }
  lines.push(
    "",
    "确认后我再写入。你可以直接回复“确认”；如果有股票或条件不对，直接发修改内容；不写入就回复“取消”。",
    "",
    `任务号：${taskId.slice(0, 8)}`
  );
  return lines.join("\n");
}

function formatAlertDraft(taskId: string, draft: Extract<Awaited<ReturnType<typeof buildAlertDraft>>, { status: "ready" }>) {
  const lines = [
    "我准备设置一条提醒，确认前不会写入：",
    "",
    `标的：${draft.stock.name}(${draft.stock.code})`,
    `条件：${draft.conditionLabel}`,
    "提醒级别：P0，到价后提醒",
    "",
    "确认的话直接回复“确认”即可；如果价格或方向不对，直接说新的条件；不设置就回复“取消”。",
    "",
    `任务号：${taskId.slice(0, 8)}`,
  ];
  return lines.join("\n");
}

type ReadyAlertDraft = Extract<Awaited<ReturnType<typeof buildAlertDraft>>, { status: "ready" }>;

function formatAlertBatchDraft(taskId: string, drafts: ReadyAlertDraft[]) {
  const lines = [
    `我准备设置 ${drafts.length} 条提醒，确认前不会写入：`,
    "",
    ...drafts.map((draft) => `- ${draft.stock.name}(${draft.stock.code})：${draft.conditionLabel}`),
    "",
    "确认的话直接回复“确认”即可；如果标的或条件不对，直接说新的条件；不设置就回复“取消”。",
    "",
    `任务号：${taskId.slice(0, 8)}`,
  ];
  return lines.join("\n");
}

function formatLowConfidenceAlertDraft(draft: Exclude<Awaited<ReturnType<typeof buildAlertDraft>>, { status: "ready" }>) {
  const lines = ["这条提醒我还不能直接确认标的，需要你补一个股票代码或更精确名称。"];
  if (draft.candidates?.length) {
    lines.push("", "可能是：", ...draft.candidates.map((item, index) => `${index + 1}. ${item.name}(${item.code})`));
  }
  if (draft.condition) lines.push("", `已识别条件：${draft.condition.label}`);
  lines.push("", "你可以直接发：赣锋锂业到70提醒我，或者 002460 到70提醒我。");
  return lines.join("\n");
}

async function latestPendingTask(userContext: UserContext) {
  const rows = await db
    .select()
    .from(conversationTasks)
    .where(and(
      eq(conversationTasks.userId, userContext.userId),
      eq(conversationTasks.instanceId, userContext.instanceId || "invest-agent-primary"),
      eq(conversationTasks.conversationId, userContext.conversationId || ""),
      eq(conversationTasks.status, "pending")
    ))
    .orderBy(desc(conversationTasks.createdAt))
    .limit(1);
  const task = rows[0];
  if (!task) return null;
  if (new Date(task.expiresAt).getTime() <= Date.now()) {
    await db.update(conversationTasks).set({ status: "expired", updatedAt: new Date().toISOString() }).where(eq(conversationTasks.id, task.id));
    return null;
  }
  return task;
}

async function applyInvestmentProfileTask(userContext: UserContext, task: typeof conversationTasks.$inferSelect) {
  const draft = parseJsonText(task.draftPayload, {}) as ReturnType<typeof buildInvestmentPreferenceDraft>;
  const now = new Date().toISOString();
  const instanceId = userContext.instanceId || "invest-agent-primary";

  if (ACTIVE_BACKEND === "workspace") {
    await applyInvestmentProfileToWorkspace(userContext.userId, draft, now);
  } else {
    await applyInvestmentProfileToSQLite(userContext.userId, instanceId, draft, now);
  }
  await db.update(conversationTasks).set({
    status: "completed",
    resultSummary: "investment profile updated",
    updatedAt: now,
  }).where(eq(conversationTasks.id, task.id));
  return "已确认写入长期投资偏好。\n\n后续复盘、选股、自选和提醒,会优先按这条已确认偏好处理;如果之后要修改,我会继续先给草案,再等你确认。";
}

async function applyInvestmentProfileToSQLite(userId: string, instanceId: string, draft: ReturnType<typeof buildInvestmentPreferenceDraft>, now: string) {
  const existing = await db
    .select()
    .from(investmentProfiles)
    .where(and(eq(investmentProfiles.userId, userId), eq(investmentProfiles.instanceId, instanceId)))
    .limit(1);
  const current = existing[0];
  const values = {
    userId,
    instanceId,
    style: draft.style ?? current?.style ?? null,
    selectedStylePack: draft.selectedStylePack === undefined ? (current?.selectedStylePack ?? null) : draft.selectedStylePack,
    customStyle: jsonText(draft.customStyle ?? parseJsonText(current?.customStyle, {})),
    riskPreference: draft.riskPreference ?? current?.riskPreference ?? null,
    investmentHorizon: draft.investmentHorizon ?? current?.investmentHorizon ?? null,
    markets: current?.markets ?? "[]",
    allocation: current?.allocation ?? "{}",
    positionRoles: current?.positionRoles ?? "{}",
    buyRules: jsonText(draft.buyRules?.length ? draft.buyRules : parseJsonText(current?.buyRules, [])),
    sellRules: current?.sellRules ?? "[]",
    rebalanceRules: current?.rebalanceRules ?? "[]",
    riskRules: jsonText(draft.riskRules?.length ? draft.riskRules : parseJsonText(current?.riskRules, [])),
    notificationPolicy: current?.notificationPolicy ?? "{}",
    decisionPolicy: jsonText(draft.decisionPolicy ?? parseJsonText(current?.decisionPolicy, {})),
    notes: draft.notes ?? current?.notes ?? null,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  if (current) {
    await db.update(investmentProfiles).set(values).where(eq(investmentProfiles.id, current.id));
  } else {
    await db.insert(investmentProfiles).values(values);
  }
}

/**
 * 合并写入 strategy.yaml。仅更新 draft 提供的非空字段,保留其他字段不变。
 *
 * 字段舍弃说明:
 *   - customStyle:原文保留在 task.draftPayload 内,yaml 不存
 *   - notificationPolicy / decisionPolicy:运行时无消费,语义已被 decision_boundaries / do_not_do_rules / risk_rules 表达
 */
async function applyInvestmentProfileToWorkspace(userId: string, draft: ReturnType<typeof buildInvestmentPreferenceDraft>, now: string) {
  const store = new WorkspaceStore(userId);
  const existing = (await store.readStrategy()) ?? ({} as StrategyYaml);
  const profile = { ...(existing.profile ?? {}) };
  if (draft.style) profile.style = draft.style;
  if (draft.selectedStylePack !== undefined) profile.selected_style_pack = draft.selectedStylePack;
  if (draft.riskPreference) profile.risk_preference = draft.riskPreference;
  if (draft.investmentHorizon) profile.investment_horizon = draft.investmentHorizon;
  const buyRules = draft.buyRules?.length ? draft.buyRules : (existing.buy_rules ?? []);
  const riskRules = draft.riskRules?.length ? draft.riskRules : (existing.risk_rules ?? []);
  const notes = draft.notes ?? existing.notes ?? null;
  const next: StrategyYaml = {
    ...existing,
    profile,
    buy_rules: buyRules,
    risk_rules: riskRules,
    notes,
    last_confirmed_at: now,
  };
  await store.writeStrategy(next);
}

async function applyStrategyInstanceExpansionTask(userContext: UserContext, task: typeof conversationTasks.$inferSelect) {
  const draft = parseJsonText(task.draftPayload, {}) as ReturnType<typeof buildStrategyInstanceExpansionDraft>;
  const now = new Date().toISOString();
  const instanceId = userContext.instanceId || "invest-agent-primary";
  const created = await methodChangeBackend.propose({
    userId: userContext.userId,
    instanceId,
    sourceReviewId: String(task.id),
    sourceType: draft.sourceType || "conversation_instance_expansion",
    proposedChange: draft.proposedChange,
    reason: draft.reason,
    affectedResource: draft.affectedResource || "strategy_skill_instance_expansion",
    decisionNote: JSON.stringify({
      taskId: task.id,
      conversationId: task.conversationId,
      affectedAreas: draft.affectedAreas,
      rawText: draft.rawText,
    }),
  });

  await db.update(conversationTasks).set({
    status: "completed",
    resultSummary: `strategy instance expansion candidate ${created?.id ?? ""}`.trim(),
    updatedAt: now,
  }).where(eq(conversationTasks.id, task.id));

  return [
    "已确认写入实例展开候选。",
    "",
    `候选编号：${created?.id ?? "-"}`,
    `变更：${draft.proposedChange}`,
    "",
    "它现在是待应用的候选记录，还没有修改受保护骨架。后续可以在复盘或方法维护时决定是否吸收到当前实例展开里。",
  ].join("\n");
}

async function applyPortfolioWatchlistTask(userContext: UserContext, task: typeof conversationTasks.$inferSelect) {
  const draft = parseJsonText(task.draftPayload, {}) as Awaited<ReturnType<typeof buildPortfolioWatchlistDraft>>;
  const now = new Date().toISOString();
  const instanceId = userContext.instanceId || "invest-agent-primary";

  for (const item of draft.holdings || []) {
    await portfolioBackend.upsertActive(userContext.userId, instanceId, {
      code: item.code,
      name: item.name,
      buyDate: now.slice(0, 10),
      costPrice: item.costPrice ?? null,
    });
  }

  for (const item of draft.watchItems || []) {
    const existing = await db
      .select()
      .from(watchlist)
      .where(and(eq(watchlist.userId, userContext.userId), eq(watchlist.instanceId, instanceId), eq(watchlist.stockCode, item.code)))
      .limit(1);
    const watchValues = {
      userId: userContext.userId,
      instanceId,
      stockCode: item.code,
      stockName: item.name,
      addedAt: now,
      reason: item.reason,
      source: "wechat_onboarding",
    };
    if (existing[0]) {
      await db.update(watchlist).set({ reason: item.reason, source: "wechat_onboarding" }).where(eq(watchlist.id, existing[0].id));
    } else {
      await db.insert(watchlist).values(watchValues);
    }

    if (item.support) {
      const existingPlan = await db
        .select()
        .from(stockPlans)
        .where(and(eq(stockPlans.userId, userContext.userId), eq(stockPlans.instanceId, instanceId), eq(stockPlans.stockCode, item.code)))
        .limit(1);
      const planValues = {
        userId: userContext.userId,
        instanceId,
        stockCode: item.code,
        stockName: item.name,
        support: item.support,
        resistance: null,
        targetPrice: null,
        stopLoss: null,
        notes: item.reason,
        watchConditions: JSON.stringify([{ type: "price_near_support", price: item.support, note: item.reason }]),
        linkedAlertRuleIds: null,
        planType: "wechat_onboarding",
        updatedAt: now,
      };
      if (existingPlan[0]) {
        await db.update(stockPlans).set(planValues).where(eq(stockPlans.id, existingPlan[0].id));
      } else {
        await db.insert(stockPlans).values(planValues);
      }
    }
  }

  await db.update(conversationTasks).set({
    status: "completed",
    resultSummary: `portfolio ${draft.holdings?.length || 0}; watchlist ${draft.watchItems?.length || 0}`,
    updatedAt: now,
  }).where(eq(conversationTasks.id, task.id));

  const lines = ["已确认写入投资档案。"];
  if (draft.holdings?.length) lines.push(`持仓：${draft.holdings.map((item) => `${item.name}(${item.code})`).join("、")}`);
  if (draft.watchItems?.length) lines.push(`自选：${draft.watchItems.map((item) => `${item.name}(${item.code})`).join("、")}`);
  lines.push("后续复盘和提醒会优先使用这些已确认数据。");
  return lines.join("\n");
}

async function applyAlertTask(userContext: UserContext, task: typeof conversationTasks.$inferSelect) {
  const draft = parseJsonText(task.draftPayload, {}) as Extract<Awaited<ReturnType<typeof buildAlertDraft>>, { status: "ready" }>;
  const instanceId = userContext.instanceId || "invest-agent-primary";
  const values = {
    userId: userContext.userId,
    instanceId,
    stockCode: draft.stock.code,
    indicator: draft.indicator,
    threshold: JSON.stringify({ value: draft.threshold }),
    enabled: true,
  };

  const existing = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.userId, userContext.userId), eq(alerts.instanceId, instanceId), eq(alerts.stockCode, draft.stock.code), eq(alerts.indicator, draft.indicator)))
    .limit(1);

  if (existing[0]) {
    await db.update(alerts).set(values).where(eq(alerts.id, existing[0].id));
  } else {
    await db.insert(alerts).values(values);
  }
  await syncLegacyAlertToAlertRule({ ...values, stockName: draft.stock.name });

  await db.update(conversationTasks).set({
    status: "completed",
    resultSummary: `alert ${draft.stock.code} ${draft.indicator} ${draft.threshold}`,
    updatedAt: new Date().toISOString(),
  }).where(eq(conversationTasks.id, task.id));

  return `已确认设置提醒：${draft.stock.name}(${draft.stock.code})，${draft.conditionLabel}。`;
}

async function applyAlertBatchTask(userContext: UserContext, task: typeof conversationTasks.$inferSelect) {
  const drafts = parseJsonText(task.draftPayload, []) as ReadyAlertDraft[];
  const instanceId = userContext.instanceId || "invest-agent-primary";
  const now = new Date().toISOString();
  const confirmed: string[] = [];

  for (const draft of drafts) {
    const values = {
      userId: userContext.userId,
      instanceId,
      stockCode: draft.stock.code,
      indicator: draft.indicator,
      threshold: JSON.stringify({ value: draft.threshold }),
      enabled: true,
    };
    const existing = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.userId, userContext.userId), eq(alerts.instanceId, instanceId), eq(alerts.stockCode, draft.stock.code), eq(alerts.indicator, draft.indicator)))
      .limit(1);

    if (existing[0]) {
      await db.update(alerts).set(values).where(eq(alerts.id, existing[0].id));
    } else {
      await db.insert(alerts).values(values);
    }
    await syncLegacyAlertToAlertRule({ ...values, stockName: draft.stock.name });
    confirmed.push(`${draft.stock.name}(${draft.stock.code})，${draft.conditionLabel}`);
  }

  await db.update(conversationTasks).set({
    status: "completed",
    resultSummary: `alerts ${drafts.length}`,
    updatedAt: now,
  }).where(eq(conversationTasks.id, task.id));

  return [`已确认设置 ${confirmed.length} 条提醒：`, ...confirmed.map((item) => `- ${item}`)].join("\n");
}

export type DraftType = "strategy_expansion" | "preference" | "portfolio_watchlist";

async function insertDraftTask(
  userContext: UserContext,
  fields: {
    type: string;
    title: string;
    summary: string;
    draftPayload: string;
    targetOperation: string;
  }
): Promise<string> {
  const now = Date.now();
  const id = randomUUID();
  await db.insert(conversationTasks).values({
    id,
    userId: userContext.userId,
    projectId: userContext.projectId || "invest-agent",
    instanceId: userContext.instanceId || "invest-agent-primary",
    conversationId: userContext.conversationId || "",
    channel: userContext.channel || "weixin-mobile",
    backend: userContext.backend,
    type: fields.type,
    status: "pending",
    title: fields.title,
    summary: fields.summary,
    draftPayload: fields.draftPayload,
    targetOperation: fields.targetOperation,
    expiresAt: new Date(now + TASK_TTL_MS).toISOString(),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
  return id;
}

export async function createDraftTask(
  userContext: UserContext,
  type: DraftType,
  text: string
): Promise<string | null> {
  if (await latestPendingTask(userContext)) return null;

  if (type === "strategy_expansion") {
    const draft = buildStrategyInstanceExpansionDraft(text);
    const id = await insertDraftTask(userContext, {
      type: "strategy_instance_expansion_draft",
      title: "实例展开变更草案",
      summary: draft.proposedChange.slice(0, 120),
      draftPayload: JSON.stringify(draft),
      targetOperation: "strategy.instance_expansion.propose",
    });
    return formatStrategyInstanceExpansionDraft(id, draft);
  }

  if (type === "preference") {
    const draft = buildInvestmentPreferenceDraft(text);
    const id = await insertDraftTask(userContext, {
      type: "investment_profile_draft",
      title: "长期投资偏好草案",
      summary: draft.style,
      draftPayload: JSON.stringify(draft),
      targetOperation: "profiles.investment.set",
    });
    return formatDraft(id, draft);
  }

  // portfolio_watchlist
  const draft = await buildPortfolioWatchlistDraft(text);
  if (draft.holdings.length === 0 && draft.watchItems.length === 0) return null;
  const id = await insertDraftTask(userContext, {
    type: "portfolio_watchlist_draft",
    title: "持仓/自选录入草案",
    summary: `${draft.holdings.length} 个持仓，${draft.watchItems.length} 个自选`,
    draftPayload: JSON.stringify(draft),
    targetOperation: "onboarding.portfolio_watchlist.set",
  });
  return formatPortfolioWatchlistDraft(id, draft);
}

export async function handlePendingConversationTaskTurn(userContext: UserContext, text: string): Promise<string | null> {
  const pending = await latestPendingTask(userContext);
  if (pending) {
    if (isConfirmText(text) && pending.targetOperation === "profiles.investment.set") {
      return applyInvestmentProfileTask(userContext, pending);
    }
    if (isConfirmText(text) && pending.targetOperation === "strategy.instance_expansion.propose") {
      return applyStrategyInstanceExpansionTask(userContext, pending);
    }
    if (isConfirmText(text) && pending.targetOperation === "onboarding.portfolio_watchlist.set") {
      return applyPortfolioWatchlistTask(userContext, pending);
    }
    if (isConfirmText(text) && pending.targetOperation === "alerts.set") {
      return applyAlertTask(userContext, pending);
    }
    if (isConfirmText(text) && pending.targetOperation === "alerts.batch_set") {
      return applyAlertBatchTask(userContext, pending);
    }
    if (isRejectText(text)) {
      await db.update(conversationTasks).set({
        status: "rejected",
        resultSummary: "user rejected task",
        updatedAt: new Date().toISOString(),
      }).where(eq(conversationTasks.id, pending.id));
      return "好的，这条草案不会写入长期设置，只作为本次对话参考。";
    }
    if (/^2|修改|改一下|调整/.test(text.trim())) {
      return "可以，把你想修改的地方直接发我。我会重新整理一版草案，再等你确认。";
    }
  }

  return null;
}

async function createAlertTaskReply(userContext: UserContext, draft: Extract<Awaited<ReturnType<typeof buildAlertDraft>>, { status: "ready" }>) {
  const now = Date.now();
  const id = randomUUID();
  await db.insert(conversationTasks).values({
    id,
    userId: userContext.userId,
    projectId: userContext.projectId || "invest-agent",
    instanceId: userContext.instanceId || "invest-agent-primary",
    conversationId: userContext.conversationId || "",
    channel: userContext.channel || "weixin-mobile",
    backend: userContext.backend,
    type: "alert_draft",
    status: "pending",
    title: "提醒设置草案",
    summary: `${draft.stock.name} ${draft.conditionLabel}`,
    draftPayload: JSON.stringify(draft),
    targetOperation: "alerts.set",
    expiresAt: new Date(now + TASK_TTL_MS).toISOString(),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
  return formatAlertDraft(id, draft);
}

async function createAlertBatchTaskReply(userContext: UserContext, drafts: ReadyAlertDraft[]) {
  const now = Date.now();
  const id = randomUUID();
  await db.insert(conversationTasks).values({
    id,
    userId: userContext.userId,
    projectId: userContext.projectId || "invest-agent",
    instanceId: userContext.instanceId || "invest-agent-primary",
    conversationId: userContext.conversationId || "",
    channel: userContext.channel || "weixin-mobile",
    backend: userContext.backend,
    type: "alert_batch_draft",
    status: "pending",
    title: "批量提醒设置草案",
    summary: `${drafts.length} 条提醒`,
    draftPayload: JSON.stringify(drafts),
    targetOperation: "alerts.batch_set",
    expiresAt: new Date(now + TASK_TTL_MS).toISOString(),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
  return formatAlertBatchDraft(id, drafts);
}

export async function handleAiIntentDraftTurn(userContext: UserContext, aiRawText: string): Promise<string | null> {
  const intent = extractAiIntentPayload(aiRawText);
  if (!intent) return null;
  const operation = intent.intent || intent.operation;
  if ((operation === "set_alert_batch" || Array.isArray(intent.alerts)) && intent.alerts?.length) {
    const drafts = await Promise.all(intent.alerts.map((item) => buildAlertDraftFromAiIntent({ ...item, intent: "set_alert", rawText: item.rawText || intent.rawText })));
    const unresolved = drafts.find((draft) => draft.status !== "ready");
    if (unresolved) return formatLowConfidenceAlertDraft(unresolved);
    return createAlertBatchTaskReply(userContext, drafts as ReadyAlertDraft[]);
  }
  if (operation !== "set_alert") return null;
  const draft = await buildAlertDraftFromAiIntent(intent);
  if (draft.status !== "ready") return formatLowConfidenceAlertDraft(draft);
  return createAlertTaskReply(userContext, draft);
}

export function stripAiIntentReply(text: string) {
  return text.replace(AI_INTENT_PATTERN, "").trim();
}
