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

    // 每个 GPT 模型必须有自己的 <=10s 探针，才允许进入自动候选链。
    recordModelFeedback("gpt-5.6-sol", { ok: true, firstTokenMs: 9_000, source: "probe" });
    recordModelFeedback("gpt-5.6-terra", { ok: true, firstTokenMs: 9_000, source: "probe" });
    recordModelFeedback("gpt-5.5", { ok: true, firstTokenMs: 9_000, source: "probe" });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-sol");
    assert.equal(resolveAutoModel({ hasImage: true }).model, "deepseek-v4-flash-vision-exp");

    // 单次慢证据不降级（防抖：需要连续 2 个）。
    recordModelFeedback("gpt-5.6-sol", { ok: true, firstTokenMs: 45_000 });
    assert.equal(getModelHealth("gpt-5.6-sol").healthy, true);
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-sol");

    // 第二个慢证据触发降级，路由落到 terra。
    clock += 60_000;
    recordModelFeedback("gpt-5.6-sol", { ok: true, firstTokenMs: 45_000 });
    assert.equal(getModelHealth("gpt-5.6-sol").healthy, false);
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-terra");

    // terra 报错一次 + 慢一次 -> 降级；gpt-5.5 失败两次 -> 降级。
    clock += 60_000;
    recordModelFeedback("gpt-5.6-terra", { ok: false });
    clock += 60_000;
    recordModelFeedback("gpt-5.6-terra", { ok: false });
    clock += 60_000;
    recordModelFeedback("gpt-5.5", { ok: false });
    clock += 60_000;
    recordModelFeedback("gpt-5.5", { ok: true, firstTokenMs: 60_000 });
    // GPT 不可用时，文本与图片均优先走 DeepSeek 全模态。
    assert.equal(resolveAutoModel({ hasImage: false }).model, "deepseek-v4-flash-vision-exp");
    assert.equal(resolveAutoModel({ hasImage: true }).model, "deepseek-v4-flash-vision-exp");

    // 全链降级时按优先级硬选链首。
    clock += 60_000;
    recordModelFeedback("deepseek-v4-flash-vision-exp", { ok: false });
    clock += 60_000;
    recordModelFeedback("deepseek-v4-flash-vision-exp", { ok: false });
    assert.equal(resolveAutoModel({ hasImage: true }).model, "qwen3.7-flash");
    clock += 60_000;
    recordModelFeedback("qwen3.7-flash", { ok: false });
    clock += 60_000;
    recordModelFeedback("qwen3.7-flash", { ok: false });
    clock += 60_000;
    recordModelFeedback("doubao-seed-2-1-turbo-260628", { ok: false });
    clock += 60_000;
    recordModelFeedback("doubao-seed-2-1-turbo-260628", { ok: false });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-sol");

    // 好证据重置计数：降级后一次好调用不足以恢复（冷却未到），但计数清零。
    clock += 60_000;
    recordModelFeedback("gpt-5.6-terra", { ok: true, firstTokenMs: 1_000 });
    assert.equal(getModelHealth("gpt-5.6-terra").healthy, false);

    // P2 缓刑恢复语义：冷却期满后不立即恢复，需连续 2 次好证据（探针或真实调用）。
    __resetModelHealthForTest(() => clock);
    recordModelFeedback("gpt-5.6-sol", { ok: true, firstTokenMs: 1_000, source: "probe" });
    recordModelFeedback("gpt-5.6-terra", { ok: true, firstTokenMs: 1_000, source: "probe" });
    clock += 60_000;
    recordModelFeedback("gpt-5.6-sol", { ok: true, firstTokenMs: 45_000 });
    clock += 60_000;
    recordModelFeedback("gpt-5.6-sol", { ok: true, firstTokenMs: 45_000 });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-terra");
    clock += 31 * 60 * 1000;
    // 冷却期满：仍处缓刑，不回到链首。
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-terra");
    // 第 1 次好证据（探针）：仍在缓刑。
    recordModelFeedback("gpt-5.6-sol", { ok: true, firstTokenMs: 1_000, source: "probe" });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-terra");
    // 第 2 次好证据：恢复健康，回到链首。
    clock += 60_000;
    recordModelFeedback("gpt-5.6-sol", { ok: true, firstTokenMs: 1_000, source: "probe" });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-sol");
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
    recordModelFeedback("gpt-5.6-sol", { ok: true, firstTokenMs: 1_000, source: "probe" });
    recordModelFeedback("gpt-5.6-terra", { ok: true, firstTokenMs: 1_000, source: "probe" });
    recordModelFeedback("gpt-5.5", { ok: true, firstTokenMs: 1_000, source: "probe" });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-sol");
    assert.equal(resolveAutoModel({ hasImage: false, exclude: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"] }).model, "deepseek-v4-flash-vision-exp");
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
    recordModelFeedback("gpt-5.6-sol", { ok: true, firstTokenMs: 500 });
    assert.equal(getGptProbeEligibility("gpt-5.6-sol").reason, "missing");
    assert.equal(resolveAutoModel({ hasImage: false }).model, "deepseek-v4-flash-vision-exp");

    // 10 seconds is inclusive; only the exact model with the fast probe is unlocked.
    recordModelFeedback("gpt-5.6-terra", { ok: true, firstTokenMs: 10_000, source: "probe" });
    assert.equal(getGptProbeEligibility("gpt-5.6-terra").eligible, true);
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-terra");

    // A newer slow or failed probe immediately closes that model's gate.
    clock += 60_000;
    recordModelFeedback("gpt-5.6-terra", { ok: true, firstTokenMs: 10_001, source: "probe" });
    assert.equal(getGptProbeEligibility("gpt-5.6-terra").reason, "slow");
    assert.equal(resolveAutoModel({ hasImage: false }).model, "deepseek-v4-flash-vision-exp");
    clock += 60_000;
    recordModelFeedback("gpt-5.6-terra", { ok: false, firstTokenMs: 100, source: "probe" });
    assert.equal(getGptProbeEligibility("gpt-5.6-terra").reason, "failed");

    // A fast probe expires after two hours, preventing stale evidence from unlocking GPT forever.
    recordModelFeedback("gpt-5.5", { ok: true, firstTokenMs: 1_000, source: "probe" });
    clock += 2 * 60 * 60 * 1000 + 1;
    assert.equal(getGptProbeEligibility("gpt-5.5").reason, "stale");
    assert.equal(resolveAutoModel({ hasImage: false }).model, "deepseek-v4-flash-vision-exp");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
  }
});

test("model catalog exposes only the consolidated DeepSeek vision domestic entry", async () => {
  const { MODEL_DESCRIPTIONS } = await import("../src/services/model-health.js");
  assert.equal(MODEL_DESCRIPTIONS["deepseek-v4-flash-vision-exp"] !== undefined, true);
  assert.equal(MODEL_DESCRIPTIONS["qwen3.7-flash"] !== undefined, true);
  assert.equal(MODEL_DESCRIPTIONS["doubao-seed-2-1-turbo-260628"] !== undefined, true);
  assert.equal(MODEL_DESCRIPTIONS["deepseek-v4-pro"], undefined);
  assert.equal(MODEL_DESCRIPTIONS["deepseek-v4-flash"], undefined);
});
