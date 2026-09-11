import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod/v4";
import {
  coerceStringToType,
  lenientZodObject,
  withLenientInputValidation,
} from "../src/mastra/lenient-tool-input.ts";

/** 2026-09-09/09-10 生产证据（automation_tool_payloads，atrun_65f278cb）：
 * qwen3.7-flash 的出参形态——数字/布尔/对象全部字符串化，Python 风格布尔。 */
test("lenient zod object restores qwen-style stringified args (limit/stage/input)", () => {
  const schema = lenientZodObject({
    aspect: z.enum(["breadth", "overview", "score"]),
    limit: z.number().int().min(1).max(100).optional(),
    stage: z.boolean().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
  });
  const strict = z.object({
    aspect: z.enum(["breadth", "overview", "score"]),
    limit: z.number().int().min(1).max(100).optional(),
    stage: z.boolean().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
  });
  const qwenArgs = { aspect: "breadth", limit: "50", stage: "True", input: "{\"deep\": 1}" };
  assert.equal(strict.safeParse(qwenArgs).success, false, "baseline: strict schema rejects the stringified form");
  const parsed = schema.safeParse(qwenArgs);
  assert.equal(parsed.success, true, `lenient schema must accept it: ${JSON.stringify(parsed)}`);
  if (parsed.success) {
    assert.equal(parsed.data.limit, 50);
    assert.equal(parsed.data.stage, true);
    assert.deepEqual(parsed.data.input, { deep: 1 });
  }
  // 正常类型原样通过，字符串字段不被误改。
  const ok = schema.safeParse({ aspect: "overview", limit: 20, stage: false, input: { a: 1 } });
  assert.equal(ok.success, true);
  const untouched = schema.safeParse({ aspect: "breadth", limit: "not-a-number" });
  assert.equal(untouched.success, false, "非数字字符串仍被拒绝（矫正规则严格）");
  const parsedText = lenientZodObject({ pattern: z.string().min(1) }).safeParse({ pattern: "50" });
  assert.equal(parsedText.success && parsedText.data.pattern, "50", "声明为 string 的字段保持字符串");
});

test("withLenientInputValidation keeps a valid input untouched and coerces only on failure", () => {
  const base = z.object({ aspect: z.string(), limit: z.number().optional() });
  const wrapped = withLenientInputValidation(base) as z.ZodType;
  const std = (schema: unknown) => (schema as { "~standard": { validate: (input: unknown) => { value?: unknown; issues?: unknown[] } } })["~standard"];
  const okResult = std(wrapped).validate({ aspect: "breadth", limit: 10 });
  assert.ok(!Array.isArray(okResult.issues), "valid input passes as-is");
  const coerced = std(wrapped).validate({ aspect: "breadth", limit: "10" });
  assert.ok(!Array.isArray(coerced.issues), `stringified limit is coerced via jsonSchema guidance: ${JSON.stringify(coerced)}`);
  assert.equal((coerced as { value?: { limit?: unknown } }).value?.limit, 10);
  const bad = std(wrapped).validate({ aspect: "breadth", limit: "abc" });
  assert.ok(Array.isArray(bad.issues), "non-numeric string still fails");
  // jsonSchema 透传：模型侧 schema 转换（standardSchemaToJSONSchema）不受影响。
  assert.equal(
    typeof (wrapped as unknown as { "~standard": { jsonSchema?: unknown } })["~standard"].jsonSchema,
    "object",
    "jsonSchema member must survive the wrap",
  );
});

test("coerceStringToType stays strict: only exact literal forms are restored", () => {
  assert.equal(coerceStringToType("50", "number"), 50);
  assert.equal(coerceStringToType("-3.14", "number"), -3.14);
  assert.equal(coerceStringToType("50%", "number"), "50%");
  assert.equal(coerceStringToType("TRUE", "boolean"), true);
  assert.equal(coerceStringToType("False", "boolean"), false);
  assert.equal(coerceStringToType("yes", "boolean"), "yes");
  assert.deepEqual(coerceStringToType("{\"a\":1}", "object"), { a: 1 });
  assert.deepEqual(coerceStringToType("[1,2]", "array"), [1, 2]);
  assert.equal(coerceStringToType("{oops", "object"), "{oops");
  assert.equal(coerceStringToType(50, "number"), 50, "non-strings pass through");
});
