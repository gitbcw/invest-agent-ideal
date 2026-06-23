# Invest Agent UI Workbench Strategy

> Created: 2026-06-12

## Core Decision

WeChat should remain the lightweight interaction channel.

The product still needs a richer UI workbench because the main value of Invest Agent is not fully visible in a chat thread. Reviews, viewpoint validation, alert statistics, signal performance, strategy evolution, and long-form research reports need a screen where users can inspect what the system did and why it mattered.

The existing Dashboard is the current carrier. It should evolve from an operational admin/data panel into an investment workbench that makes the assistant's work auditable, readable, and valuable.

## Why WeChat Is Not Enough

WeChat is good for:

- quick questions;
- reminders and alerts;
- confirmations;
- short summaries;
- follow-up clarifications;
- lightweight queries such as holdings, watchlist, alerts, and pending tasks.

WeChat is weak for:

- reading long daily/weekly/monthly review reports;
- comparing charts and tables;
- understanding viewpoint validation history;
- seeing whether alerts were useful;
- reviewing strategy evolution candidates;
- browsing saved research artifacts;
- perceiving the system's accumulated work.

If the user only experiences the assistant through WeChat, they can feel whether it is helpful, but they cannot easily see the evidence of value.

## Product Role Split

```text
WeChat
  -> entry point
  -> notification
  -> quick query
  -> confirmation
  -> short summary

Workbench UI
  -> report reader
  -> evidence board
  -> review archive
  -> signal and alert analytics
  -> strategy evolution console
  -> user-visible value surface

Skills
  -> methodology
  -> workflow discipline
  -> output structure
  -> tool usage rules

Service
  -> persistence
  -> sandbox
  -> audit
  -> APIs
  -> scheduler
  -> push

Codex / Runtime
  -> complex reasoning fallback
  -> research and edge-case handling
  -> pattern source for future Skill/tool hardening
```

## Workbench Product Goals

The workbench should answer five user questions:

1. What did the assistant do for me today?
2. Which conclusions were useful, wrong, or still waiting for validation?
3. Which alerts mattered and which were noise?
4. How are my holdings, watchlist, plans, and signals connected?
5. How is my method evolving over time?

This is how the product turns invisible AI work into visible trust.

## Primary Information Architecture

### 1. Home / Today

Purpose: show today's working state in one screen.

Recommended content:

- current holdings and watchlist health;
- active alerts and triggered events;
- today's key market/watchlist changes;
- pending confirmations;
- latest review status;
- open validation points;
- "what the assistant has done today" activity feed.

This should feel like a disciplined investment desk, not a generic metrics dashboard.

### 2. Review Reader

Purpose: make daily/weekly/monthly reviews readable and useful.

Recommended content:

- daily review report;
- weekly review report;
- monthly review report;
- previous-view validation section;
- facts / inference / action / validation separated;
- links to related holdings, alerts, plans, and watchlist entries;
- compact summary plus full report view.

Key rule: WeChat can push a summary, but the full report should be read in the workbench.

### 3. Viewpoint Tracker

Purpose: show whether the assistant's prior views are being validated.

Recommended content:

- open viewpoints;
- validated viewpoints;
- invalidated viewpoints;
- pending or not-yet-verifiable viewpoints;
- expected review date;
- linked source review;
- linked stock/industry/alert;
- reason why it was judged valid or invalid.

This is one of the most important trust surfaces. It makes the assistant accountable.

### 4. Alerts And Signals

Purpose: show signal quality, not only signal existence.

Recommended content:

- active alert rules;
- recent alert events;
- hit / false positive / missed / uncertain classification;
- relation to plans or reviews;
- dedupe and cooldown state;
- signal reliability over time;
- noisy signal candidates.

This turns alerts from "messages" into an analyzable monitoring system.

### 5. Plans And Watchlist

Purpose: connect candidates, plans, and monitoring.

Recommended content:

- holding plans;
- watchlist entries with reason and source;
- support/resistance/target/stop-loss;
- observation conditions;
- linked alert rules;
- latest review conclusion;
- whether conditions have changed since entry.

The user should be able to answer: "Why is this stock here, and what am I waiting for?"

### 6. Strategy Evolution

Purpose: make method changes explicit and governed.

Recommended content:

- instance expansion candidates;
- confirmed/rejected method candidates;
- skeleton improvement candidates for maintainers;
- source conversation/review;
- affected area: review, screening, alerts, technical entry, risk;
- status: proposed, confirmed, rejected, applied;
- diff or plain-language change summary.

This aligns with the Strategy Skill direction. It also prevents method drift from being hidden in chat memory.

### 7. Research Archive

Purpose: preserve complex research outputs.

Recommended content:

- screening reports;
- industry reports;
- company analysis;
- risk assessments;
- technical entry reviews;
- links to watchlist conversions;
- follow-up validation points.

