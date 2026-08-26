import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.WORKSPACE_BACKEND = "mastra";

test("auto chain routes by health and capability with degrade hysteresis", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "model-health-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");

  try {
    let clock = 1_000_000;
    const { __resetModelHealthForTest, recordModelFeedback, resolveAutoModel, getModelHealth } = await import("../src/services/model-health.js");
    __resetModelHealthForTest(() => clock);

    // 新启动或没有 GPT 快探针时，自动路由直接使用国产模型。
    assert.equal(resolveAutoModel({ hasImage: false }).model, "deepseek-v4-flash-vision-exp");
    assert.equal(resolveAutoModel({ hasImage: true }).model, "deepseek-v4-flash-vision-exp");

    // GPT 系列裁撤（2026-08-26）：luna 是唯一 GPT 档，需要自己的 <=10s 探针才进入候选链。
    recordModelFeedback("gpt-5.6-luna", { ok: true, firstTokenMs: 9_000, source: "probe" });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-luna");
    assert.equal(resolveAutoModel({ hasImage: true }).model, "deepseek-v4-flash-vision-exp");

    // 单次慢证据不降级（防抖：需要连续 2 个）。
    recordModelFeedback("gpt-5.6-luna", { ok: true, firstTokenMs: 45_000 });
    assert.equal(getModelHealth("gpt-5.6-luna").healthy, true);
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-luna");

    // 第二个慢证据触发降级，路由落到国产链首。
    clock += 60_000;
    recordModelFeedback("gpt-5.6-luna", { ok: true, firstTokenMs: 45_000 });
    assert.equal(getModelHealth("gpt-5.6-luna").healthy, false);
    assert.equal(resolveAutoModel({ hasImage: false }).model, "deepseek-v4-flash-vision-exp");
    assert.equal(resolveAutoModel({ hasImage: true }).model, "deepseek-v4-flash-vision-exp");

    // 国产链逐级降级：deepseek → qwen → doubao。
    clock += 60_000;
    recordModelFeedback("deepseek-v4-flash-vision-exp", { ok: false });
    clock += 60_000;
    recordModelFeedback("deepseek-v4-flash-vision-exp", { ok: false });
    assert.equal(resolveAutoModel({ hasImage: true }).model, "qwen3.7-flash");
    clock += 60_000;
    recordModelFeedback("qwen3.7-flash", { ok: false });
    clock += 60_000;
    recordModelFeedback("qwen3.7-flash", { ok: false });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "doubao-seed-2-1-turbo-260628");

    // 全链降级时按优先级硬选通过探针门禁的链首（luna）。
    clock += 60_000;
    recordModelFeedback("doubao-seed-2-1-turbo-260628", { ok: false });
    clock += 60_000;
    recordModelFeedback("doubao-seed-2-1-turbo-260628", { ok: false });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-luna");

    // P2 缓刑恢复语义：冷却期满后不立即恢复，需连续 2 次好证据（探针或真实调用）。
    __resetModelHealthForTest(() => clock);
    recordModelFeedback("gpt-5.6-luna", { ok: true, firstTokenMs: 1_000, source: "probe" });
    clock += 60_000;
    recordModelFeedback("gpt-5.6-luna", { ok: true, firstTokenMs: 45_000 });
    clock += 60_000;
    recordModelFeedback("gpt-5.6-luna", { ok: true, firstTokenMs: 45_000 });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "deepseek-v4-flash-vision-exp");
    clock += 31 * 60 * 1000;
    // 冷却期满：仍处缓刑，不回到链首。
    assert.equal(resolveAutoModel({ hasImage: false }).model, "deepseek-v4-flash-vision-exp");
    // 第 1 次好证据（探针）：仍在缓刑。
    recordModelFeedback("gpt-5.6-luna", { ok: true, firstTokenMs: 1_000, source: "probe" });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "deepseek-v4-flash-vision-exp");
    // 第 2 次好证据：恢复健康，回到链首。
    clock += 60_000;
    recordModelFeedback("gpt-5.6-luna", { ok: true, firstTokenMs: 1_000, source: "probe" });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-luna");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
  }
});

