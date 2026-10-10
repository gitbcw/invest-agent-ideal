/**
 * 确认草案登记入口的字段契约（T-506 P0，owner 2026-09-15 审查定案后排定）。
 *
 * 背景（9-13 mg 29 连拒 + 9-14 mgreplay 三模型复现）：confirmations.request 此前
 * 对 payload 只存不验，模型自造 schema（change_type/new_text/document 等文档编辑
 * 形状，缺 proposedChange/reason）后，确认链陷入双死路——执行只传 confirmationId
 * 时恢复出的草案本身缺字段（A 类「缺少 proposedChange 或 reason」）；重写全字段
 * 时与畸形草案永不匹配（B 类「confirmation payload mismatch」）。
 *
 * 本表以操作为单位声明 discriminated 字段契约，在登记入口（requestConfirmation）
 * 校验并返回可操作错误，让模型同轮改正后重新登记；安全边界不变——执行期比对、
 * 时序校验、显式确认文本判断仍由 sandbox-confirmation 与 prepareBoundConfirmation
 * 强制，本模块只负责「草案必须生而可执行」。
 *
 * 覆盖范围：六个此前无入口校验的确认写操作。portfolio.apply_changes、
 * onboarding.confirm_*、method_changes.apply、preferences.apply 的语义级校验
 * 已存在于 validateConfirmationDraft（含规划与预检），不在本表重复定义；
 * 契约外的未知字段一律拒绝（明示策略：让草案字段集确定，杜绝 schema 发明），
 * 执行侧的空值裁剪（pruneConfirmationPayload）与别名容错保持不变作为二道防线。
 */

export type ConfirmationFieldType = "string" | "number" | "boolean" | "array" | "object";

export interface ConfirmationFieldSpec {
  type: ConfirmationFieldType;
  required: boolean;
  /** 错误文案中的字段用途说明。 */
  label: string;
  /** 执行处理器接受的同义键（如 code/stockCode）。 */
  aliases?: readonly string[];
  /** string 要求去空白后非空；array 要求至少一项。 */
  nonEmpty?: boolean;
  /** string 的格式约束（与执行处理器同口径）。 */
  pattern?: { regex: RegExp; message: string };
}

const STOCK_CODE_PATTERN = { regex: /^\d{6}$/, message: "必须是 6 位数字代码（如 600519），不带 sh/sz 前缀" };
const STOCK_CODE_LABEL = "6 位股票代码（纯数字，无 sh/sz 前缀）";

export const CONFIRMATION_CONTRACTS: Readonly<Record<string, Readonly<Record<string, ConfirmationFieldSpec>>>> = {
  "method_changes.propose": {
    proposedChange: {
      type: "string", required: true, nonEmpty: true,
      label: "拟议变更的完整文本（一段自包含的自然语言描述，不要拆成 change_type/new_text 等结构化对象）",
    },
    reason: { type: "string", required: true, nonEmpty: true, label: "变更理由" },
    sourceReviewId: { type: "string", required: false, label: "来源复盘 id（可选）" },
    sourceType: { type: "string", required: false, label: "来源类型（可选，默认 review）" },
    affectedResource: { type: "string", required: false, label: "受影响的方法资源（可选，默认 methodology_profile）" },
  },
  "watchlist.add": {
    code: { type: "string", required: true, nonEmpty: true, pattern: STOCK_CODE_PATTERN, aliases: ["stockCode"], label: STOCK_CODE_LABEL },
    name: { type: "string", required: false, aliases: ["stockName"], label: "股票名称（可选，缺省用代码）" },
    reason: { type: "string", required: false, label: "加入理由（可选）" },
  },
  // 2026-10-09 fresh 回归：截图批量录入走单只 add 会产生 N 次登记/执行，撞
  // maxSteps 后整轮空响应。批量草案一次登记一次执行；条目级校验在
  // validateConfirmationDraft（normalizeWatchlistBatchItems）完成。
  "watchlist.add_many": {
    items: { type: "array", required: true, nonEmpty: true, label: "待加入自选池的标的数组，每项 {code(必填 6 位), name(可选), reason(可选)}；多只录入必须用本操作而不是逐只 watchlist.add" },
  },
  "plans.set": {
    stockCode: { type: "string", required: true, nonEmpty: true, pattern: STOCK_CODE_PATTERN, aliases: ["code"], label: STOCK_CODE_LABEL },
    stockName: { type: "string", required: false, aliases: ["name"], label: "股票名称（可选）" },
    support: { type: "number", required: false, label: "支撑位（可选）" },
    resistance: { type: "number", required: false, label: "压力位（可选）" },
    targetPrice: { type: "number", required: false, label: "目标价（可选）" },
    stopLoss: { type: "number", required: false, label: "止损价（可选）" },
    notes: { type: "string", required: false, label: "备注（可选）" },
    watchConditions: { type: "array", required: false, label: "观察条件列表（可选）" },
    linkedAlertRuleIds: { type: "array", required: false, label: "关联提醒规则 id 列表（可选）" },
    planType: { type: "string", required: false, label: "预案类型（可选）" },
    strategyKey: { type: "string", required: false, label: "策略键（可选）" },
  },
  "plans.watch_conditions": {
    stockCode: { type: "string", required: true, nonEmpty: true, pattern: STOCK_CODE_PATTERN, aliases: ["code"], label: STOCK_CODE_LABEL },
    stockName: { type: "string", required: false, aliases: ["name"], label: "股票名称（可选）" },
    conditions: { type: "array", required: true, label: "观察条件数组" },
  },
  "watch_rules.create": {
    stockCode: { type: "string", required: true, nonEmpty: true, pattern: STOCK_CODE_PATTERN, label: STOCK_CODE_LABEL },
    stockName: { type: "string", required: false, label: "股票名称（可选，缺省用代码）" },
    ruleType: { type: "string", required: true, nonEmpty: true, label: "规则类型（须为 watch_rules.catalog 目录支持的取值）" },
    targetScope: { type: "string", required: false, label: "目标范围（可选，默认 manual）" },
    params: { type: "object", required: false, label: "规则参数（可选）" },
    cooldown: { type: "object", required: false, label: "冷却配置（可选）" },
    notification: { type: "object", required: false, label: "通知配置（可选）" },
    enabled: { type: "boolean", required: false, label: "是否启用（可选，默认 true）" },
  },
  "assets.delete": {
    assetId: { type: "string", required: true, nonEmpty: true, label: "要删除的资产 assetId" },
  },
  "automation.delete": {
    taskId: { type: "string", required: true, nonEmpty: true, label: "要删除的定时任务 taskId（删除任务 X，可用 automation.list 查到）" },
    expectedRevision: { type: "number", required: false, label: "期望的任务 revision（可选，防止确认后任务被改过）" },
  },
  "skill.set_enabled": {
    skillId: { type: "string", required: true, nonEmpty: true, label: "要停用的技能 skillId（skill.list 可查；仅停用需确认）" },
    enabled: { type: "boolean", required: true, label: "必须为 false（停用）；启用无需确认，直接调 skill.set_enabled（enabled:true）" },
    agentId: { type: "string", required: false, label: "目标 Agent（可选，scope 内多 Agent 时必填）" },
  },
  "skill.uninstall": {
    skillId: { type: "string", required: true, nonEmpty: true, label: "要卸载的技能 skillId（skill.list 可查）" },
    agentId: { type: "string", required: false, label: "目标 Agent（可选，scope 内多 Agent 时必填）" },
  },
};

