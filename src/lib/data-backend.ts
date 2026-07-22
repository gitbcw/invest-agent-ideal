/**
 * 数据后端抽象层。
 *
 * 提供 SQLite 和 Workspace 两种后端的统一接口,通过环境变量 WORKSPACE_BACKEND 切换:
 *   - "sqlite"(默认):行为不变,读写 SQLite
 *   - "workspace":读写工作空间 yaml/jsonl
 *
 * 工作包 4.1:portfolio 一条链路。
 * 工作包 4.2:扩展到 watchlist + plan。
 * 工作包 4.3:scheduler(alert-check/pre-market)、monitor/alert/review handler 全部切到 backend 读。
 * 工作包 4.4:profile / methodology 切到 workspace(strategy.yaml + knowledge/methods/*.md)。
 *   ACTIVE_BACKEND 在 sandbox.ts 内部分支使用,
 *   不通过 PortfolioBackend 接口抽象,因为 profile 读写是一次性整文件操作,不需要行级 CRUD。
 *   (2026-06-22 方向 B 重构:profile-context.ts 已删,相关读取不再经此层;此处注释保留历史)
 * 工作包 4.5:plan-conditions.setPlanWatchConditions 切到 planBackend.upsert,
 *   消除 stock_plans 表在主路径上的最后直写残留。
 * 工作包 4.6:weixin-conversation-memory 切到 memory/behavior_events.jsonl,
 *   消除 chat_history 表在主路径上的写入。
 *
 * 双轨期残留(系统层 / 工作包 5 范畴):
 *   - alert_rules / alert_events:仍在 SQLite;这是系统层规则与事件状态,不属于 portfolio 数据
 *   - review_viewpoints / method_change_candidates:属工作包 5 自演进闭环范畴
 *   - daily_plans:✅ WP4.7 已切到 `daily-plan-backend.ts`,workspace 模式走 `plans/daily/<date>.yaml`
 */

import { sqlitePortfolioBackend } from "./sqlite-portfolio-backend.js";
import { workspacePortfolioBackend } from "./workspace-portfolio-backend.js";
import { sqliteWatchlistBackend } from "./sqlite-watchlist-backend.js";
import { workspaceWatchlistBackend } from "./workspace-watchlist-backend.js";
import { sqlitePlanBackend } from "./sqlite-plan-backend.js";
import { workspacePlanBackend } from "./workspace-plan-backend.js";

export type BackendKind = "sqlite" | "workspace";

export const ACTIVE_BACKEND: BackendKind =
  process.env.WORKSPACE_BACKEND === "sqlite" ? "sqlite" : "workspace";

export function isWorkspaceBackend(): boolean {
  return ACTIVE_BACKEND === "workspace";
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
    }
  ): Promise<PortfolioRow>;
  /** 标记为 closed(写入 sellPrice/sellDate) */
  markClosed(
    userId: string,
    instanceId: string,
    code: string,
    sellPrice?: number
  ): Promise<PortfolioRow | null>;
  /** 记录交易动作(portfolio 模块同时落日志,sqlite→trade_actions 表,workspace→behavior_events.jsonl) */
  recordTradeAction(action: TradeActionRow): Promise<void>;
}

// ============ Backend 选择器 ============

export const portfolioBackend: PortfolioBackend =
  ACTIVE_BACKEND === "workspace" ? workspacePortfolioBackend : sqlitePortfolioBackend;

export const watchlistBackend: WatchlistBackend =
  ACTIVE_BACKEND === "workspace" ? workspaceWatchlistBackend : sqliteWatchlistBackend;

export const planBackend: PlanBackend =
  ACTIVE_BACKEND === "workspace" ? workspacePlanBackend : sqlitePlanBackend;

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
    }
  ): Promise<WatchlistRow>;
  patch(
    userId: string,
    instanceId: string,
    code: string,
    patch: { reason?: string; source?: string; name?: string }
  ): Promise<WatchlistRow | null>;
  remove(userId: string, instanceId: string, code: string): Promise<WatchlistRow | null>;
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
    }
  ): Promise<PlanRow>;
  remove(userId: string, instanceId: string, code: string): Promise<PlanRow | null>;
}
