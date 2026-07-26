/**
 * 工作空间存储层。
 *
 * 提供对工作空间内 yaml/jsonl/md 的统一读写 API。所有投资判断类数据的存取都应通过本模块,
 * 不直接读 fs,以便后续:
 *   - 加缓存
 *   - 加 schema 校验
 *   - 加沙箱审计(工作包 4)
 *   - 加双写过渡(工作包 4)
 *
 * 工作包 3 引入基础设施,工作包 4 各 handler / sandbox 接入。
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { resolveWorkspacePath } from "./workspace.js";
import { logger } from "./logger.js";

// ============ 类型 ============

export interface PortfolioHolding {
  name: string;
  code: string;
  asset_type?: string;
  market?: string;
  account?: string | null;
  currency?: string;
  cost?: number | null;
  shares?: number | null;
  market_value?: number | null;
  weight?: number | null;
  buy_date?: string | null;
  cost_price?: number | null;
  sell_price?: number | null;
  sell_date?: string | null;
  status?: string;
  role?: string;
  notes?: string;
}

export interface PortfolioWatchItem {
  name: string;
  code: string;
  asset_type?: string;
  market?: string;
  trigger?: string;
  source?: string;
  added_at?: string;
  notes?: string;
}

export interface StockPlan {
  name: string;
  code: string;
  support?: number | null;
  resistance?: number | null;
  target_price?: number | null;
  stop_loss?: number | null;
  watch_conditions?: unknown;
  linked_alert_rule_ids?: string[];
  plan_type?: string;
  /** 溯源:基于哪份交易策略生成(trading_strategies.yaml 的 key) */
  strategy_key?: string | null;
  updated_at?: string;
  notes?: string;
}

export interface PortfolioYaml {
  cash?: unknown;
  holdings?: PortfolioHolding[];
  watchlist?: PortfolioWatchItem[];
  stock_plans?: StockPlan[];
  accounts?: unknown[];
  last_confirmed_at?: string | null;
  last_confirmed_by?: string | null;
  last_confirmation_id?: string | null;
}

export interface StrategyYaml {
  profile?: {
    style?: string;
    selected_style_pack?: string | null;
    custom_style_enabled?: boolean;
    risk_preference?: string;
    investment_horizon?: string;
    markets?: string[];
    user_mode?: string;
    investor_segment?: string;
    decision_cadence?: string;
    preferred_assets?: string[];
  };
  allocation?: Record<string, unknown>;
  position_roles?: Record<string, unknown>;
  buy_rules?: unknown[];
  sell_rules?: unknown[];
  rebalance_rules?: unknown[];
  risk_rules?: unknown[];
  do_not_do_rules?: string[];
  decision_boundaries?: Record<string, unknown>;
  notes?: string;
  last_confirmed_at?: string | null;
}

export interface WatchYaml {
  mode?: string;
  only_push_on_exception?: boolean;
  priority_policy?: string;
  purpose_boundary?: string;
  check_interval_minutes?: number;
  custom_frequency?: number | null;
  default_check_windows?: unknown[];
  exception_rules?: unknown[];
  non_exception_rules?: unknown[];
  deduplication?: Record<string, unknown>;
  priority_mapping?: Record<string, unknown>;
  custom_rules?: unknown[];
  legacy_alerts?: unknown[];
  alert_rules?: unknown[];
  confirmed_watch_rule_summary?: string[];
  required_output_fields?: string[];
  last_confirmed_at?: string | null;
}

export type SchedulesYaml = Record<string, unknown>;
export type NotificationYaml = Record<string, unknown>;

export type RiskLevel = "P0" | "P1" | "P2";

export interface RiskLevelDef {
  meaning?: string;
  interrupt_allowed?: boolean;
  severity_alias?: "high" | "medium" | "low";
}

export interface SignalPriorityConfig {
  default?: RiskLevel;
  overrides?: Record<string, RiskLevel>;
  price_escalation_threshold_percent?: number;
}

