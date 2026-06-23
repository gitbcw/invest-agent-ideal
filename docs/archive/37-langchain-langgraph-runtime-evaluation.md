# LangChain / LangGraph Runtime Evaluation

> Created: 2026-06-12

## Purpose

This note evaluates whether LangChain and LangGraph should influence the next Invest Agent runtime architecture.

The short answer is: yes, but selectively.

LangChain and LangGraph validate many of the directions already emerging in this project:

- compose only the harness you need;
- separate model loop, tools, middleware, context, persistence, and human confirmation;
- keep tool execution behind explicit runtime context;
- support durable pauses for human-in-the-loop actions;
- treat model providers as swappable adapters rather than product architecture.

They should not replace the current Invest Agent service, sandbox, skill system, or AI Project registry wholesale.

## Source Notes

Official documents reviewed:

- LangChain JavaScript overview: `https://docs.langchain.com/oss/javascript/langchain/overview`
- LangChain JavaScript agents: `https://docs.langchain.com/oss/javascript/langchain/agents`
- LangChain JavaScript tools: `https://docs.langchain.com/oss/javascript/langchain/tools`
- LangChain JavaScript middleware: `https://docs.langchain.com/oss/javascript/langchain/middleware/overview`
- LangChain context overview: `https://docs.langchain.com/oss/javascript/concepts/context`
- LangGraph JavaScript overview: `https://docs.langchain.com/oss/javascript/langgraph/overview`
- LangGraph JavaScript interrupts: `https://docs.langchain.com/oss/javascript/langgraph/interrupts`
- LangGraph JavaScript checkpointers: `https://docs.langchain.com/oss/javascript/langgraph/checkpointers`
- LangGraph persistence: `https://docs.langchain.com/oss/python/langgraph/persistence`
- LangChain Human-in-the-Loop: `https://docs.langchain.com/oss/python/langchain/frontend/human-in-the-loop`

## Current Invest Agent Direction

Current project consensus:

- Codex ACP should be the preferred intelligent backend.
- Hermes is useful for experiments, but should not be structurally required.
- Profile is being downgraded from methodology carrier to compatibility summary and routing/config residue.
- Strategy Skills are becoming the primary method engineering unit.
- The service owns deterministic state: DB, dashboard, scheduler, WeChat connection, push, sandbox, audit, and confirmation.
- The sandbox must enforce identity and permissions server-side. The model should never decide `userId`, `projectId`, or destructive permissions by prompt alone.

This aligns well with the LangChain/LangGraph split:

- LangChain is closer to an agent harness: model, prompt, tools, middleware.
- LangGraph is closer to orchestration runtime: durable execution, persistence, streaming, human-in-the-loop.

## Comparison Matrix

| Area | LangChain / LangGraph Capability | Current Invest Agent State | Evaluation |
| --- | --- | --- | --- |
| Model switching | Standard model interface and provider integrations | Currently split across Hermes profile, DeepSeek fast route, Codex ACP config | Useful pattern; implement as `ModelRouter` or thin runtime adapter, not as Profile |
| Tool calling | Tools are callable functions with schemas, selected by model | Service APIs and sandbox routes already exist | Useful schema pattern, but tools must wrap `/api/sandbox/*`, not bypass service |
| Context management | Runtime context, static/dynamic context, middleware shaping prompts/tools | Skill bundle, strategy skill context, profile context, recent WeChat memory, sandbox token | Strongly useful; confirms need for a first-class Context Builder |
| Middleware | Logging, retries, fallbacks, prompt/tool transformation, guardrails | Some ad hoc fast route, trace, sanitizer, timeout handling | Useful as design vocabulary; can implement small local middleware chain |
| Human-in-the-loop | Durable pauses, approve/edit/reject, checkpoint-backed resume | Conversation tasks, sandbox confirmations, instance expansion candidates | Very useful pattern; we are building a domain-specific version already |
| Persistence | Checkpointers for short-term state; stores for long-term memory | SQLite tables, conversation tasks, review artifacts, method candidates | Conceptually useful; no need to adopt LangGraph persistence immediately |
| Durable execution | Graph execution can pause/resume/recover | Background review exists, but general research workflow is not durable | Worth considering for long research/review workflows |
| Streaming | Runtime-level streaming support | WeChat mostly request/reply plus async push | Useful later, not urgent |
| Tracing/evaluation | LangSmith tracing/evals | `codex_acp_traces`, audit logs, manual smoke tests | Ideas useful; external platform optional |
| Multi-agent | Router/subagents/handoffs | Skill bundle and fast/slow split are emerging | Useful for research/screening later, not core now |

