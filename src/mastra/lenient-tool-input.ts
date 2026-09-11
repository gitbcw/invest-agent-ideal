import { z } from "zod/v4";

/** 形态探测（instanceof / _zod.def）在运行时完成，静态侧只要求是对象。 */
type AnyZodSchema = object;

/**
 * 工具入参宽容矫正（2026-09-11，ED-P2 W37 补评引出的 P0 修复）。
 *
 * 证据（automation_tool_payloads，atrun_65f278cb / atrun_44bf2b5b）：兜底档
 * 模型（qwen3.7-flash）会把 number/boolean/object 参数序列化成 JSON 字符串
 * —— {"limit":"50"}、"stage":"True"、"input":"{}" —— zod/MCP 输入校验按类型
 * 不符整批拒绝，模型重试仍犯同类错误后放弃，run 以 outputSkipped 空转收场
 * （9-9/9-10 行业复盘连续零写入）。同会话中不带此类参数的调用全部成功。
 *
 * 本模块只在「严格校验已失败」的前提下，把字符串还原成目标类型再重校验：
 * - 还原规则严格（数字串→number、true/false（忽略大小写）→boolean、
 *   {/[ 开头的串→JSON.parse 结果），不猜语义；
 * - 只有重校验整体通过才采用矫正结果，否则维持原始失败，不会把
 *   「本应传字符串的字段」悄悄改型；
 * - 校验一次通过的正常路径零改动、零额外开销（一次原样 validate）。
 */

const NUMERIC_STRING = /^[+-]?\d+(?:\.\d+)?$/;
const BOOLEAN_STRING = /^(?:true|false)$/i;
const JSON_STRING_START = /^[[{]/;

export function coerceStringToType(value: unknown, type: "number" | "boolean" | "object" | "array"): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if ((type === "number") && NUMERIC_STRING.test(text)) return Number(text);
  if (type === "boolean" && BOOLEAN_STRING.test(text)) return text.toLowerCase() === "true";
  if ((type === "object" || type === "array") && JSON_STRING_START.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return value;
    }
  }
  return value;
}

type JsonSchemaLike = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike;
  anyOf?: JsonSchemaLike[];
  oneOf?: JsonSchemaLike[];
  allOf?: JsonSchemaLike[];
};

function declaredType(schema: JsonSchemaLike | undefined): "number" | "boolean" | "object" | "array" | undefined {
  const raw = schema?.type;
  const type = Array.isArray(raw) ? raw[0] : raw;
  if (type === "integer") return "number";
  if (type === "number" || type === "boolean" || type === "object" || type === "array") return type;
  return undefined;
}

function coerceByJsonSchema(value: unknown, schema: JsonSchemaLike | undefined, depth: number): unknown {
  if (!schema || depth > 4) return value;
  // 字符串是叶子：先按声明类型尝试还原（守卫必须在其后——typeof string !== "object"）。
  if (typeof value === "string") {
    const target = declaredType(schema);
    if (target) return coerceStringToType(value, target);
    // union（anyOf/oneOf）无顶层类型：逐 variant 尝试，首个可还原的胜出；
    // 还原结果仍需整体校验通过才会被采用。
    const stringVariants = schema.anyOf ?? schema.oneOf ?? [];
    for (const variant of stringVariants) {
      const coerced = coerceByJsonSchema(value, variant, depth + 1);
      if (coerced !== value) return coerced;
    }
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  const variants = schema.anyOf ?? schema.oneOf ?? [];
  for (const variant of variants) {
    const coerced = coerceByJsonSchema(value, variant, depth + 1);
    if (coerced !== value) return coerced;
  }
  if (!Array.isArray(value)) {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    let changed = false;
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (!(key in out)) continue;
      const coerced = coerceByJsonSchema(out[key], property, depth + 1);
      if (coerced !== out[key]) {
        out[key] = coerced;
        changed = true;
      }
    }
    return changed ? out : value;
  }
  if (Array.isArray(value) && schema.items) {
    const out = value.map((item) => coerceByJsonSchema(item, schema.items, depth + 1));
    return out.some((item, index) => item !== value[index]) ? out : value;
  }
  return value;
}

function unwrapOptional(schema: AnyZodSchema): AnyZodSchema {
  let current: AnyZodSchema = schema;
  for (let hop = 0; hop < 4; hop += 1) {
    const def = current as unknown as { _zod?: { def?: { innerType?: AnyZodSchema } } };
    const inner = def._zod?.def?.innerType;
    if (!inner) return current;
    current = inner;
  }
  return current;
}

