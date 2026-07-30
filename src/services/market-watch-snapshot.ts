import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { marketWatchSnapshots } from "../db/schema.js";
import { marketSnapshot, type MarketSnapshot, type MarketSnapshotItem } from "./market-data.js";

export async function captureMarketWatchSnapshot(input: { userId: string; projectId: string; instanceId: string; windowKey: string }) {
  // WP7: 冻结写入。market-watch 新路径 (WP4) 已不再预抓取 snapshot; 这里阻止即使
  // flag=true 旧路径或未知调用方写入新行。历史数据保留,读取入口仍可用 (deprecated)。
  // 恢复写入设 MARKET_WATCH_SNAPSHOT_FREEZE=false。
  if (process.env.MARKET_WATCH_SNAPSHOT_FREEZE !== "false") {
    return null;
  }
  const snapshot = await marketSnapshot({ userId: input.userId, instanceId: input.instanceId });
  const previous = await latestMarketWatchSnapshot(input.userId, input.instanceId);
  const delta = buildMarketWatchDelta(snapshot, previous?.snapshot ?? null, previous?.windowKey ?? null);
  const tradingDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const now = new Date().toISOString();
  const record = { id: randomUUID(), ...input, capturedAt: snapshot.updatedAt, snapshot, delta, createdAt: now };
  await db.insert(marketWatchSnapshots).values({ id: record.id, userId: input.userId, projectId: input.projectId, instanceId: input.instanceId, tradingDate, windowKey: input.windowKey, capturedAt: record.capturedAt, snapshotJson: JSON.stringify(snapshot), deltaJson: JSON.stringify(delta), createdAt: now });
  return record;
}

/**
 * Snapshots are retained audit records. Older records predate some optional
 * collections, so read them defensively instead of making scheduler progress
 * depend on a historical JSON shape.
 */
function snapshotItems(snapshot: Partial<MarketSnapshot>) {
  const items = new Map<string, MarketSnapshotItem>();
  const collections = [snapshot.holdings, snapshot.watchlist, snapshot.plans];
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (!item || typeof item.stockCode !== "string" || !item.stockCode) continue;
      const existing = items.get(item.stockCode);
      items.set(item.stockCode, existing ? { ...existing, ...item } : item);
    }
  }
  return items;
}

export function buildMarketWatchDelta(current: MarketSnapshot, previous: MarketSnapshot | null, previousWindowKey: string | null) {
  if (!previous) return { previousWindowKey: null, materiallyChanged: true, stockChanges: [], indexChanges: [], warningsChanged: false, summary: "本交易日首个快照，无上一窗口可比。" };
  const prior = snapshotItems(previous); const latest = snapshotItems(current);
  const stockChanges = [...new Set([...prior.keys(), ...latest.keys()])].sort().map((code) => {
    const oldItem = prior.get(code); const item = latest.get(code);
    const previousPrice = oldItem?.quote?.price ?? null; const price = item?.quote?.price ?? null;
    const previousChangePercent = oldItem?.quote?.changePercent ?? null; const changePercent = item?.quote?.changePercent ?? null;
    const previousTradingStatus = oldItem?.quote?.tradingStatus.status ?? null; const tradingStatus = item?.quote?.tradingStatus.status ?? null;
    const previousLevels = oldItem ? levels(oldItem) : null; const currentLevels = item ? levels(item) : null;
    const state = !oldItem ? "added" : !item ? "removed" : previousPrice !== price || previousChangePercent !== changePercent || previousTradingStatus !== tradingStatus || JSON.stringify(previousLevels) !== JSON.stringify(currentLevels) ? "changed" : "unchanged";
    return { code, name: item?.stockName ?? oldItem?.stockName ?? code, state, previousPrice, price, priceChange: price !== null && previousPrice !== null ? Number((price - previousPrice).toFixed(3)) : null, previousChangePercent, changePercent, previousTradingStatus, tradingStatus, previousLevels, levels: currentLevels };
  });
  const previousIndices = Array.isArray(previous.indices) ? previous.indices : [];
  const currentIndices = Array.isArray(current.indices) ? current.indices : [];
  const oldIndices = new Map(previousIndices.map((item) => [item.code, item])); const newIndices = new Map(currentIndices.map((item) => [item.code, item]));
  const indexChanges = [...new Set([...oldIndices.keys(), ...newIndices.keys()])].sort().map((code) => { const oldIndex = oldIndices.get(code); const index = newIndices.get(code); return { code, name: index?.name ?? oldIndex?.name ?? code, state: !oldIndex ? "added" : !index ? "removed" : oldIndex.price !== index.price || oldIndex.changePercent !== index.changePercent ? "changed" : "unchanged", previousPrice: oldIndex?.price ?? null, price: index?.price ?? null, previousChangePercent: oldIndex?.changePercent ?? null, changePercent: index?.changePercent ?? null }; });
  const previousWarnings = Array.isArray(previous.warnings) ? previous.warnings : [];
  const currentWarnings = Array.isArray(current.warnings) ? current.warnings : [];
  const warningsChanged = previousWarnings.length !== currentWarnings.length || previousWarnings.some((warning) => !currentWarnings.includes(warning));
  const materiallyChanged = stockChanges.some((item) => item.state !== "unchanged") || indexChanges.some((item) => item.state !== "unchanged") || warningsChanged;
  return { previousWindowKey, materiallyChanged, stockChanges, indexChanges, warningsChanged, summary: materiallyChanged ? `相较 ${previousWindowKey} 的有效行情或预案变化见 stockChanges/indexChanges。` : `相较 ${previousWindowKey} 无有效行情、预案或数据质量变化。` };
}

function levels(item: MarketSnapshotItem) { return { support: item.support ?? null, resistance: item.resistance ?? null, targetPrice: item.targetPrice ?? null, stopLoss: item.stopLoss ?? null }; }

/**
 * @deprecated WP7: snapshot 写入已冻结,此函数只读历史数据。新代码不应依赖它做
 * 实时判定;历史快照仅供审计。读取入口 (market_watch.snapshot MCP 工具) 保留兼容。
 */
export async function latestMarketWatchSnapshot(userId: string, instanceId: string) {
  const [row] = await db.select().from(marketWatchSnapshots).where(and(eq(marketWatchSnapshots.userId, userId), eq(marketWatchSnapshots.instanceId, instanceId))).orderBy(desc(marketWatchSnapshots.capturedAt)).limit(1);
  return row ? { id: row.id, windowKey: row.windowKey, capturedAt: row.capturedAt, snapshot: JSON.parse(row.snapshotJson) as MarketSnapshot, delta: JSON.parse(row.deltaJson) } : null;
}
