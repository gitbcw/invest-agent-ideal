/**
 * 数据后端抽象层。
 *
 * E8（2026-08-15）：workspace/sqlite 回滚后端已拆除，Mastra 投影是唯一
 * 运行时后端。WORKSPACE_BACKEND 环境变量不再影响运行时行为；历史实现
 * 文件仅保留给迁移脚本与只读源工具（workspace-*-backend 不再被运行时
 * 引用）。ACTIVE_BACKEND 保留为常量导出，供调用点的日志与防御分支在
 * 收敛期引用。
 */

import { mastraPlanBackend, mastraPortfolioBackend, mastraWatchlistBackend } from "./mastra-portfolio-backend.js";

export type BackendKind = "mastra";

export const ACTIVE_BACKEND: BackendKind = "mastra";

export function isWorkspaceBackend(): boolean {
  return false;
}

// ============ Portfolio ============

export interface PortfolioRow {
  id?: number;
  /** workspace 模式下不一定有 */
  userId?: string;
  instanceId?: string;
  code: string;
  name: string;
  buyDate: string;
  /** 每股成本价(单价);不存数量/金额,只存单价用于浮亏与盈亏比计算 */
  costPrice?: number | null;
  sellPrice?: number | null;
  sellDate?: string | null;
  status: "open" | "closed";
  /** SQLite 主键(workspace 模式下为 undefined) */
  rowId?: number;
}

export interface TradeActionRow {
  userId: string;
  instanceId: string;
  code: string;
  action: "buy" | "sell" | "hold" | "update";
  price?: number | null;
  quantity?: number | null;
  notes?: string;
  createdAt: string;
}

export interface PortfolioBackend {
  /** 当前未卖出的持仓 */
  listActive(userId: string, instanceId: string): Promise<PortfolioRow[]>;
  /** 包含 closed 的全部记录 */
  listAll(userId: string, instanceId: string): Promise<PortfolioRow[]>;
  /** 按 code 查单条未卖出 */
  findActive(userId: string, instanceId: string, code: string): Promise<PortfolioRow | null>;
  /** 新增或覆盖(按 code + status=open 唯一) */
  upsertActive(
    userId: string,
    instanceId: string,
    input: {
      code: string;
      name: string;
      buyDate?: string;
      costPrice?: number | null;
      expectedRevision?: string | null;
    }
  ): Promise<PortfolioRow>;
  /** 标记为 closed(写入 sellPrice/sellDate) */
  markClosed(
    userId: string,
    instanceId: string,
    code: string,
    sellPrice?: number,
    expectedRevision?: string | null
  ): Promise<PortfolioRow | null>;
  /** 记录交易动作(portfolio 模块同时落日志,sqlite→trade_actions 表,workspace→behavior_events.jsonl) */
  recordTradeAction(action: TradeActionRow): Promise<void>;
}

// ============ Backend 选择器 ============

export const portfolioBackend: PortfolioBackend = mastraPortfolioBackend;

export const watchlistBackend: WatchlistBackend = mastraWatchlistBackend;

export const planBackend: PlanBackend = mastraPlanBackend;

// ============ Watchlist ============

export interface WatchlistRow {
  /** SQLite 主键 */
  rowId?: number;
  /** workspace 模式下不一定有 */
  userId?: string;
  instanceId?: string;
  code: string;
  name: string;
  addedAt?: string;
  reason?: string | null;
  source?: string;
}

export interface WatchlistBackend {
  list(userId: string, instanceId: string): Promise<WatchlistRow[]>;
  find(userId: string, instanceId: string, code: string): Promise<WatchlistRow | null>;
  add(
    userId: string,
    instanceId: string,
    input: {
      code: string;
      name: string;
      reason?: string;
      source?: string;
      addedAt?: string;
      expectedRevision?: string | null;
    }
  ): Promise<WatchlistRow>;
  patch(
    userId: string,
    instanceId: string,
    code: string,
    patch: { reason?: string; source?: string; name?: string; expectedRevision?: string | null }
  ): Promise<WatchlistRow | null>;
  remove(userId: string, instanceId: string, code: string, expectedRevision?: string | null): Promise<WatchlistRow | null>;
}

// ============ StockPlan ============

export interface PlanRow {
  /** SQLite 主键 */
  rowId?: number;
  userId?: string;
  instanceId?: string;
  code: string;
  name: string;
  support?: number | null;
  resistance?: number | null;
  targetPrice?: number | null;
  stopLoss?: number | null;
  notes?: string | null;
  watchConditions?: unknown;
  linkedAlertRuleIds?: string[];
  planType?: string;
  /** 溯源:基于哪份交易策略生成(trading_strategies.yaml 的 key) */
  strategyKey?: string | null;
  updatedAt?: string;
}

export interface PlanBackend {
  list(userId: string, instanceId: string): Promise<PlanRow[]>;
  find(userId: string, instanceId: string, code: string): Promise<PlanRow | null>;
  upsert(
    userId: string,
    instanceId: string,
    input: {
      code: string;
      name: string;
      support?: number | null;
      resistance?: number | null;
      targetPrice?: number | null;
      stopLoss?: number | null;
      notes?: string | null;
      watchConditions?: unknown;
      linkedAlertRuleIds?: string[];
      planType?: string;
      strategyKey?: string | null;
      expectedRevision?: string | null;
    }
  ): Promise<PlanRow>;
  remove(userId: string, instanceId: string, code: string, expectedRevision?: string | null): Promise<PlanRow | null>;
}
