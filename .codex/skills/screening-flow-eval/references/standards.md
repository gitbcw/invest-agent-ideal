# Screening Flow Standards

## Product Boundary

Screening builds a trackable observation pool. It does not issue a "buy now" recommendation, promise returns, or pretend to scan the entire market when the available data does not support that claim.

Each candidate needs a code, source reason, style fit, risk flags, waiting conditions, and a status. A candidate is not an investment conclusion.

## Required Quality

- Start from the user's question, market scope, investment model, and stated constraints.
- Distinguish facts, inferences, missing data, and time-sensitive market evidence.
- Explain why each candidate entered, why alternatives were excluded or remain uncertain, and what would invalidate the observation.
- Include financial, valuation, governance, liquidity, theme-crowding, and style-fit risk where evidence is available; state gaps rather than inventing a scan.
- Turn direct-buy requests into an observation-pool draft with waiting conditions.
- Treat custom criteria as binding inputs. Ask for clarification when they cannot be converted into a defensible screen.
- Use user-visible language, never service paths, tokens, workspace paths, ACP internals, or model diagnostics.

## Write Boundary

- Observation-pool changes require a structured draft and explicit user confirmation.
- Adding a selected candidate to watchlist requires the service-owned `watchlist.add` confirmation and audit.
- Do not claim a candidate was saved unless the corresponding durable state or audit proves it.

## Evidence Boundary

- Market facts require source and fetched/market time when available.
- Public news, research, and theme labels are supporting evidence, not a standalone basis for a buy conclusion.
- Current data does not provide a complete all-market constituent/factor screen. Describe the result as a researched candidate set or observation-pool draft, not a whole-market ranking.

## Remediation Boundary

- Workspace/template/selection-prompt cause: report only. Do not edit those files during the evaluation task.
- Service data source, deterministic write contract, runtime context injection/routing, or customer-output cause: repair, verify, and report in the same task.