This is where Codex's complex work becomes a durable product artifact.

### 8. Activity And Audit

Purpose: show what happened and why.

Recommended content:

- assistant actions;
- sandbox writes;
- confirmations;
- alerts pushed;
- review artifacts saved;
- failed/timeout tasks;
- pending jobs.

This view can be partially admin-facing, but a user-visible activity feed is important for trust.

## Current Dashboard Gap

The current Dashboard already contains useful raw material:

- overview;
- holdings;
- watchlist;
- plans;
- indicator library;
- alert rules;
- indicator snapshots;
- alert events;
- recent reviews;
- conversations;
- signal configuration;
- patrol settings;
- WeChat connection.

The gap is not only missing data. The larger gap is product framing.

Current Dashboard mostly answers:

- What records exist?
- Can I edit them?
- Is the service running?

The workbench should additionally answer:

- What has the system learned?
- Which judgments were validated?
- Which alerts were useful?
- Which method changes are pending?
- What did the assistant contribute over time?

## UX Principles

- Do not make chat the report reader.
- Do not bury work output in raw logs.
- Keep operational controls separate from value presentation.
- Show relationships between reviews, alerts, plans, and watchlist entries.
- Make uncertainty visible, not embarrassing.
- Treat charts as evidence, not decoration.
- Default to scan-friendly summaries with drill-down details.
- Preserve the investment workbench feel: calm, dense, reliable, and auditable.

## Visual Direction

The UI should feel like an investment workbench, not a marketing page.

Recommended style:

- restrained, information-dense layout;
- clear typography hierarchy;
- strong table and timeline readability;
- compact cards only for repeated entities or focused summaries;
- status chips for validation and alert quality;
- charts used for signal/review performance;
- report reader optimized for long Chinese text;
- side-by-side source/evidence when helpful.

Avoid:

- oversized hero sections;
- decorative gradients as the main experience;
- generic chatbot-style UI;
- hiding important evidence behind chat bubbles;
- one long unstructured report blob.

## Data And API Needs

Some existing APIs already help:

- `/api/dashboard`
- `/api/reviews/context`
- `/api/reviews/weekly-context`
- `/api/reviews/monthly-context`
- `/api/reviews/query`
- sandbox dashboard and review endpoints
- alert events and indicator results in dashboard data
- method change candidates via sandbox profile APIs

Likely future needs:

- review artifact index by date/type;
- viewpoint tracker API with status filters;
- alert quality statistics API;
- method/instance expansion candidate API;
- research report artifact index;
- activity feed API;
- chart-ready time series for alerts, signals, and validation results.

## Implementation Strategy

### Phase 1: Reframe Existing Dashboard

Goal: make the current Dashboard communicate value better without a full rewrite.

Tasks:

- rename or position Dashboard as "Investment Workbench";
- improve the review page into a readable report archive;
- add a pending strategy/method candidates section;
- surface viewpoint validation status more prominently;
- add a "today's assistant work" activity feed if data is available;
- keep existing CRUD pages intact.

### Phase 2: Review And Validation Center

Goal: make review quality visible.

Tasks:

- daily/weekly/monthly review reader;
- viewpoint tracker;
- validation status filters;
- links from viewpoints to source reviews and related stocks;
- review history timeline;
- export/share-friendly report view.

### Phase 3: Alerts And Signal Analytics

Goal: make monitoring quality visible.

Tasks:

- alert event timeline;
- hit/false/missed/uncertain labels;
- signal reliability summaries;
- noisy signal detection;
- relation to plans and reviews;
- chart-ready statistics.

### Phase 4: Strategy Evolution Console

Goal: make Skill/instance evolution governable.

Tasks:

- list instance expansion candidates;
- show source conversation/review;
- confirm/reject/apply workflow;
- distinguish instance expansion from skeleton improvement candidates;
- show applied changes as method history.

### Phase 5: Research Archive

Goal: make complex Codex work durable.

Tasks:

- save screening and industry/company research reports;
- link report candidates to watchlist entries;
- track follow-up validation points;
- let users browse by industry, stock, date, and status.

## Success Criteria

The UI direction is working if:

- the user can read a full review comfortably outside WeChat;
- the user can see what the assistant did today;
- the user can inspect whether prior views were right, wrong, or pending;
- the user can understand why each watchlist item exists;
- the user can see alert quality over time;
- method changes are visible and governed;
- the product's value is observable, not only felt through chat.

## Relationship To Runtime Strategy

This workbench strategy supports the runtime strategy.

Codex can continue to handle complex edge cases, but valuable outputs should become artifacts:

- reviews;
- viewpoints;
- alert judgments;
- research reports;
- method candidates;
- confirmation decisions.

The workbench is where those artifacts become visible and reusable. Without it, the product risks becoming a capable assistant whose work disappears into chat history.