export interface RiskTaxonomyYaml {
  risk_levels?: Record<RiskLevel, RiskLevelDef>;
  risk_categories?: Record<string, string[]>;
  classification_required_fields?: string[];
  signal_priority?: SignalPriorityConfig;
}

/**
 * 日级预案/复盘产物。WP4.7 切换:SQLite daily_plans 表 → workspace yaml。
 * 每个 date 一份,语义是"状态"(非事件流),upsert by plan_date。
 */
export interface DailyPlanYaml {
  plan_date: string;
  generated_at: string;
  summary?: string;
  content: string;
  /** 结构化元数据(原 SQLite data 列的 JSON 反序列化结果)。 */
  data?: unknown;
}

/**
 * 交易策略实体(第一版纯文字形态)。
 *
 * 与 strategy.yaml 平级,但语义不同:
 *   - strategy.yaml 装整体投资风格 / 风险约束 / "不做什么"
 *   - trading_strategies.yaml 装可执行策略 / "在什么条件下做什么"
 *
 * 第一版只承载文字字段;第二版若引入结构化副本,扩展 body_structured,不影响本接口。
 */
export interface TradingStrategy {
  key: string;
  name: string;
  applicability?: string;
  body: string;
  enabled?: boolean;
  created_at?: string;
  updated_at?: string;
}

export type InvestmentModelStatus = "active" | "draft" | "experimental" | "deprecated";

export interface InvestmentModelRuleSet {
  rules?: string[];
  validation_questions?: string[];
  notes?: string;
}

/**
 * 投资模型实体(第一版组合容器)。
 *
 * 投资模型是用户投资体系的主对象,承接从选股到交易、复盘、退出的完整闭环。
 * 交易策略是模型内部的执行模块,通过 trading_strategy_refs 引用。
 */
export interface InvestmentModel {
  key: string;
  name: string;
  status?: InvestmentModelStatus;
  orientation?: {
    primary_basis?: string;
    selection_basis?: string;
    entry_basis?: string;
    add_position_basis?: string;
    exit_basis?: string;
    [key: string]: unknown;
  };
  methodology_refs?: string[];
  trading_strategy_refs?: string[];
  selection?: InvestmentModelRuleSet;
  entry?: InvestmentModelRuleSet;
  add_position?: InvestmentModelRuleSet;
  exit?: InvestmentModelRuleSet;
  risk?: InvestmentModelRuleSet;
  review?: InvestmentModelRuleSet;
  created_at?: string;
  updated_at?: string;
}

export interface InvestmentModelsYaml {
  default_model_key?: string;
  models?: InvestmentModel[];
}

export type OnboardingStepKey =
  | "welcome"
  | "portfolio"
  | "style"
  | "review_schedule"
  | "market_watch_schedule"
  | "notification"
  | "watch_rules";

export interface OnboardingStepState {
  done?: boolean;
  completed_at?: string | null;
}

export interface OnboardingStateYaml {
  version?: number;
  status?: "not_started" | "in_progress" | "completed";
  current_step?: OnboardingStepKey | "completed" | null;
  steps?: Partial<Record<OnboardingStepKey, OnboardingStepState>>;
  completed_at?: string | null;
  updated_at?: string | null;
  notes?: string;
  /** Internal idempotency marker for an asynchronous onboarding draft commit. */
  draft_commit_key?: string;
}

// ============ 内部工具 ============

async function readYaml<T>(filePath: string): Promise<T | null> {
  if (!existsSync(filePath)) return null;
  try {
    const raw = await readFile(filePath, "utf-8");
    return (parse(raw) ?? null) as T | null;
  } catch (error) {
    logger.warn(`workspace.readYaml failed path=${filePath}: ${(error as Error).message}`);
    return null;
  }
}

async function writeYaml(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, stringify(data), "utf-8");
}

async function appendJsonl(filePath: string, record: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(record) + "\n", "utf-8");
}

async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join("\n");
  const content = records.length > 0 ? body + "\n" : "";
  await writeFile(filePath, content, "utf-8");
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  if (!existsSync(filePath)) return [];
  try {
    const raw = await readFile(filePath, "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    logger.warn(`workspace.readJsonl failed path=${filePath}: ${(error as Error).message}`);
    return [];
  }
}

