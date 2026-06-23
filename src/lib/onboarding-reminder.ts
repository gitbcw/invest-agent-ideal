/**
 * 引导缺失项的提醒生成器。
 *
 * 检测部分(在 onboarding-state.ts)是确定性的;表达部分(本模块)也是确定性的。
 * 之前走过 DeepSeek flash,但 missing 列表已经是确定性事实,再让 LLM 翻译反而不可控。
 * 改成模板拼装:100% 命中要表达的"缺什么 + 邀请补齐",零延迟零抽风。
 *
 * 如果未来要根据用户角色/历史调整语气,再考虑引入 LLM。
 */

import type { OnboardingState } from "./onboarding-state.js";

export function buildOnboardingReminder(state: OnboardingState): string {
  if (state.missing.length === 0) return "";

  const facts: string[] = [];
  if (state.missing.includes("持仓")) facts.push("还没有录入持仓");
  if (state.missing.includes("自选")) facts.push("自选股列表是空的");
  if (state.missing.includes("风格包")) facts.push("投资风格也还没选定");

  const factLine = `目前${facts.join("、")}。`;
  const inviteLine = "可以的话,先把持仓和自选补一下——这两项齐了我才能盯盘、提醒和复盘。";

  return `${factLine}${inviteLine}`;
}