## What We Should Borrow

### 1. Runtime Adapter Interface

Define our own internal runtime interface:

```ts
interface RuntimeAdapter {
  name: "codex-acp" | "hermes" | "langchain" | "langgraph" | "local";
  run(input: RuntimeRunInput): Promise<RuntimeRunResult>;
}
```

This keeps Codex ACP as preferred backend while allowing Hermes, LangChain, LangGraph, or a future self-built runtime to be swapped in without changing project semantics.

The product architecture should not depend on Hermes Profile.

### 2. Context Builder

Create a first-class context-building layer:

```text
AI Project runtime context
  -> sandbox context
  -> skill bundle context
  -> strategy skill skeleton + instance expansion
  -> deterministic service snapshot
  -> recent conversation memory
  -> pending tasks / confirmations
  -> model/runtime config
```

LangChain's context docs are useful here because they distinguish runtime context from LLM prompt context and cross-conversation context.

### 3. Tool Wrapper Layer

Do not let any framework call project internals directly.

All model-facing tools should be wrappers over sandbox APIs:

```text
Model tool call
  -> local tool wrapper
  -> /api/sandbox/*
  -> sandbox token verification
  -> service operation
  -> audit log
```

This preserves the security work already done in Invest Agent.

### 4. Confirmation As Durable Workflow

LangGraph interrupts and HITL validate the shape we just implemented:

```text
user preference change
  -> draft
  -> pending task
  -> user confirms/rejects
  -> candidate record
  -> later applied by method maintenance workflow
```

The current project should continue using its own domain-specific pending tasks and sandbox confirmations. LangGraph may become useful later for long, multi-step workflows, but not as a prerequisite.

### 5. Middleware Vocabulary

We should introduce lightweight local middleware concepts:

- model fallback / retry;
- tool allowlist filtering;
- context compression;
- structured output enforcement;
- call limits;
- customer-output sanitization;
- trace hooks;
- timeout and async delivery policy.

This can be local TypeScript first. LangChain middleware is a reference design, not an immediate dependency requirement.

## What We Should Not Outsource

Do not outsource these to LangChain/LangGraph:

- AI Project identity and isolation.
- Sandbox token generation and verification.
- Tool permissions.
- Business table writes.
- Audit logs.
- Strategy Skill governance.
- WeChat binding and push queue.
- Dashboard and platform registry.
- Confirmation policy for financial actions.

These are product security and product semantics, not generic agent framework concerns.

## Recommended Architecture

```text
Channel Connector
  -> Platform Service
  -> AI Project Registry
  -> Context Builder
      -> Skill Loader
      -> Strategy Skill Context
      -> Sandbox Context
      -> Runtime Config
      -> Pending Tasks / Confirmations
  -> Runtime Adapter
      -> Codex ACP preferred
      -> Hermes optional
      -> LangChain optional harness
      -> LangGraph optional durable workflow engine
      -> future self-built runtime
  -> Tool Wrapper Layer
      -> /api/sandbox/*
  -> Service DB / Scheduler / Push / Audit
```

This keeps the Invest Agent platform independent from any one framework.

## Decision

Do not introduce LangChain or LangGraph as a hard dependency yet.

Adopt the following concepts now:

- Runtime Adapter.
- Context Builder.
- Tool Wrapper Layer.
- Middleware pipeline.
- Durable confirmation workflow.

Consider a small LangGraph spike only for one narrow workflow:

- long-running research report;
- daily review generation with pause/resume;
- method evolution review where user approval may happen later.

Do not use LangGraph for basic WeChat CRUD, alert setting, watchlist queries, or simple preference candidates. Those are already better served by deterministic service code plus pending tasks.

## Practical Next Steps

1. Update current architecture docs so Profile is no longer described as the formal strategy source.
2. Add a Runtime Adapter design document or section to the platform architecture.
3. Refactor prompt construction toward a named Context Builder module.
4. Keep Codex ACP as the preferred backend path.
5. Keep Hermes as optional and removable.
6. Add a future spike task: "LangGraph durable workflow for long research/review only."
7. Keep all framework calls behind sandbox-bound tool wrappers.

## Open Questions

- Should Codex ACP become the only production backend while Hermes remains dev/test only?
- Should model routing be controlled by project config, runtime adapter config, or an explicit model router table?
- Should instance expansion candidates eventually have a dedicated table instead of using `method_change_candidates`?
- Should long research tasks use our push queue, LangGraph checkpointing, or a local durable task runner?