// ============ 公开 API ============

export class WorkspaceStore {
  constructor(private readonly userId: string) {}

  private get root(): string {
    return resolveWorkspacePath(this.userId);
  }

  private get exists(): boolean {
    return existsSync(path.join(this.root, "AGENTS.md"));
  }

  ensureReady(): void {
    if (!this.exists) {
      throw new Error(`WORKSPACE_NOT_INITIALIZED:${this.userId}(请先调用 ensureWorkspace)`);
    }
  }

  // ----- portfolio.yaml -----

  async readPortfolio(): Promise<PortfolioYaml | null> {
    this.ensureReady();
    return readYaml<PortfolioYaml>(path.join(this.root, "config/portfolio.yaml"));
  }

  async writePortfolio(data: PortfolioYaml): Promise<void> {
    this.ensureReady();
    await writeYaml(path.join(this.root, "config/portfolio.yaml"), data);
  }

  async listHoldings(): Promise<PortfolioHolding[]> {
    const portfolio = await this.readPortfolio();
    return portfolio?.holdings ?? [];
  }

  async listActiveHoldings(): Promise<PortfolioHolding[]> {
    const holdings = await this.listHoldings();
    return holdings.filter((h) => !h.sell_date && h.status !== "closed");
  }

  async listWatchlist(): Promise<PortfolioWatchItem[]> {
    const portfolio = await this.readPortfolio();
    return portfolio?.watchlist ?? [];
  }

  async listStockPlans(): Promise<StockPlan[]> {
    const portfolio = await this.readPortfolio();
    return portfolio?.stock_plans ?? [];
  }

  /**
   * 添加持仓。若 code 已存在(任意状态)则更新;否则追加。
   * 返回最终落盘的 holdings 数组。
   */
  async upsertHolding(holding: PortfolioHolding): Promise<PortfolioHolding[]> {
    const portfolio = (await this.readPortfolio()) ?? { holdings: [], watchlist: [], stock_plans: [] };
    portfolio.holdings = portfolio.holdings ?? [];
    const idx = portfolio.holdings.findIndex((h) => h.code === holding.code);
    if (idx >= 0) {
      portfolio.holdings[idx] = { ...portfolio.holdings[idx], ...holding };
    } else {
      portfolio.holdings.push(holding);
    }
    await this.writePortfolio(portfolio);
    return portfolio.holdings;
  }

  async removeHolding(code: string, opts: { markClosed?: boolean } = {}): Promise<PortfolioHolding | null> {
    const portfolio = await this.readPortfolio();
    if (!portfolio?.holdings) return null;
    const idx = portfolio.holdings.findIndex((h) => h.code === code);
    if (idx < 0) return null;
    const removed = portfolio.holdings[idx];
    if (opts.markClosed) {
      portfolio.holdings[idx] = {
        ...removed,
        status: "closed",
        sell_date: new Date().toISOString().slice(0, 10),
      };
    } else {
      portfolio.holdings.splice(idx, 1);
    }
    await this.writePortfolio(portfolio);
    return removed;
  }

  async upsertWatchItem(item: PortfolioWatchItem): Promise<PortfolioWatchItem[]> {
    const portfolio = (await this.readPortfolio()) ?? { holdings: [], watchlist: [], stock_plans: [] };
    portfolio.watchlist = portfolio.watchlist ?? [];
    const idx = portfolio.watchlist.findIndex((w) => w.code === item.code);
    if (idx >= 0) {
      portfolio.watchlist[idx] = { ...portfolio.watchlist[idx], ...item };
    } else {
      portfolio.watchlist.push(item);
    }
    await this.writePortfolio(portfolio);
    return portfolio.watchlist;
  }

  async removeWatchItem(code: string): Promise<PortfolioWatchItem | null> {
    const portfolio = await this.readPortfolio();
    if (!portfolio?.watchlist) return null;
    const idx = portfolio.watchlist.findIndex((w) => w.code === code);
    if (idx < 0) return null;
    const [removed] = portfolio.watchlist.splice(idx, 1);
    await this.writePortfolio(portfolio);
    return removed;
  }

