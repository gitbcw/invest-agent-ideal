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

    // 默认全健康：文本轮与图片轮都选链首。
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-sol");
    assert.equal(resolveAutoModel({ hasImage: true }).model, "gpt-5.6-sol");

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
    // 文本轮兜底走 Flash Vision；图片轮兜底走 qwen flash。
    assert.equal(resolveAutoModel({ hasImage: false }).model, "deepseek-v4-flash-vision-exp");
    assert.equal(resolveAutoModel({ hasImage: true }).model, "qwen3.7-flash");

    // 全链降级时按优先级硬选链首。
    clock += 60_000;
    recordModelFeedback("deepseek-v4-flash-vision-exp", { ok: false });
    clock += 60_000;
    recordModelFeedback("deepseek-v4-flash-vision-exp", { ok: false });
    clock += 60_000;
    recordModelFeedback("qwen3.7-flash", { ok: false });
    clock += 60_000;
    recordModelFeedback("qwen3.7-flash", { ok: false });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-sol");

    // 好证据重置计数：降级后一次好调用不足以恢复（冷却未到），但计数清零。
    clock += 60_000;
    recordModelFeedback("gpt-5.6-terra", { ok: true, firstTokenMs: 1_000 });
    assert.equal(getModelHealth("gpt-5.6-terra").healthy, false);

    // P2 缓刑恢复语义：冷却期满后不立即恢复，需连续 2 次好证据（探针或真实调用）。
    __resetModelHealthForTest(() => clock);
    clock += 60_000;
    recordModelFeedback("gpt-5.6-sol", { ok: true, firstTokenMs: 45_000 });
    clock += 60_000;
    recordModelFeedback("gpt-5.6-sol", { ok: true, firstTokenMs: 45_000 });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-terra");
    clock += 31 * 60 * 1000;
    // 冷却期满：仍处缓刑，不回到链首。
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-terra");
    // 第 1 次好证据（探针）：仍在缓刑。
    recordModelFeedback("gpt-5.6-sol", { ok: true, firstTokenMs: 1_000 });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-terra");
    // 第 2 次好证据：恢复健康，回到链首。
    clock += 60_000;
    recordModelFeedback("gpt-5.6-sol", { ok: true, firstTokenMs: 1_000 });
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
    const { __resetModelHealthForTest, resolveAutoModel } = await import("../src/services/model-health.js");
    __resetModelHealthForTest();
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-sol");
    assert.equal(resolveAutoModel({ hasImage: false, exclude: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"] }).model, "deepseek-v4-flash-vision-exp");
    // 图片轮轮内兜底耗尽 qwen flash 后还能落到链尾 vision（不再硬选链首）。
    assert.equal(resolveAutoModel({ hasImage: true, exclude: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "qwen3.7-flash"] }).model, "deepseek-v4-flash-vision-exp");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
  }
});
