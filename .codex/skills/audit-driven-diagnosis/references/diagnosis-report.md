# Diagnosis Report Structure

Use this structure for a range-level report. Keep raw payloads out of the document; link to queryable IDs or bounded evidence excerpts instead.

## 1. Scope

- `start` / `end` and timezone
- environment and release/restart window, if relevant
- user/instance/conversation/workflow filters
- evidence sources inspected and sources unavailable
- diagnostic question and comparison baseline

## 2. Summary

- cases inspected and candidate anomalies
- confirmed, probable, unknown, normal, and standards-gap counts
- problem-cluster count
- highest severity and affected scope
- one-sentence conclusion: confirmed defect, suspected defect, no confirmed defect, or insufficient evidence

## 3. Problem Cluster

Repeat for each cluster:

```markdown
### P-001 Short problem title

- Severity: P0/P1/P2/P3
- Root-cause status: confirmed | probable | unknown
- Ownership layer: service | Skill/prompt | deterministic contract | config/data | operations | documentation
- Affected scope: users, instances, workflows, and count
- Linked cases: C-001, C-004
- Failure stage: input | orchestration | tool/service | persistence | scheduler | delivery | unknown
- Applicable standard: contract/rule reference, or `not defined`
- Observed facts: ...
- Diagnosis: ...
- Supporting evidence: IDs, timestamps, and short excerpts
- Missing evidence / disconfirming checks: ...
- Recommended remediation: one bounded action
- Verification: exact rerun, test, query, or acceptance check
```

## 4. Case Appendix

For each case, retain:

- case ID, user/instance/conversation ID, and timestamp
- user intent and concise observed result
- expected result and its source, or explicitly `unknown`
- linked problem cluster(s)
- evidence references
- classification and disposition

## 5. Human Review Queue

List each item as one of:

- `accept diagnosis`
- `reject diagnosis`
- `request more evidence`
- `define or clarify standard`
- `authorize remediation`

Do not mark a remediation as complete merely because a recommendation was written.
