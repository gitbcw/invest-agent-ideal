import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  isChatModelRouterEnabled,
  isSimpleModelTierEnabled,
  parseChatRouteDecision,
  resolveChatModelTier,
  resolveScheduledModelTier,
} from "../src/acp/model-router.js";

describe("ACP model tier router", () => {
  test("uses complex tier by default while simple tier is disabled", async () => {
    const tier = await resolveChatModelTier("今天有哪些提醒？", {
      routerEnabled: true,
      judge: async () => JSON.stringify({
        tier: "simple",
        confidence: 0.91,
        category: "status_query",
        reason: "用户只是查询提醒状态",
      }),
    });
    assert.equal(tier, "complex");
  });

  test("uses model judge output for routine chat when simple tier is enabled", async () => {
    const tier = await resolveChatModelTier("今天有哪些提醒？", {
      routerEnabled: true,
      simpleEnabled: true,
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
      routerEnabled: true,
      simpleEnabled: true,
      judge: async () => JSON.stringify({
        tier: "complex",
        confidence: 0.88,
        category: "investment_decision",
        reason: "短句涉及买入判断",
      }),
    });
    assert.equal(tier, "complex");
  });

  test("uses complex tier without model judge when router is disabled", async () => {
    const tier = await resolveChatModelTier("帮我看看这个票", {
      routerEnabled: false,
      simpleEnabled: true,
      judge: async () => {
        throw new Error("judge should not be called");
      },
    });
    assert.equal(tier, "complex");
  });

  test("parses router enabled environment flag", () => {
    assert.equal(isChatModelRouterEnabled({}), true);
    assert.equal(isChatModelRouterEnabled({ ACP_MODEL_ROUTER_ENABLED: "true" }), true);
    assert.equal(isChatModelRouterEnabled({ ACP_MODEL_ROUTER_ENABLED: "false" }), false);
    assert.equal(isChatModelRouterEnabled({ ACP_MODEL_ROUTER_ENABLED: "0" }), false);
  });

  test("simple tier is opt-in", () => {
    assert.equal(isSimpleModelTierEnabled({}), false);
    assert.equal(isSimpleModelTierEnabled({ ACP_SIMPLE_MODEL_ENABLED: "true" }), true);
    assert.equal(isSimpleModelTierEnabled({ ACP_SIMPLE_MODEL_ENABLED: "1" }), true);
    assert.equal(isSimpleModelTierEnabled({ ACP_SIMPLE_MODEL_ENABLED: "false" }), false);
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
      routerEnabled: true,
      simpleEnabled: true,
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
      routerEnabled: true,
      simpleEnabled: true,
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

  test("keeps scheduled tasks on complex tier while simple tier is disabled", () => {
    assert.equal(resolveScheduledModelTier("scheduled-market-watch"), "complex");
    assert.equal(resolveScheduledModelTier("rule-alert-check"), "complex");
  });

  test("routes scheduled reviews to complex tier", () => {
    assert.equal(resolveScheduledModelTier("scheduled-daily-review"), "complex");
    assert.equal(resolveScheduledModelTier("scheduled-weekly-review"), "complex");
    assert.equal(resolveScheduledModelTier("scheduled-monthly-review"), "complex");
  });
});
