/**
 * 初始化向导的投资者档案落地（2026-10-08 重设计；2026-10-09 owner 裁决修订）：
 * 风格选择 → 主策略落地（kind=strategy，首个自动成为主策略）。
 * 自述文本（customText）优先于预设风格：直接作为主策略正文（用户自己写的
 * 打法就是他的主策略）。
 * 投资框架不再预置分析方法四件套——分析方法（基本面/技术面/宏观/风控）
 * 属于技能域（系统预置、按需触发注入），框架只承载用户个性化的常驻纪律
 * （从对话中沉淀），初始为空。此前四件套与技能双份常驻是播种设计错误。
 * 幂等：按名称查重跳过，重跑不重复写入。
 */
import { Buffer } from "node:buffer";
import { sqlite } from "../db/index.js";
import { createMethod, addMethodVersion, approveMethodVersion } from "./agent-space/methods.js";
import { bindMethod } from "./agent-space/agents.js";
import { commitWorkspaceContent, registerPortalActionAuthorization } from "./agent-space/portal-actions.js";

export type OnboardingStyle = "trend" | "value" | "balanced";

export const ONBOARDING_STYLE_STRATEGIES: Record<OnboardingStyle, { name: string; text: string }> = {
  trend: {
    name: "趋势跟踪策略（起点）",
    text: [
      "# 趋势跟踪（初始化起点，可随时修改）",
      "",
      "## 适用范围",
      "有明确中期趋势的标的；震荡市不适用。",
      "",
      "## 执行规则",
      "1. 以 20/60 日均线判断趋势方向，价格站上均线且均线向上才可持有。",
      "2. 回踩 20 日均线不破且缩量，可加仓一步；跌破 60 日均线减半，收盘确认。",
      "3. 跌破趋势线或前低，全部离场，不抄底不摊薄。",
      "4. 每次操作以收盘价确认，盘中波动不触发。",
      "",
      "## 风控纪律",
      "1. 单标的最大仓位固定，加仓后不超过上限。",
      "2. 连续两次止损后暂停该标的开新仓，复盘后再评估。",
      "3. 亏损达到预设幅度无条件降仓，不与趋势判断冲突。",
    ].join("\n"),
  },
  value: {
    name: "价值回归策略（起点）",
    text: [
      "# 价值回归（初始化起点，可随时修改）",
      "",
      "## 适用范围",
      "有稳定盈利和估值锚的标的；强周期顶底慎用。",
      "",
      "## 执行规则",
      "1. 以估值分位和盈利质量确定估值中枢，低估区分批建仓。",
      "2. 回归合理估值分位分批卖出，不追求卖在最高。",
      "3. 基本面恶化（盈利逻辑破坏、治理风险）无论盈亏立即离场。",
      "",
      "## 风控纪律",
      "1. 越跌越买有次数与仓位上限，不无限摊薄。",
      "2. 单标的亏损达到上限停止补仓，只评估是否离场。",
      "3. 持有逻辑记录在案，逻辑消失即卖出理由成立。",
    ].join("\n"),
  },
  balanced: {
    name: "均衡策略（起点）",
    text: [
      "# 均衡：趋势确认 + 估值过滤（初始化起点，可随时修改）",
      "",
      "## 适用范围",
      "大多数标的与市场环境；两个信号冲突时保持观望。",
      "",
      "## 执行规则",
      "1. 趋势确认：价格站上 60 日均线且均线向上，才允许买入。",
      "2. 估值过滤：只在估值分位不高于历史中位时建仓，高估区不加仓。",
      "3. 卖出二选一触发即执行：跌破 20 日均线（趋势破坏）或估值回到高分位（目标达成）。",
      "",
      "## 风控纪律",
      "1. 单标的仓位上限固定；两个信号冲突时只减不加。",
      "2. 亏损达到预设幅度无条件降仓。",
    ].join("\n"),
  },
};

function space_approve(scope: { userId: string; projectId: string; instanceId: string }, methodId: string, versionId: string, actor: string): void {
  const approvalRef = registerPortalActionAuthorization({
    scope, operation: "method.version.approve", objectType: "agent_space_method_version", objectId: versionId, versionId,
    extraBinding: { methodId, adopt: "true" }, sourceRef: `onboarding:${versionId}`, actor,
  });
  approveMethodVersion({ scope, methodId, versionId, approvedBy: actor, approvalRef, adopt: true, actor });
}

export interface BootstrapInvestorProfileInput {
  scope: { userId: string; projectId: string; instanceId: string };
  style?: OnboardingStyle | "skip";
  customText?: string;
  actor?: string;
}

export interface BootstrapInvestorProfileResult {
  /** 2026-10-09 起恒为 0：框架不再预置（分析方法归属技能域），保留字段兼容旧调用方。 */
  frameworksSeeded: number;
  strategy: { methodId: string; name: string; becamePrimary: boolean } | null;
}

export async function bootstrapInvestorProfile(input: BootstrapInvestorProfileInput): Promise<BootstrapInvestorProfileResult> {
  const actor = input.actor ?? "onboarding";
  let strategy: BootstrapInvestorProfileResult["strategy"] = null;
  const hasStrategy = sqlite.prepare(
    "SELECT 1 AS one FROM agent_space_methods WHERE user_id=? AND project_id=? AND instance_id=? AND kind='strategy' AND status='active' AND current_version_id IS NOT NULL",
  ).get(input.scope.userId, input.scope.projectId, input.scope.instanceId);
  const custom = input.customText?.trim();
  if (!hasStrategy && (custom || (input.style && input.style !== "skip"))) {
    const preset = input.style && input.style !== "skip" ? ONBOARDING_STYLE_STRATEGIES[input.style] : null;
    const name = custom ? "我的投资策略（初始化自述）" : preset!.name;
    const text = custom ?? preset!.text;
    const content = await commitWorkspaceContent({
      scope: input.scope, fileName: `strategy-onboarding-${Date.now()}.md`, bytes: Buffer.from(text, "utf8"),
      idempotencyKey: `onboarding:strategy:${input.scope.userId}:${Date.now()}`, source: "method_content",
    });
    const method = createMethod({ scope: input.scope, name, kind: "strategy", actor, idempotencyKey: `onboarding:strategy:${input.scope.userId}:method` });
    const version = await addMethodVersion({
      scope: input.scope, methodId: method.method_id,
      contentRef: { assetId: content.assetId, assetVersionId: content.assetVersionId, contentChecksum: content.contentChecksum },
      origin: "user", actor, idempotencyKey: `onboarding:strategy:${input.scope.userId}:version`,
    });
    space_approve(input.scope, method.method_id, version.version_id, actor);
    let becamePrimary = false;
    const soleAgent = sqlite.prepare(
      "SELECT agent_id AS agentId FROM agent_space_agents WHERE user_id=? AND project_id=? AND instance_id=? AND status='active' LIMIT 2",
    ).all(input.scope.userId, input.scope.projectId, input.scope.instanceId) as Array<{ agentId: string }>;
    if (soleAgent.length === 1) {
      bindMethod({ scope: input.scope, agentId: soleAgent[0]!.agentId, methodId: method.method_id, versionPolicy: "current", actor });
      becamePrimary = true;
    }
    strategy = { methodId: method.method_id, name, becamePrimary };
  }
  return { frameworksSeeded: 0, strategy };
}
