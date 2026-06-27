/**
 * L3 复合指标告知协议校验
 *
 * 设计原则(详见 docs/composite-indicator-system.md §10):
 *   - experimental / 数据源缺失 / 经验系数 / 建仓决策依据 → 必须签告知协议
 *   - 校验在"加载阶段"完成,失败则主链路拒绝执行该指标
 *   - 校验函数对 L3a 和 L3b 通用,通过 AcknowledgeableConfig 接口适配
 *
 * 注意:本模块只是"门禁"——读取已有字段判断是否通过。
 * 告知流程本身(贴 data_source_notes 给用户、收集肯定词)由 Hermes agent 在
 * `.codex/skills/invest-agent-indicator-creation/SKILL.md` 流程里完成。
 */

const ACKNOWLEDGED_VIA_WHITELIST = new Set([
  "weixin-mobile",
  "dashboard",
  "api",
]);

/**
 * 任何 L3 指标(L3a 或 L3b)的告知协议可校验视图。
 *
 * L3a:CompositeIndicatorConfig 直接满足
 * L3b:定义脚本里的 `definition` 通过类型断言后满足
 */
export interface AcknowledgeableConfig {
  key: string;
  name?: string;
  reliability: "stable" | "experimental";
  /** L3a 用 inputs,L3b 用 dataRequirements;此处统一为信息性字段 */
  data_source_notes?: string[];
  user_acknowledged: boolean;
  acknowledged_at?: string;
  acknowledged_via?: string;
}

export interface AcknowledgementVerdict {
  passed: boolean;
  reasons: string[];
  /** 是否需要告知协议(用于外层 UI 高亮) */
  requiresAcknowledgement: boolean;
}

/**
 * 判断一个 L3 指标是否"需要"告知协议(而非是否"已通过")。
 *
 * 触发条件(满足任一即需要):
 *   - reliability: experimental
 *   - data_source_notes 非空(声明了经验数据源/缺失项)
 */
export function requiresAcknowledgement(config: AcknowledgeableConfig): boolean {
  if (config.reliability === "experimental") return true;
  if (config.data_source_notes && config.data_source_notes.length > 0) return true;
  return false;
}

/**
 * 校验告知协议。
 *
 * passed = !requiresAcknowledgement || (user_acknowledged && acknowledged_via 在白名单 && acknowledged_at 合法)
 *
 * 注意:passed=true 仅代表"系统加载层放行",不代表"主链路无保留地采用"。
 * 主链路使用 L3 结果时仍应附加 reliability 标记。
 */
export function validateAcknowledgement(
  config: AcknowledgeableConfig,
): AcknowledgementVerdict {
  const reasons: string[] = [];
  const needed = requiresAcknowledgement(config);

  if (!needed) {
    return { passed: true, reasons: [], requiresAcknowledgement: false };
  }

  if (!config.user_acknowledged) {
    reasons.push(
      "reliability=experimental 或 data_source_notes 非空,但 user_acknowledged=false",
    );
  }

  if (config.acknowledged_via && !ACKNOWLEDGED_VIA_WHITELIST.has(config.acknowledged_via)) {
    reasons.push(
      `acknowledged_via='${config.acknowledged_via}' 不在白名单 (${[...ACKNOWLEDGED_VIA_WHITELIST].join(" | ")})`,
    );
  }

  if (config.user_acknowledged && !config.acknowledged_via) {
    reasons.push("user_acknowledged=true 但缺 acknowledged_via");
  }

  if (config.user_acknowledged && !config.acknowledged_at) {
    reasons.push("user_acknowledged=true 但缺 acknowledged_at");
  }

  if (config.acknowledged_at && !isValidIsoTimestamp(config.acknowledged_at)) {
    reasons.push(`acknowledged_at='${config.acknowledged_at}' 不是合法 ISO 时间(YYYY-MM-DD 或 YYYY-MM-DDTHH:mm:ssZ)`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    requiresAcknowledgement: true,
  };
}

function isValidIsoTimestamp(s: string): boolean {
  // 接受 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm:ss(Z 或 +08:00)
  const looseDate = /^\d{4}-\d{2}-\d{2}$/;
  const isoFull = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;
  if (!looseDate.test(s) && !isoFull.test(s)) return false;
  const t = new Date(s);
  return !Number.isNaN(t.getTime());
}

/**
 * 生成 data_source_notes 模板,供 Hermes agent 创建指标时使用。
 *
 * Hermes agent 在 SKILL.md 流程里调用这个 helper 拿到模板,填好后贴给用户确认。
 */
export function buildDataSourceNotesTemplate(
  missing: string[],
  approximations: string[],
): string[] {
  const notes: string[] = [];
  for (const m of missing) {
    notes.push(`[缺失数据源] ${m}`);
  }
  for (const a of approximations) {
    notes.push(`[近似模型] ${a}`);
  }
  return notes;
}
