/**
 * 引导状态检测。
 *
 * 仅读取 workspace yaml(权威源),不查 SQLite 业务表(已迁移到 yaml)。
 * 不做语义判断,只输出"缺失项标签",由调用方决定怎么呈现。
 */

import { getWorkspaceStore } from "./workspace-store.js";

export interface OnboardingState {
  holdingsCount: number;
  watchlistCount: number;
  stylePack: string | null;
  /** 人类可读的缺失项标签,如 ["持仓", "风格包"]。空数组表示完整。 */
  missing: string[];
}

export async function getOnboardingState(userId: string): Promise<OnboardingState> {
  const store = getWorkspaceStore(userId);
  const portfolio = await store.readPortfolio();
  const strategy = await store.readStrategy();

  const holdingsCount = portfolio?.holdings?.filter((h) => !h.sell_date && h.status !== "closed").length ?? 0;
  const watchlistCount = portfolio?.watchlist?.length ?? 0;
  const stylePack = strategy?.profile?.selected_style_pack ?? null;

  const missing: string[] = [];
  if (holdingsCount === 0) missing.push("持仓");
  if (watchlistCount === 0) missing.push("自选");
  if (!stylePack) missing.push("风格包");

  return { holdingsCount, watchlistCount, stylePack, missing };
}