  async upsertStockPlan(plan: StockPlan): Promise<StockPlan[]> {
    const portfolio = (await this.readPortfolio()) ?? { holdings: [], watchlist: [], stock_plans: [] };
    portfolio.stock_plans = portfolio.stock_plans ?? [];
    const idx = portfolio.stock_plans.findIndex((p) => p.code === plan.code);
    const stamped = { ...plan, updated_at: plan.updated_at ?? new Date().toISOString() };
    if (idx >= 0) {
      portfolio.stock_plans[idx] = { ...portfolio.stock_plans[idx], ...stamped };
    } else {
      portfolio.stock_plans.push(stamped);
    }
    await this.writePortfolio(portfolio);
    return portfolio.stock_plans;
  }

  async removeStockPlan(code: string): Promise<StockPlan | null> {
    const portfolio = await this.readPortfolio();
    if (!portfolio?.stock_plans) return null;
    const idx = portfolio.stock_plans.findIndex((p) => p.code === code);
    if (idx < 0) return null;
    const [removed] = portfolio.stock_plans.splice(idx, 1);
    await this.writePortfolio(portfolio);
    return removed;
  }

  // ----- strategy.yaml -----

  async readStrategy(): Promise<StrategyYaml | null> {
    this.ensureReady();
    return readYaml<StrategyYaml>(path.join(this.root, "config/strategy.yaml"));
  }

  async writeStrategy(data: StrategyYaml): Promise<void> {
    this.ensureReady();
    await writeYaml(path.join(this.root, "config/strategy.yaml"), data);
  }

  // ----- watch.yaml -----

  async readWatch(): Promise<WatchYaml | null> {
    this.ensureReady();
    return readYaml<WatchYaml>(path.join(this.root, "config/watch.yaml"));
  }

  async writeWatch(data: WatchYaml): Promise<void> {
    this.ensureReady();
    await writeYaml(path.join(this.root, "config/watch.yaml"), data);
  }

  // ----- schedules.yaml -----

  async readSchedules(): Promise<SchedulesYaml | null> {
    this.ensureReady();
    return readYaml<SchedulesYaml>(path.join(this.root, "config/schedules.yaml"));
  }

  async writeSchedules(data: SchedulesYaml): Promise<void> {
    this.ensureReady();
    await writeYaml(path.join(this.root, "config/schedules.yaml"), data);
  }

  // ----- notification.yaml -----

  async readNotification(): Promise<NotificationYaml | null> {
    this.ensureReady();
    return readYaml<NotificationYaml>(path.join(this.root, "config/notification.yaml"));
  }

  async writeNotification(data: NotificationYaml): Promise<void> {
    this.ensureReady();
    await writeYaml(path.join(this.root, "config/notification.yaml"), data);
  }

  // ----- onboarding_state.yaml -----

  async readOnboardingState(): Promise<OnboardingStateYaml> {
    this.ensureReady();
    const data = await readYaml<OnboardingStateYaml>(path.join(this.root, "config/onboarding_state.yaml"));
    return data ?? {
      version: 1,
      status: "not_started",
      current_step: "welcome",
      steps: {},
      completed_at: null,
      updated_at: null,
      notes: "",
    };
  }

  async writeOnboardingState(data: OnboardingStateYaml): Promise<void> {
    this.ensureReady();
    await writeYaml(path.join(this.root, "config/onboarding_state.yaml"), data);
  }

  // ----- risk_taxonomy.yaml -----

  async readRiskTaxonomy(): Promise<RiskTaxonomyYaml | null> {
    this.ensureReady();
    return readYaml<RiskTaxonomyYaml>(path.join(this.root, "config/risk_taxonomy.yaml"));
  }

  // ----- trading_strategies.yaml (交易策略实体,第一版) -----

  /**
   * 读全部启用的交易策略。yaml 不存在 / 为空 → 返回 []。
   * 返回时按 enabled 过滤?否:第一版返回全部,让调用方决定如何过滤。
   */
  async readTradingStrategies(): Promise<TradingStrategy[]> {
    this.ensureReady();
    const data = await readYaml<TradingStrategy[]>(path.join(this.root, "config/trading_strategies.yaml"));
    return data ?? [];
  }