export type ConfirmationContractResult = { ok: true } | { ok: false; error: string };

const TYPE_NAMES: Record<ConfirmationFieldType, string> = {
  string: "字符串",
  number: "数字",
  boolean: "布尔值",
  array: "数组",
  object: "对象",
};

function actualTypeName(value: unknown): string {
  if (Array.isArray(value)) return "数组";
  if (value === null) return "null";
  return typeof value;
}

function valueFor(payload: Record<string, unknown>, key: string, aliases: readonly string[] | undefined): unknown {
  if (payload[key] !== undefined) return payload[key];
  for (const alias of aliases ?? []) {
    if (payload[alias] !== undefined) return payload[alias];
  }
  return undefined;
}

/** 登记入口契约校验。无契约的操作（语义级校验已存在）直接放行。 */
export function validateConfirmationContract(
  operation: string,
  payload: Record<string, unknown>
): ConfirmationContractResult {
  const contract = CONFIRMATION_CONTRACTS[operation];
  if (!contract) return { ok: true };

  const allowed = new Set<string>();
  for (const [key, spec] of Object.entries(contract)) {
    allowed.add(key);
    for (const alias of spec.aliases ?? []) allowed.add(alias);
  }

  const errors: string[] = [];
  for (const [key, spec] of Object.entries(contract)) {
    const value = valueFor(payload, key, spec.aliases);
    if (value === undefined) {
      if (spec.required) errors.push(`缺少必填字段 ${key}（${spec.label}）`);
      continue;
    }
    const matchesType =
      spec.type === "array" ? Array.isArray(value)
      : spec.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
      : typeof value === spec.type;
    if (!matchesType) {
      errors.push(`字段 ${key} 必须是${TYPE_NAMES[spec.type]}（当前是 ${actualTypeName(value)}）`);
      continue;
    }
    if (spec.type === "string") {
      const text = String(value);
      if (spec.nonEmpty && text.trim() === "") {
        errors.push(`字段 ${key} 必须是非空字符串`);
        continue;
      }
      if (spec.pattern && !spec.pattern.regex.test(text)) {
        errors.push(`字段 ${key} ${spec.pattern.message}`);
      }
    } else if (spec.type === "array" && spec.nonEmpty && (value as unknown[]).length === 0) {
      errors.push(`字段 ${key} 不能是空数组`);
    }
  }

  const unknownKeys = Object.keys(payload).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    errors.push(`存在契约外字段：${unknownKeys.join("、")}`);
  }

  if (errors.length === 0) return { ok: true };
  return {
    ok: false,
    error: [
      `确认草案未通过 ${operation} 的字段契约：${errors.join("；")}。`,
      `允许的字段：${[...allowed].join("、")}。`,
      "请修正后在本轮重新调用 confirmations.request 登记草案（不要带契约外字段，必填字段缺一不可）。",
    ].join(""),
  };
}
