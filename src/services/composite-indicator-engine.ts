/**
 * L3a 规则树复合指标引擎
 *
 * 设计要点(详见 docs/composite-indicator-system.md §7):
 *   - 引擎是纯函数:配置 + 预计算 inputs → 触发结果
 *   - 引擎不抓行情,不算指标,不查信号(那是调度器的活)
 *   - 表达式走 src/services/rule-expression.ts 安全解析器,禁止 eval/Function
 *   - 100ms 超时熔断
 *
 * combine 模式:
 *   - and          :所有 inputs.triggered 都为 true 才触发
 *   - or           :任一为 true 即触发
 *   - majority     :过半数 true 即触发
 *   - weighted_sum :加权分超过 threshold 触发
 *
 * 用法:
 *   const engine = new CompositeIndicatorEngine();
 *   const cfg = engine.parseYaml(yamlText);
 *   const result = engine.evaluate(cfg[0], {
 *     inputs: { "indicator.macd_signal": true, "indicator.volume_ratio": 2.5 },
 *   });
 */

import { readFileSync } from "node:fs";
import {
  compileExpression,
  evaluateExpression,
  RuleExpressionError,
} from "./rule-expression.js";

const DEFAULT_TIMEOUT_MS = 100;

export type CompositeReliability = "stable" | "experimental";
export type CompositeSchedule = "intraday" | "daily_post_market" | "on_signal";
export type CombineMode = "and" | "or" | "majority" | "weighted_sum";

export interface CompositeInput {
  key: string;
  source: string;
  /** 加权分模式下使用 */
  weight?: number;
  /** 类型转换提示(信息性,引擎不强转) */
  transform?: "raw" | "boolean" | "number";
}

export interface CompositeIndicatorConfig {
  key: string;
  name: string;
  description?: string;
  reliability: CompositeReliability;
  type: "rule_tree";
  inputs: CompositeInput[];
  combine?: CombineMode;
  thresholds: {
    trigger?: { expr: string };
    weighted_sum?: { threshold: number };
  };
  outputs?: Record<string, "boolean" | "number">;
  schedule?: CompositeSchedule;
  user_acknowledged: boolean;
  acknowledged_at?: string;
}

export interface CompositeIndicatorContext {
  inputs: Record<string, number | boolean>;
}

export interface CompositeIndicatorResult {
  triggered: boolean;
  score?: number;
  notes: string[];
}

export class CompositeIndicatorError extends Error {
  constructor(message: string, readonly configKey?: string) {
    super(`CompositeIndicatorError: ${message}${configKey ? ` (key=${configKey})` : ""}`);
    this.name = "CompositeIndicatorError";
  }
}

/**
 * 极简 YAML 解析器,只覆盖 L3a 用到的 schema。
 *
 * 不引入 js-yaml 是为了:
 *   1. 减少依赖体积
 *   2. 强约束:用户只能写 L3a 支持的字段,异常 schema 直接报错
 *
 * 支持的语法:
 *   - 顶层是 `- key: value` 列表
 *   - 缩进嵌套(2 空格)
 *   - `key: value`(值可以是 string/number/boolean)
 *   - 内联 object `{ a: 1, b: 2 }`
 *   - 双引号字符串
 *
 * 不支持:多行字符串、anchor/alias、tag 等高级特性。
 */