  /**
   * 新增或更新策略(按 key upsert)。
   * 不传 created_at/updated_at 时自动填今天。
   * 返回写入后的完整列表,便于调用方刷新缓存或回显。
   */
  async writeTradingStrategy(strategy: TradingStrategy): Promise<TradingStrategy[]> {
    this.ensureReady();
    const list = await this.readTradingStrategies();
    const today = new Date().toISOString().slice(0, 10);
    const idx = list.findIndex((s) => s.key === strategy.key);
    const stamped: TradingStrategy = {
      ...strategy,
      enabled: strategy.enabled ?? true,
      created_at: strategy.created_at ?? (idx >= 0 ? list[idx].created_at : today),
      updated_at: today,
    };
    if (idx >= 0) {
      list[idx] = stamped;
    } else {
      list.push(stamped);
    }
    await writeYaml(path.join(this.root, "config/trading_strategies.yaml"), list);
    return list;
  }

  /**
   * 按 key 删除策略。返回 true=已删除,false=key 不存在。
   * 不级联清理 stock_plans.strategy_key(孤儿引用由读取与审计层标记)。
   */
  async removeTradingStrategy(key: string): Promise<boolean> {
    this.ensureReady();
    const list = await this.readTradingStrategies();
    const idx = list.findIndex((s) => s.key === key);
    if (idx < 0) return false;
    list.splice(idx, 1);
    await writeYaml(path.join(this.root, "config/trading_strategies.yaml"), list);
    return true;
  }

  // ----- investment_models.yaml (投资模型:选股 → 交易 → 复盘 → 退出闭环) -----

  async readInvestmentModelsConfig(): Promise<InvestmentModelsYaml> {
    this.ensureReady();
    const data = await readYaml<InvestmentModelsYaml>(path.join(this.root, "config/investment_models.yaml"));
    return data ?? { default_model_key: "user-default", models: [] };
  }

  async readInvestmentModels(): Promise<InvestmentModel[]> {
    const data = await this.readInvestmentModelsConfig();
    return data.models ?? [];
  }

  async writeInvestmentModel(model: InvestmentModel): Promise<InvestmentModelsYaml> {
    this.ensureReady();
    const data = await this.readInvestmentModelsConfig();
    const list = data.models ?? [];
    const today = new Date().toISOString().slice(0, 10);
    const idx = list.findIndex((m) => m.key === model.key);
    const stamped: InvestmentModel = {
      ...model,
      status: model.status ?? list[idx]?.status ?? "active",
      created_at: model.created_at ?? (idx >= 0 ? list[idx].created_at : today),
      updated_at: today,
    };
    if (idx >= 0) {
      list[idx] = stamped;
    } else {
      list.push(stamped);
    }
    const next: InvestmentModelsYaml = {
      ...data,
      models: list,
    };
    next.default_model_key = list.some((m) => m.key === data.default_model_key)
      ? data.default_model_key
      : stamped.key;
    await writeYaml(path.join(this.root, "config/investment_models.yaml"), next);
    return next;
  }

  async removeInvestmentModel(key: string): Promise<boolean> {
    this.ensureReady();
    const data = await this.readInvestmentModelsConfig();
    const list = data.models ?? [];
    const idx = list.findIndex((m) => m.key === key);
    if (idx < 0) return false;
    list.splice(idx, 1);
    const nextDefault = list.some((m) => m.key === data.default_model_key)
      ? data.default_model_key
      : list[0]?.key;
    await writeYaml(path.join(this.root, "config/investment_models.yaml"), {
      ...data,
      default_model_key: nextDefault,
      models: list,
    });
    return true;
  }

  // ----- plans/daily/<date>.yaml (WP4.7) -----

  async readDailyPlan(planDate: string): Promise<DailyPlanYaml | null> {
    this.ensureReady();
    return readYaml<DailyPlanYaml>(path.join(this.root, "plans/daily", `${planDate}.yaml`));
  }