function coerceByZodType(value: unknown, schema: AnyZodSchema): unknown {
  if (typeof value !== "string") return value;
  const target = unwrapOptional(schema);
  if (target instanceof z.ZodNumber) return coerceStringToType(value, "number");
  if (target instanceof z.ZodBoolean) return coerceStringToType(value, "boolean");
  if (
    target instanceof z.ZodObject
    || target instanceof z.ZodRecord
    || target instanceof z.ZodArray
    || target instanceof z.ZodTuple
  ) {
    return coerceStringToType(value, target instanceof z.ZodArray || target instanceof z.ZodTuple ? "array" : "object");
  }
  return value;
}

/** 按声明 shape 逐字段矫正（嵌套 object 递归一层处理其 shape）。 */
export function coerceArgsForZodShape(input: unknown, shape: z.ZodRawShape, depth = 0): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input) || depth > 3) return input;
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  let changed = false;
  for (const [key, field] of Object.entries(shape)) {
    if (!(key in out)) continue;
    const coerced = coerceByZodType(out[key], field);
    if (coerced !== out[key]) {
      out[key] = coerced;
      changed = true;
      continue;
    }
    const inner = unwrapOptional(field);
    if (inner instanceof z.ZodObject && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      const nested = coerceArgsForZodShape(out[key], inner.shape, depth + 1);
      if (nested !== out[key]) {
        out[key] = nested;
        changed = true;
      }
    }
  }
  return changed ? out : input;
}

/** 内置服务工具的宽容 zod schema：preprocess 矫正 + 原 shape 校验。
 * zod v4 的 toJSONSchema 会忽略 preprocess 函数、按输出 schema 生成
 * 模型侧 JSON Schema（已验证），对模型可见的工具定义无影响。 */
export function lenientZodObject(shape: z.ZodRawShape): z.ZodType<Record<string, unknown>> {
  return z.preprocess((value) => coerceArgsForZodShape(value, shape), z.object(shape));
}

interface StandardValidateResult {
  value?: unknown;
  issues?: unknown[];
}

/**
 * 标准 schema（zod、MCP 工具等）的 validate 包装：先原样校验；失败时按
 * schema 自带的 jsonSchema（zod v4 与 @mastra/mcp 工具均携带）引导矫正后
 * 重校验，仍失败则返回原始失败。jsonSchema 不可用时退化为顶层盲矫正。
 */
export function withLenientInputValidation<T extends object>(schema: T): T {
  const standard = (schema as { "~standard"?: { validate?: unknown; jsonSchema?: unknown } })["~standard"];
  const originalValidate = standard && typeof standard.validate === "function"
    ? (standard.validate as (input: unknown) => StandardValidateResult).bind(schema)
    : undefined;
  if (!originalValidate || !standard) return schema;
  const jsonSchemaMember = standard.jsonSchema as
    | { input?: (options: unknown) => JsonSchemaLike }
    | undefined;
  let resolvedJsonSchema: JsonSchemaLike | undefined;
  let jsonSchemaResolved = false;
  const resolveJsonSchema = (): JsonSchemaLike | undefined => {
    if (jsonSchemaResolved) return resolvedJsonSchema;
    jsonSchemaResolved = true;
    try {
      resolvedJsonSchema = jsonSchemaMember?.input?.({ target: "draft-07" });
    } catch {
      resolvedJsonSchema = undefined;
    }
    return resolvedJsonSchema;
  };
  const validate = (input: unknown): StandardValidateResult => {
    const first = originalValidate(input);
    if (!first || !Array.isArray(first.issues)) return first;
    const jsonSchema = resolveJsonSchema();
    const coerced = jsonSchema
      ? coerceByJsonSchema(input, jsonSchema, 0)
      : coerceStringToType(input, "object");
    if (coerced === input) return first;
    const second = originalValidate(coerced);
    if (second && !Array.isArray(second.issues)) return second;
    return first;
  };
  const wrappedStandard = { ...standard, validate, ...(jsonSchemaMember ? { jsonSchema: jsonSchemaMember } : {}) };
  // 保持原型与不可枚举属性（与 external-mcp observer 同款复制策略），仅替换 ~standard。
  return Object.defineProperties(Object.create(Object.getPrototypeOf(schema)), {
    ...Object.getOwnPropertyDescriptors(schema),
    "~standard": { value: wrappedStandard, writable: true, configurable: true, enumerable: true },
  }) as T;
}