export function parseCompositeYaml(text: string): CompositeIndicatorConfig[] {
  const lines = text.split("\n");
  const configs: CompositeIndicatorConfig[] = [];
  let current: CompositeIndicatorConfig | null = null;
  let inInputs = false;
  let inThresholds = false;

  const finishInput = () => {
    if (current && inInputs && (current.inputs.length === 0 || current.inputs[current.inputs.length - 1].key !== undefined)) {
      // 已经在 push 时处理
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();

    if (indent === 0 && trimmed.startsWith("- key:")) {
      // 新条目
      if (current) configs.push(current);
      const value = strippedValue(trimmed.slice("- key:".length));
      current = {
        key: value,
        name: value,
        reliability: "stable",
        type: "rule_tree",
        inputs: [],
        thresholds: {},
        user_acknowledged: false,
      };
      inInputs = false;
      inThresholds = false;
      continue;
    }

    if (!current) {
      throw new CompositeIndicatorError(`unexpected line outside any entry: '${trimmed}'`);
    }

    if (indent === 2 && trimmed.startsWith("name:")) {
      current.name = strippedValue(trimmed.slice("name:".length));
    } else if (indent === 2 && trimmed.startsWith("description:")) {
      current.description = strippedValue(trimmed.slice("description:".length));
    } else if (indent === 2 && trimmed.startsWith("reliability:")) {
      const v = strippedValue(trimmed.slice("reliability:".length));
      if (v !== "stable" && v !== "experimental") {
        throw new CompositeIndicatorError(`bad reliability '${v}'`, current.key);
      }
      current.reliability = v;
    } else if (indent === 2 && trimmed.startsWith("combine:")) {
      const v = strippedValue(trimmed.slice("combine:".length));
      if (!["and", "or", "majority", "weighted_sum"].includes(v)) {
        throw new CompositeIndicatorError(`bad combine '${v}'`, current.key);
      }
      current.combine = v as CombineMode;
    } else if (indent === 2 && trimmed.startsWith("schedule:")) {
      const v = strippedValue(trimmed.slice("schedule:".length));
      if (!["intraday", "daily_post_market", "on_signal"].includes(v)) {
        throw new CompositeIndicatorError(`bad schedule '${v}'`, current.key);
      }
      current.schedule = v as CompositeSchedule;
    } else if (indent === 2 && trimmed.startsWith("user_acknowledged:")) {
      current.user_acknowledged = strippedValue(trimmed.slice("user_acknowledged:".length)) === "true";
    } else if (indent === 2 && trimmed.startsWith("acknowledged_at:")) {
      current.acknowledged_at = strippedValue(trimmed.slice("acknowledged_at:".length));
    } else if (indent === 2 && trimmed === "inputs:") {
      inInputs = true;
      inThresholds = false;
    } else if (indent === 2 && trimmed === "thresholds:") {
      inThresholds = true;
      inInputs = false;
    } else if (indent === 2 && trimmed === "outputs:") {
      inInputs = false;
      inThresholds = false;
    } else if (inInputs && indent >= 4 && trimmed.startsWith("- key:")) {
      current.inputs.push({
        key: strippedValue(trimmed.slice("- key:".length)),
        source: "",
      });
    } else if (inInputs && indent >= 6 && current.inputs.length > 0) {
      const last = current.inputs[current.inputs.length - 1];
      if (trimmed.startsWith("source:")) {
        last.source = strippedValue(trimmed.slice("source:".length));
      } else if (trimmed.startsWith("weight:")) {
        last.weight = parseFloat(strippedValue(trimmed.slice("weight:".length)));
      } else if (trimmed.startsWith("transform:")) {
        const v = strippedValue(trimmed.slice("transform:".length));
        if (v !== "raw" && v !== "boolean" && v !== "number") {
          throw new CompositeIndicatorError(`bad transform '${v}'`, current.key);
        }
        last.transform = v as "raw" | "boolean" | "number";
      }
    } else if (inThresholds && indent >= 4) {
      if (trimmed.startsWith("trigger:")) {
        const rest = trimmed.slice("trigger:".length).trim();
        current.thresholds.trigger = { expr: parseInlineObject(rest).expr ?? rest };
      } else if (trimmed.startsWith("weighted_sum:")) {
        const rest = trimmed.slice("weighted_sum:".length).trim();
        const obj = parseInlineObject(rest);
        const threshold = parseFloat(obj.threshold ?? "");
        if (Number.isNaN(threshold)) {
          throw new CompositeIndicatorError(`bad weighted_sum.threshold`, current.key);
        }
        current.thresholds.weighted_sum = { threshold };
      }
    }
    // outputs 字段在 schema 里只是信息性,不强制校验
    void finishInput;
  }

  if (current) configs.push(current);

  // 校验必填字段
  for (const cfg of configs) {
    if (!cfg.key) throw new CompositeIndicatorError("missing key");
    if (cfg.inputs.length === 0) {
      throw new CompositeIndicatorError("inputs must not be empty", cfg.key);
    }
    for (const inp of cfg.inputs) {
      if (!inp.source) {
        throw new CompositeIndicatorError(`input '${inp.key}' missing source`, cfg.key);
      }
    }
  }

  return configs;
}

function strippedValue(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseInlineObject(s: string): Record<string, string> {
  // 形如 { expr: "a && b", threshold: 1.5 }
  const out: Record<string, string> = {};
  const t = s.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return out;
  const body = t.slice(1, -1);
  // 用逗号分割,但要避免引号内的逗号
  const parts: string[] = [];
  let buf = "";
  let inQuote: string | null = null;
  for (const ch of body) {
    if (inQuote) {
      buf += ch;
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      buf += ch;
    } else if (ch === ",") {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf);

  for (const part of parts) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = strippedValue(part.slice(idx + 1));
    out[k] = v;
  }
  return out;
}

export class CompositeIndicatorEngine {
  private readonly timeoutMs: number;

  constructor(options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * 从文件加载 YAML 配置。
   */
  loadConfig(yamlPath: string): CompositeIndicatorConfig[] {
    const text = readFileSync(yamlPath, "utf8");
    return parseCompositeYaml(text);
  }

  /**
   * 对单条规则求值。
   *
   * 返回 { triggered, score?, notes }。
   * triggered 由 combine 模式 + thresholds.trigger 表达式共同决定:
   *   - 先按 combine 算出 combineTriggered 和 score
   *   - 若有 thresholds.trigger,在 combineTriggered 基础上额外要求表达式为真
   *   - 若没有 thresholds.trigger,直接用 combineTriggered
   */
  evaluate(
    config: CompositeIndicatorConfig,
    ctx: CompositeIndicatorContext,
  ): CompositeIndicatorResult {
    const startedAt = Date.now();
    const notes: string[] = [];

    // 白名单 = inputs.key
    const whitelist = new Set(config.inputs.map((i) => i.key));

    // 检查 ctx.inputs 是否完整覆盖声明字段
    for (const inp of config.inputs) {
      if (!(inp.key in ctx.inputs)) {
        throw new CompositeIndicatorError(
          `missing input '${inp.key}' (source=${inp.source})`,
          config.key,
        );
      }
    }

    const combine = config.combine ?? "and";
    const values = config.inputs.map((i) => ctx.inputs[i.key]);

    let combineTriggered: boolean;
    let score: number | undefined;

    switch (combine) {
      case "and":
        combineTriggered = values.every((v) => toBool(v));
        score = values.filter((v) => toBool(v)).length / values.length;
        break;
      case "or":
        combineTriggered = values.some((v) => toBool(v));
        score = values.filter((v) => toBool(v)).length / values.length;
        break;
      case "majority":
        combineTriggered =
          values.filter((v) => toBool(v)).length > values.length / 2;
        score = values.filter((v) => toBool(v)).length / values.length;
        break;
      case "weighted_sum": {
        let sum = 0;
        let totalWeight = 0;
        for (let i = 0; i < config.inputs.length; i++) {
          const w = config.inputs[i].weight ?? 1;
          sum += toNum(values[i]) * w;
          totalWeight += w;
        }
        score = totalWeight > 0 ? sum / totalWeight : 0;
        const threshold =
          config.thresholds.weighted_sum?.threshold ?? Number.NaN;
        if (Number.isNaN(threshold)) {
          throw new CompositeIndicatorError(
            "weighted_sum combine requires thresholds.weighted_sum.threshold",
            config.key,
          );
        }
        combineTriggered = score >= threshold;
        break;
      }
      default:
        throw new CompositeIndicatorError(
          `unsupported combine '${combine as string}'`,
          config.key,
        );
    }

    let triggered = combineTriggered;

    if (config.thresholds.trigger) {
      const ast = compileExpression(config.thresholds.trigger.expr);
      // 表达式作用域同样以 inputs.key 为键
      const exprResult = evaluateExpression(ast, whitelist, ctx.inputs as Record<string, number | boolean>, {
        timeoutMs: this.timeoutMs,
        startedAt,
      });
      triggered = combineTriggered && toBool(exprResult);
      if (!toBool(exprResult)) {
        notes.push(
          `thresholds.trigger 表达式为 false (expr: ${config.thresholds.trigger.expr})`,
        );
      }
    }

    if (config.reliability === "experimental" && !config.user_acknowledged) {
      notes.push(
        "experimental 指标未签告知协议,即使 triggered=true 也不应被主链路采用",
      );
    }

    return { triggered, score, notes };
  }
}

function toBool(v: number | boolean): boolean {
  return typeof v === "number" ? v !== 0 : v;
}

function toNum(v: number | boolean): number {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

export { RuleExpressionError };
