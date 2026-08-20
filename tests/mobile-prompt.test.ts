import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildMobilePrompt } from "../src/runtime/mobile-prompt.js";

const reviewContext = {
  date: "2026-07-22",
  generatedAt: "2026-07-22T10:00:00.000Z",
  previousReview: null,
  openViewpoints: [],
  marketIndex: null,
  sourceQuality: [],
  holdings: [],
  watchlist: [],
  infoFilter: "",
  alerts: [],
  alertCount: 0,
  existingPlans: [],
  focusPoints: [],
  customInstructions: "",
  dataLimits: [],
};

describe("daily review prompt tool boundary", () => {
  it("permits only the publication tool for scheduled daily reviews", () => {
    const prompt = buildMobilePrompt({
      userText: "scheduled review",
      reviewContext,
      allowReviewPublication: true,
    });
    assert.match(prompt, /必须调用 reviews\.save/);
    assert.doesNotMatch(prompt, /不要再调用 curl、服务 API 或任何工具/);
  });

  it("keeps the no-tool boundary for non-scheduled review prompts", () => {
    const prompt = buildMobilePrompt({ userText: "review", reviewContext });
    assert.match(prompt, /不要再调用 curl、服务 API 或任何工具/);
  });
});

describe("server time fact (mg 2026-08-19 stale-scope incident)", () => {
  it("states the server date as a bare fact in every prompt variant, with no behavior rules", async () => {
    const { serverTimeFact } = await import("../src/runtime/mobile-prompt.js");
    for (const prompt of [
      buildMobilePrompt({ userText: "帮我看看持仓" }),
      buildMobilePrompt({ userText: "复盘", reviewContext, allowReviewPublication: true }),
    ]) {
      assert.match(prompt, /【系统时间】\d{4}\/\d{2}\/\d{2}周. \d{2}:\d{2}（Asia\/Shanghai）/);
      // 设计决定（2026-08-20）：提示词只给事实，规则上工具层。
      // 「最新交易日=今天」的规则在周末是错的，禁令式规则易与其他场景冲突。
      assert.doesNotMatch(prompt, /一律以该日期为准/);
      assert.doesNotMatch(prompt, /不得用于本轮取数参数/);
    }
    assert.match(serverTimeFact(new Date("2026-08-19T14:00:00Z")), /周三/);
  });
});
