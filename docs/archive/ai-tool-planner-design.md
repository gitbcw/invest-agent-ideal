# Shared Context And Execution Lanes

> Created: 2026-06-24
> Status: Current direction

## Why This Exists

The WeChat entry should feel like a continuous investment assistant, not a command parser. Users naturally say things like "展开一下", "刚才那几个", "这个可以", or "今天复盘给我看看". Maintaining a large set of regular expressions for every phrasing makes the system brittle and often creates the worst user experience: code confidently answers the wrong intent.

The product does not need a second full Agent Runtime inside the service. It needs two execution lanes that share one user context:

```text
Fast Execution Lane: low latency, low cost, single action.
Deep Execution Lane: higher capability, higher cost, complex reasoning.
```

Both lanes serve the same `userId + instanceId + workspace`. They differ only in execution cost and task complexity.

## Target Message Flow

```text
WeChat message
  ↓
Shared context assembler
  - userId / instanceId / project binding
  - workspace path and current AI project
  - recent user-instance conversation memory
  - pending confirmations
  - latest generated artifacts
  - portfolio / watchlist / alerts / plans / reviews summary
  - available tool manifest
  ↓
Execution selector
  ├─ Fast Execution Lane
  │   - DeepSeek single-turn planner
  │   - one deterministic tool / one draft / one async ack
  │   - policy-gated execution
  │   - immediate WeChat reply
  │
  └─ Deep Execution Lane
      - active ACP backend: Kimi Code / Claude Code / Codex
      - workspace + AGENTS.md + skills
      - multi-step reasoning and report generation
      - WeChat reply or async push
```

## Design Principles

1. Do not let code guess broad natural-language intent when AI can do it better.
2. Do not let AI directly mutate durable state. It selects tools; code enforces policy.
3. Conversation continuity is user/instance scoped by default. `conversationId` is a channel trace, not the product memory boundary.
4. Deterministic capabilities should be reusable tools, not one-off route branches.
5. Regex and code rules should be safety guards or transitional shortcuts, not the main language understanding layer.
6. Low-confidence planner results should produce a short clarification, not a random fallback.
7. Fast and deep execution must read from the same shared context packet and write outcomes back to the same durable state/event stream.

## Fast Lane Boundary

The fast lane is not a full Agent Runtime. It is a constrained execution lane for simple WeChat interactions.

Hard constraints:

1. Single-turn: one user message is handled independently using the shared context packet.
2. Single-action: choose at most one deterministic tool, one draft, or one async task start.
3. Policy-gated: writes, durable mutations, and risky actions must pass code policy and confirmation.
4. No investment judgment: complex analysis, screening, review reasoning, and strategy interpretation are handed to the deep lane.
5. No private memory: it reads shared context and writes outcomes to shared state/events; it does not maintain its own worldview.

Examples that belong in the fast lane:

- 查看持仓 / 自选 / 提醒 / 预案 / 复盘记录。
- 查看今日复盘 or 展开刚才那份复盘。
- 把刚才那几个加入自选。
- 起草一条到价提醒 and wait for confirmation.
- Start daily review generation and immediately acknowledge.

Examples that must go to the deep lane:

- 个股/行业/概念研究。
- 选股问答 and watchlist conversion reasoning.
- Full daily/weekly/monthly review generation.
- Strategy matching and plan drafting beyond a simple confirmed template.
- Any multi-step reasoning that combines holdings, market data, methodology, and risk judgment.

## Shared Context Packet

The shared context assembler lives in `src/acp/context-packet.ts`.

It should expose one canonical packet that both lanes can use:

```ts
interface ContextPacket {
  user: {
    userId: string;
    instanceId: string;
    projectId?: string;
    conversationId?: string;
    channel: "weixin-mobile" | "dashboard" | "api";
  };
  workspace: {
    path?: string;
    projectType?: string;
    skillBundleId?: string;
    strategySkillId?: string;
  };
  recentConversation: Array<{ role: "user" | "assistant"; content: string }>;
  pendingConfirmations: Array<{
    kind: "alert_draft" | "plan_draft" | "investment_model_draft";
    summary: string;
    expiresAt?: string;
  }>;
  latestArtifacts: Array<{
    kind: "daily_review" | "analysis" | "screening";
    date?: string;
    title: string;
    summary: string;
  }>;
  stateSummary: {
    portfolioCount: number;
    watchlistCount: number;
    alertCount: number;
    planCount: number;
    latestReviewDate?: string;
  };
  toolManifest: Array<{
    name: string;
    policy: "read" | "draft" | "write" | "async" | "reject";
    description: string;
  }>;
}
```

Fast lane may use a compact form of the packet. Deep lane may use the same packet plus workspace files, skills, sandbox token, and deterministic review/screening context.

## Tool Policy Classes

| Class | Examples | Execution Rule |
| --- | --- | --- |
| Read-only | query portfolio, watchlist, alerts, plans, review records, monitor overview | AI planner may call directly |
| Async generation | generate daily review, complex stock analysis | Start background job, immediately ack, push summary when done |
| Draft | draft alert, draft plan, draft investment model | Produce draft only; wait for user confirmation |
| Write | add/remove watchlist, add/remove portfolio, save plan, update model | Require explicit user intent or confirmation; audit result |
| Dangerous/unsupported | bulk delete, trading execution, unsupported financial commitment | Reject or ask for clarification |

## Current State

The codebase already has a partial AI planner:

- `src/acp/tool-planner.ts` lets DeepSeek choose tools such as `portfolio.query`, `watchlist.add`, `review_records.query`, and `alert.set`.
- `src/acp/tool-manifest.ts` defines the current code-backed tool manifest with policy classes (`read`, `draft`, `write`, `async`, `reject`).
- The planner prompt is built from the tool manifest, output schema section, and policy section. This is still code-backed, but it is separated from the WeChat bridge and can become a first-class manifest later.
- `src/acp/context-packet.ts` builds the first shared packet with user/instance identity, workspace path, recent conversation, pending confirmations passed by caller, latest daily review artifact, state counts, and the tool manifest.
- `src/acp/prompt-context-builder.ts` now passes the same packet into the deep ACP prompt, so the deep lane can see recent conversation, latest artifacts, and state summary.
- `src/acp/pending-state.ts` provides the first canonical in-process pending confirmation provider for alert drafts, plan drafts, and investment model drafts. ContextPacket reads it automatically.
- `src/acp/tool-policy.ts` provides the first policy gate before fast-lane execution. It rejects unregistered tools, enforces execution-mode matching (`read` / `draft` / `write` / `async`), and requires explicit user intent or confirmed pending state before `write` tools can run.
- `weixin-conversation-memory.ts` stores recent WeChat turns and now loads user/instance recent memory by default.
- Deterministic handlers already expose most core capabilities.

However, some detailed execution behavior still lives in the WeChat bridge and handlers: draft materialization, pending confirmation expiry, async duplicate-job suppression, and write audit events.

## Migration Plan

1. Move more detailed execution guarantees behind reusable policy helpers:
   - `draft`: assert the handler creates or refreshes pending confirmation, never direct-writes.
   - `write`: attach an audit event for every successful direct write.
   - `async`: guard against duplicate in-flight jobs and push a summary when done.
2. Promote the current code-backed tool manifest into a first-class manifest with policy metadata.
3. Let planner output structured actions with arguments:

```json
{
  "route": "tool",
  "tool": "review.records.query",
  "args": { "mode": "today" },
  "confidence": 0.9,
  "reason": "用户要查看刚生成的今日复盘"
}
```

4. Keep a small set of safety guards only for high-risk boundaries and emergency fallbacks.
5. Add golden conversation cases for ambiguous follow-ups: "展开一下", "刚才那几个加入自选", "可以", "取消", "今天复盘给我看看".

## Non-Goals

- Do not remove deterministic service handlers.
- Do not let AI write workspace files or SQLite directly.
- Do not make DeepSeek the only complex reasoning backend; ACP backends remain the complex fallback.
- Do not treat `conversationId` as the only memory boundary for investment context.
- Do not build a second full Agent Runtime in the service fast lane.
