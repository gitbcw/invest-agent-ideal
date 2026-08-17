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
    // 文本轮兜底走 flash；图片轮兜底走豆包。
    assert.equal(resolveAutoModel({ hasImage: false }).model, "deepseek-v4-pro");
    assert.equal(resolveAutoModel({ hasImage: true }).model, "doubao-seed-2-1-turbo-260628");

    // 全链降级时按优先级硬选链首。
    clock += 60_000;
    recordModelFeedback("deepseek-v4-pro", { ok: false });
    clock += 60_000;
    recordModelFeedback("deepseek-v4-pro", { ok: false });
    clock += 60_000;
    recordModelFeedback("doubao-seed-2-1-turbo-260628", { ok: false });
    clock += 60_000;
    recordModelFeedback("doubao-seed-2-1-turbo-260628", { ok: false });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-sol");

    // 好证据重置计数：降级后一次好调用不足以恢复（冷却未到），但计数清零。
    clock += 60_000;
    recordModelFeedback("gpt-5.6-terra", { ok: true, firstTokenMs: 1_000 });
    assert.equal(getModelHealth("gpt-5.6-terra").healthy, false);

    // 冷却期满（30 分钟）：sol 乐观恢复为链首。
    clock += 31 * 60 * 1000;
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-sol");
    // 乐观恢复后再来一个坏证据：立即再次降级（计数已停在 1）。
    clock += 60_000;
    recordModelFeedback("gpt-5.6-sol", { ok: false });
    assert.equal(resolveAutoModel({ hasImage: false }).model, "gpt-5.6-terra");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
  }
});
