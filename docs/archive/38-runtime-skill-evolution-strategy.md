# Runtime And Skill Evolution Strategy

> Created: 2026-06-12

## Core Decision

Do not expand multi-backend runtime abstraction in the current phase.

The first phase should keep Codex ACP as the primary intelligent backend, while Invest Agent continues to own deterministic service capabilities, sandbox enforcement, skill loading, context construction, confirmation workflows, persistence, audit, WeChat binding, and push.

> **Update (2026-06-21, work package 2)**: Hermes has officially exited the main path. Codex is now the sole fallback for all complex reasoning. The `/api/hermes/*` experimental routes and `src/acp/hermes-stdio-agent.ts` are kept only for archaeology; do not reintroduce main-path dependencies on them. The full refactor roadmap lives in `docs/ideal-refactor-plan.md`.

LangChain, LangGraph, or a future self-built runtime should be treated as later runtime adapter options, not as product architecture.

## Why

The project is currently in a reduction phase.

The priority is not to build a large generic runtime now. The priority is to discover which user problems recur, which capabilities can be stabilized, and which workflows should be absorbed into Skills, deterministic APIs, sandbox confirmation flows, and durable project state.

Codex ACP is valuable in this phase because it can absorb uncertain edges:

- complex investment questions;
- vague user requests;
- research and screening tasks;
- unfamiliar workflow variants;
- places where current tools and skills are still incomplete;
- situations where judgment is needed before engineering the pattern.

This lets the system work before every edge case has been engineered.

## Skill As The Core Asset

The most portable asset is not a specific backend.

The core asset is the Skill system:

- strategy skeleton;
- instance expansion;
- examples and counterexamples;
- tool usage rules;
- output structure;
- confirmation boundaries;
- reasoning workflow;
- review and screening discipline;
- future scripts, tests, and evaluation cases.

Skills are an engineering collection, not just prompt text. They can accumulate product knowledge while staying independent from whether the backend is Codex, LangChain, LangGraph, or a future local runtime.

## Evolution Loop

The intended learning loop is:

```text
unknown or complex user request
  -> Codex handles it through ACP
  -> traces, replies, failures, and useful patterns are reviewed
  -> stable behavior is extracted into Skills, examples, tools, or confirmation flows
  -> high-frequency deterministic behavior moves into service APIs or fast paths
  -> remaining edge cases continue to use Codex
```

Codex is therefore not the permanent product brain. It is the first-phase capability source and edge-case absorber.

As the product learns, more behavior should move from open-ended agent reasoning into:

- strategy Skills;
- service tools;
- sandbox APIs;
- pending tasks and confirmations;
- review artifacts;
- evaluation cases;
- deterministic fast paths.

## Runtime Layer Position

Runtime is a replaceable execution layer.

It may later be:

- Codex ACP (current sole main path);
- LangChain;
- LangGraph;
- a self-built runtime;
- a hybrid of the above.

(Hermes was removed from this list on 2026-06-21.)

But runtime must not own:

- AI Project identity;
- project/user isolation;
- sandbox token verification;
- tool permissions;
- audit;
- Strategy Skill governance;
- business data writes;
- WeChat binding;
- push routing;
- product-level confirmation policy.

Those must remain in the Invest Agent platform service.

## Phase Policy

### Phase 1: Current

Use Codex ACP as the primary intelligent backend.

Do not build a full multi-backend abstraction yet. Keep backend configuration minimal and operational, not architectural.

Focus on:

- Skill system hardening;
- Context Builder extraction;
- sandbox and tool wrapper discipline;
- confirmation and audit loops;
- deterministic service APIs;
- quality evaluation from real WeChat conversations.

### Phase 2: Pattern Absorption

Extract repeated Codex behavior into more explicit project assets.

Good candidates:

- technical analysis patterns;
- review viewpoint validation;
- alert and watchlist workflows;
- stock screening report structure;
- method evolution candidates;
- tool calling recipes;
- failure examples and anti-patterns.

This phase should reduce expensive or slow model usage for stable tasks.

### Phase 3: Runtime Rebuild Or Replacement

Only after the stable workflows are known, evaluate whether to rebuild the runtime around LangChain, LangGraph, or a local runtime.

The reason to do this would be:

- cost control;
- predictable latency;
- local deterministic orchestration;
- better durable execution;
- tighter model routing;
- long-running research workflows with checkpointing.

The reason should not be framework enthusiasm.

## Design Implications

- Profile should not regain methodology responsibility. It remains a compatibility summary and routing/config residue.
- Backend config should not become the main product abstraction.
- Codex ACP should stay the default complex-reasoning fallback for now.
- Fast paths should be reserved for stable, well-understood workflows.
- LangChain/LangGraph should be studied as reference designs and optional adapters.
- The Skill system should keep absorbing rules, examples, and workflow discipline from real use.
- Tool calls should always pass through sandbox-bound service wrappers.
- Confirmation should be durable and auditable, not just a model phrase.

## Near-Term Next Steps

1. Keep Codex ACP as the main backend path.
2. Continue removing methodology responsibility from Profile.
3. Extract prompt construction into a clearer Context Builder module.
4. Keep improving Strategy Skill skeleton and instance expansion workflows.
5. Add evaluation examples from real WeChat conversations.
6. Treat LangChain/LangGraph as future optional runtime adapters, not immediate dependencies.

