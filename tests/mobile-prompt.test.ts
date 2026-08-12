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