test("resolveAutoModel exclude honors in-turn fallback skips", async () => {
  process.env.WORKSPACE_BACKEND = "mastra";
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "model-health-excl-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  try {
    const { __resetModelHealthForTest, recordModelFeedback, resolveAutoModel } = await import("../src/services/model-health.js");
    __resetModelHealthForTest();
    recordModelFeedback("gpt-5.6-luna", { ok: true, firstTokenMs: 1_000, source: "probe" });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-luna");
    assert.equal(resolveAutoModel({ hasImage: false, exclude: ["gpt-5.6-luna"] }).model, "deepseek-v4-flash-vision-exp");
    assert.equal(resolveAutoModel({ hasImage: true }).model, "deepseek-v4-flash-vision-exp");
    assert.equal(resolveAutoModel({ hasImage: true, exclude: ["deepseek-v4-flash-vision-exp"] }).model, "qwen3.7-flash");
    assert.equal(resolveAutoModel({ hasImage: true, exclude: ["deepseek-v4-flash-vision-exp", "qwen3.7-flash"] }).model, "doubao-seed-2-1-turbo-260628");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
  }
});

test("GPT auto routing requires that model's latest probe to be <=10s and recent", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "model-health-gpt-gate-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  try {
    let clock = 10_000_000;
    const {
      __resetModelHealthForTest,
      getGptProbeEligibility,
      recordModelFeedback,
      resolveAutoModel,
    } = await import("../src/services/model-health.js");
    __resetModelHealthForTest(() => clock);

    // Real calls, even fast ones, never unlock GPT automatic routing.
    recordModelFeedback("gpt-5.6-luna", { ok: true, firstTokenMs: 500 });
    assert.equal(getGptProbeEligibility("gpt-5.6-luna").reason, "missing");
    assert.equal(resolveAutoModel({ hasImage: false }).model, "deepseek-v4-flash-vision-exp");

    // 10 seconds is inclusive; only a fast probe unlocks the GPT entry.
    recordModelFeedback("gpt-5.6-luna", { ok: true, firstTokenMs: 10_000, source: "probe" });
    assert.equal(getGptProbeEligibility("gpt-5.6-luna").eligible, true);
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-luna");

    // A newer slow or failed probe immediately closes that model's gate.
    clock += 60_000;
    recordModelFeedback("gpt-5.6-luna", { ok: true, firstTokenMs: 10_001, source: "probe" });
    assert.equal(getGptProbeEligibility("gpt-5.6-luna").reason, "slow");
    assert.equal(resolveAutoModel({ hasImage: false }).model, "deepseek-v4-flash-vision-exp");
    clock += 60_000;
    recordModelFeedback("gpt-5.6-luna", { ok: false, firstTokenMs: 100, source: "probe" });
    assert.equal(getGptProbeEligibility("gpt-5.6-luna").reason, "failed");

    // A fast probe expires after two hours, preventing stale evidence from unlocking GPT forever.
    recordModelFeedback("gpt-5.6-luna", { ok: true, firstTokenMs: 1_000, source: "probe" });
    clock += 2 * 60 * 60 * 1000 + 1;
    assert.equal(getGptProbeEligibility("gpt-5.6-luna").reason, "stale");
    assert.equal(resolveAutoModel({ hasImage: false }).model, "deepseek-v4-flash-vision-exp");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
  }
});

test("model catalog keeps only gpt-5.6-luna from the GPT series (owner 2026-08-26)", async () => {
  const { MODEL_DESCRIPTIONS } = await import("../src/services/model-health.js");
  assert.equal(MODEL_DESCRIPTIONS["gpt-5.6-luna"] !== undefined, true);
  assert.equal(MODEL_DESCRIPTIONS["gpt-5.6-sol"], undefined);
  assert.equal(MODEL_DESCRIPTIONS["gpt-5.6-terra"], undefined);
  assert.equal(MODEL_DESCRIPTIONS["gpt-5.5"], undefined);
  assert.equal(MODEL_DESCRIPTIONS["deepseek-v4-flash-vision-exp"] !== undefined, true);
  assert.equal(MODEL_DESCRIPTIONS["qwen3.7-flash"] !== undefined, true);
  assert.equal(MODEL_DESCRIPTIONS["doubao-seed-2-1-turbo-260628"] !== undefined, true);
});
