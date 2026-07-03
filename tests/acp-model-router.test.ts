import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseChatRouteDecision,
  resolveChatModelTier,
  resolveScheduledModelTier,
} from "../src/acp/model-router.js";

describe("ACP model tier router", () => {
  test("uses model judge output for routine chat", async () => {
    const tier = await resolveChatModelTier("今天有哪些提醒？", {
      judge: async () => JSON.stringify({
        tier: "simple",
        confidence: 0.91,
        category: "status_query",
        reason: "用户只是查询提醒状态",
      }),
    });
    assert.equal(tier, "simple");
  });

  test("uses model judge output for ambiguous investment decisions", async () => {
    const tier = await resolveChatModelTier("能买吗？", {
      judge: async () => JSON.stringify({
        tier: "complex",
        confidence: 0.88,
        category: "investment_decision",
        reason: "短句涉及买入判断",
      }),
    });
    assert.equal(tier, "complex");
  });

  test("passes compact context to model judge", async () => {
    let userMessage = "";
    await resolveChatModelTier({
      text: "那这个呢？",
      contextPacket: {
        user: { userId: "u", instanceId: "i", channel: "weixin-mobile" },
        workspace: {},
        recentConversation: [
          { role: "user", content: "帮我分析一下 600519" },
          { role: "assistant", content: "需要结合估值和持仓计划看。" },
        ],
        pendingConfirmations: [{ kind: "plan_draft", summary: "600519 中线预案草案" }],
        latestArtifacts: [],
        stateSummary: {
          portfolioCount: 1,
          watchlistCount: 2,
          alertCount: 3,
          planCount: 4,
          latestReviewDate: "2026-07-03",
        },
        toolManifest: [],
      },
    }, {
      judge: async (input) => {
        userMessage = input.userMessage;
        return JSON.stringify({
          tier: "complex",
          confidence: 0.8,
          category: "contextual_investment_followup",
          reason: "上下文是股票分析延续",
        });
      },
    });
    assert.match(userMessage, /最近对话/);
    assert.match(userMessage, /待确认事项/);
    assert.match(userMessage, /状态摘要/);
  });

  test("falls back to complex when model judge fails", async () => {
    const tier = await resolveChatModelTier("帮我看看这个票", {
      judge: async () => "not json",
    });
    assert.equal(tier, "complex");
  });

  test("parses fenced JSON route decisions", () => {
    assert.deepEqual(
      parseChatRouteDecision('```json\n{"tier":"complex","confidence":1.2,"category":"x","reason":"y"}\n```'),
      { tier: "complex", confidence: 1, category: "x", reason: "y" },
    );
  });

  test("keeps scheduled market watch on simple tier", () => {
    assert.equal(resolveScheduledModelTier("scheduled-market-watch"), "simple");
    assert.equal(resolveScheduledModelTier("rule-alert-check"), "simple");
  });

  test("routes scheduled reviews to complex tier", () => {
    assert.equal(resolveScheduledModelTier("scheduled-daily-review"), "complex");
    assert.equal(resolveScheduledModelTier("scheduled-weekly-review"), "complex");
    assert.equal(resolveScheduledModelTier("scheduled-monthly-review"), "complex");
  });
});