  async writeDailyPlan(plan: DailyPlanYaml): Promise<void> {
    this.ensureReady();
    await writeYaml(path.join(this.root, "plans/daily", `${plan.plan_date}.yaml`), plan);
  }

  /**
   * 列出 plans/daily 下所有日级预案,按 plan_date 倒序。
   * dateRange 可选,提供则只返回 [start,end] 闭区间内的。
   */
  async listDailyPlans(options: { startDate?: string; endDate?: string; limit?: number } = {}): Promise<DailyPlanYaml[]> {
    this.ensureReady();
    const dir = path.join(this.root, "plans/daily");
    if (!existsSync(dir)) return [];
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch (error) {
      logger.warn(`workspace.listDailyPlans failed dir=${dir}: ${(error as Error).message}`);
      return [];
    }
    const dates = entries
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.yaml$/.test(f))
      .map((f) => f.slice(0, -5))
      .filter((d) => {
        if (options.startDate && d < options.startDate) return false;
        if (options.endDate && d > options.endDate) return false;
        return true;
      })
      .sort((a, b) => b.localeCompare(a));

    const limited = options.limit ? dates.slice(0, options.limit) : dates;
    const out: DailyPlanYaml[] = [];
    for (const d of limited) {
      const plan = await this.readDailyPlan(d);
      if (plan) out.push(plan);
    }
    return out;
  }

  // ----- knowledge/methods/*.md -----

  async readMethodology(): Promise<{
    fundamental: string;
    technical: string;
    macro: string;
    risk: string;
  }> {
    this.ensureReady();
    const empty = { fundamental: "", technical: "", macro: "", risk: "" };
    const keys = ["fundamental", "technical", "macro", "risk"] as const;
    const out = { ...empty };
    for (const key of keys) {
      const fp = path.join(this.root, `knowledge/methods/${key}.md`);
      if (existsSync(fp)) {
        try {
          out[key] = await readFile(fp, "utf-8");
        } catch (error) {
          logger.warn(`workspace.readMethodology key=${key} failed: ${(error as Error).message}`);
        }
      }
    }
    return out;
  }

  /**
   * 覆盖写入 knowledge/methods/*.md。空字符串跳过该文件,保留原内容。
   */
  async writeMethodology(methods: {
    fundamental?: string;
    technical?: string;
    macro?: string;
    risk?: string;
  }): Promise<void> {
    this.ensureReady();
    const keys = ["fundamental", "technical", "macro", "risk"] as const;
    for (const key of keys) {
      const content = methods[key];
      if (!content) continue;
      const fp = path.join(this.root, `knowledge/methods/${key}.md`);
      await mkdir(path.dirname(fp), { recursive: true });
      await writeFile(fp, content, "utf-8");
    }
  }

  // ----- memory/*.jsonl -----

  async appendDecision(record: unknown): Promise<void> {
    this.ensureReady();
    await appendJsonl(path.join(this.root, "memory/decisions.jsonl"), record);
  }

  async writeDecisions(records: unknown[]): Promise<void> {
    this.ensureReady();
    await writeJsonl(path.join(this.root, "memory/decisions.jsonl"), records);
  }

  async listDecisions<T = unknown>(): Promise<T[]> {
    this.ensureReady();
    return readJsonl<T>(path.join(this.root, "memory/decisions.jsonl"));
  }

  async appendBehaviorEvent(record: unknown): Promise<void> {
    this.ensureReady();
    await appendJsonl(path.join(this.root, "memory/behavior_events.jsonl"), record);
  }

  async listBehaviorEvents<T = unknown>(): Promise<T[]> {
    this.ensureReady();
    return readJsonl<T>(path.join(this.root, "memory/behavior_events.jsonl"));
  }

  async appendSourceEvent(record: unknown): Promise<void> {
    this.ensureReady();
    await appendJsonl(path.join(this.root, "memory/source_events.jsonl"), record);
  }

  async listSourceEvents<T = unknown>(): Promise<T[]> {
    this.ensureReady();
    return readJsonl<T>(path.join(this.root, "memory/source_events.jsonl"));
  }

  async appendMethodChange(record: unknown): Promise<void> {
    this.ensureReady();
    await appendJsonl(path.join(this.root, "memory/method_changes.jsonl"), record);
  }

  /**
   * 列出所有方法变更候选(去重版本,按 updated_at desc)。
   * jsonl 是 append-only,每条记录是候选的一个版本快照(candidateId + updatedAt 唯一)。
   * 调用方读到的应是"每个候选的最新版本",旧版本仅在审计追溯时按 candidateId 全量查。
   *
   * 关键顺序:先按 candidateId 去重(取最新版本),再对去重后的最新版本应用 status 过滤。
   * 如果先过滤再去重,旧版本(如已被 confirmed 取代的 proposed 版本)会被错误返回。
   */
  async listMethodChanges<T = unknown>(options: { status?: string; limit?: number } = {}): Promise<T[]> {
    this.ensureReady();
    const all = await readJsonl<T>(path.join(this.root, "memory/method_changes.jsonl"));
    const byCandidate = new Map<string, T>();
    const tsOf = (rec: unknown): string => {
      const r = rec as Record<string, unknown>;
      return typeof r?.updated_at === "string" ? r.updated_at : typeof r?.createdAt === "string" ? r.createdAt : "";
    };
    const idOf = (rec: unknown): string => {
      const r = rec as Record<string, unknown>;
      return String(r?.candidateId ?? r?.candidate_id ?? r?.id ?? "");
    };
    for (const rec of all) {
      const id = idOf(rec);
      if (!id) continue;
      const prev = byCandidate.get(id);
      if (!prev || tsOf(rec) >= tsOf(prev)) {
        byCandidate.set(id, rec);
      }
    }
    let list = [...byCandidate.values()];
    if (options.status) {
      list = list.filter((rec) => {
        const r = rec as Record<string, unknown>;
        return r?.status === options.status;
      });
    }
    list.sort((a, b) => {
      const ta = tsOf(a);
      const tb = tsOf(b);
      return tb.localeCompare(ta);
    });
    return options.limit ? list.slice(0, options.limit) : list;
  }

  /**
   * 取单个候选的所有版本(按 updated_at asc),供审计追溯使用。
   */
  async listMethodChangeVersions<T = unknown>(candidateId: string): Promise<T[]> {
    this.ensureReady();
    const all = await readJsonl<T>(path.join(this.root, "memory/method_changes.jsonl"));
    return all.filter((rec) => {
      const r = rec as Record<string, unknown>;
      return String(r?.candidateId ?? r?.candidate_id ?? r?.id ?? "") === candidateId;
    });
  }

  // ----- memory/review_viewpoints.jsonl (WP4.8) -----

  /**
   * 读取 review_viewpoints 全量(read-modify-write 模式,非 append-only)。
   * 业务复合 key = viewpoint_key(`${sourceDate}#${viewpointId}`),由调用方维护唯一性。
   */
  async readReviewViewpoints<T = unknown>(): Promise<T[]> {
    this.ensureReady();
    return readJsonl<T>(path.join(this.root, "memory/review_viewpoints.jsonl"));
  }

  /**
   * 全量覆盖写入 review_viewpoints。调用方负责 read-modify-write 语义(读、改、写)。
   */
  async writeReviewViewpoints(records: unknown[]): Promise<void> {
    this.ensureReady();
    await writeJsonl(path.join(this.root, "memory/review_viewpoints.jsonl"), records);
  }

  async appendAuditEvent(record: unknown): Promise<void> {
    this.ensureReady();
    await appendJsonl(path.join(this.root, "memory/audit_events.jsonl"), record);
  }

  async appendChangeLog(record: unknown): Promise<void> {
    this.ensureReady();
    await appendJsonl(path.join(this.root, "memory/change_log.jsonl"), record);
  }

  // ----- 路径(供 trace/sandbox 审计使用) -----

  path(): string {
    return this.root;
  }
}

export function getWorkspaceStore(userId: string): WorkspaceStore {
  return new WorkspaceStore(userId);
}
