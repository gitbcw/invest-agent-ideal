# Onboarding Flow Standards

## User Journey Standard

The ideal onboarding journey is one continuous conversation:

1. Greeting explains the investment assistant role and asks for holdings/watchlist.
2. User provides holdings/watchlist in natural language or screenshot-derived text.
3. Assistant resolves securities, drafts holdings/watchlist, and waits for confirmation.
4. User confirms.
5. Assistant saves confirmed portfolio and moves to investment style.
6. User chooses a default style pack or describes a custom method.
7. Assistant drafts style/method and waits for confirmation.
8. User confirms.
9. Assistant confirms daily/weekly/monthly review schedule.
10. Assistant confirms market-watch fixed windows.
11. Assistant confirms notification preference.
12. Assistant confirms default watch boundary and completes onboarding.

Users usually respond to the previous assistant prompt directly. They do not need to say "下一步继续" during the main flow. Those phrases belong to state-recovery cases, not the main workflow.

## Required Product Qualities

- Natural progression: every assistant reply should make the next user action obvious.
- Confirmation discipline: durable writes require a draft and user confirmation.
- Code resolution: securities need 6-digit A-share codes or explicit ambiguity handling before portfolio/watchlist confirmation.
- User-provided weights: weights and cash ratio are valid context when the user provides them; do not ask for total assets.
- No internal leakage: user-facing replies must not expose local paths, APIs, curl, localhost, sandbox token, Codex, ACP, workspace, YAML, or fast-lane implementation terms.
- Step separation: review schedule, market-watch schedule, notification preference, and watch boundary are separate concepts.
- Low-disturbance default: notification choices should be user-facing modes, not P0/P1/P2.
- Watch boundary: onboarding watch_rules confirmation does not mean batch-creating price/MA/indicator rules.
- Completion: final state is `status=completed` and `current_step=completed`.

## Expected Workspace Outcome

After the default workflow:

- `config/onboarding_state.yaml`: all onboarding steps done and completed.
- `config/portfolio.yaml`: confirmed holdings/watchlist from the workflow.
- `config/strategy.yaml` or style config: selected/default/custom style represented.
- `config/schedules.yaml`: review schedule plus market-watch windows.
- `config/notification.yaml`: selected notification mode.
- `config/watch.yaml`: default watch boundary without accidental batch rule creation.

## What Counts As A Problem

- User can progress only by guessing system internals.
- Assistant asks for unnecessary private data.
- Assistant says something is saved before confirmation.
- Assistant says something was not saved when audit/workspace show it was.
- Assistant skips a step, loops to an earlier step, or mixes two steps.
- Static workflow passes but conversation is awkward, misleading, or not user-ready.

