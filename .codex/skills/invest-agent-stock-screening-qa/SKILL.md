---
name: invest-agent-stock-screening-qa
description: Answer Invest Agent stock screening and stock-research questions using a skill-driven workflow. Use when the user asks broad or fragmentary questions about industries, concepts, themes, sectors, candidate stocks, company value, fundamentals, financial quality, competitive position, moat, valuation, technical timing, whether a stock is worth watching, risks, drawdown, margin of safety, watchlist conversion, 行业选股, 概念股筛选, 题材分析, 候选股, 龙头, 护城河, 技术位置, 能不能观察, 值不值得关注, 风险评估, or 加入自选建议. This skill should decide internally which sub-skill modules are relevant; runtime code should not keyword-route these questions.
---

# Invest Agent Stock Screening QA

## Purpose

Generate a structured Chinese screening report for an industry, concept, theme, or investment question. The report should make it easy to convert candidates into watchlist entries with clear observation conditions.

This is the orchestration skill. Runtime code should collect deterministic context, while this skill decides which sub-skills to invoke and how to merge their judgments.

## Required Context

Read first:

1. `AGENTS.md`
2. `docs/02-investment-methodology.md`
3. `docs/04-core-workflows.md`
4. Existing `src/handlers/screening.ts` for current behavior

Then use these local sub-skills as needed:

- `.codex/skills/invest-agent-industry-outlook-analysis/SKILL.md`
- `.codex/skills/invest-agent-company-value-analysis/SKILL.md`
- `.codex/skills/invest-agent-competitive-moat-analysis/SKILL.md`
- `.codex/skills/invest-agent-technical-entry-analysis/SKILL.md`
- `.codex/skills/invest-agent-risk-assessment/SKILL.md`

Use available deterministic data when provided:

- Existing holdings and watchlist.
- Stock resolver results.
- Market quotes and technical indicators.
- Capital flow data when available.
- News/announcement/research snippets when available.

## Workflow

1. Classify the user's real intent first:
   - Industry outlook question.
   - Candidate discovery question.
   - Single-company value question.
   - Company comparison question.
   - Technical timing question.
   - Risk-only question.
   - Watchlist conversion question.
   - Full screening request.

2. Choose the smallest useful module set:
   - Do not force a full investment-model report when the user only asks one slice.
   - If one module can answer the question, use one module and end with clear next-step options.
   - If the question is broad, use the full orchestration flow.

3. Clarify the user's target when necessary:
   - Industry, concept, theme, company comparison, or portfolio gap.
   - Time horizon: short observation, swing, or long-term watch.
   - If ambiguity blocks a useful answer, ask one short question.
   - If ambiguity does not block the answer, state assumptions rather than pretending certainty.

4. Run the industry-outlook step when the question involves an industry, theme, concept, policy, or initial candidate discovery:
   - Policy support.
   - Market size and growth stage.
   - Technology route.
   - Supply-chain position.
   - Competitive landscape.
   - Key validation signals.

5. Initial screen when the user asks for candidates:
   - List 5-10 related companies when possible.
   - For each: code, name, business linkage, reason for inclusion, uncertainty.
   - Do not invent exact financial numbers.

6. For the 3-5 shortlisted candidates, run only the modular passes that match the question:
   - Company value pass.
   - Competitive-moat pass.
   - Technical-entry pass.
   - Risk-assessment pass.

7. Second screen merge for broad screening requests:
   - Select 3-5 candidates based on:
     - Business relevance.
     - Fundamental quality.
     - Competitive position.
     - Technical position.
     - Valuation/risk if data is available.
     - Existing holdings/watchlist overlap.

8. Watchlist conversion:
   - For each candidate, give observation conditions.
   - State whether it is suitable for watchlist now, wait for pullback, or only background tracking.
   - Provide a short reason string that can be saved as watchlist source/reason.

9. Data limits:
   - Explicitly disclose missing sources, especially real-time financials, chip concentration, intraday tape, or direct main-force control data.

## Intent Router

Use this router before writing the answer:

| Customer question shape | Use modules | Answer shape |
| :--- | :--- | :--- |
| “这个行业怎么样 / 这个方向还有空间吗” | Industry outlook | 结论 + 事实/推断/风险 + 后续可筛哪些公司 |
| “这个题材有哪些票 / 帮我找几个候选” | Industry outlook + initial screen + risk skim | 5-10 初筛 + 3-5 观察候选 |
| “某公司怎么样 / 值不值得关注” | Company value + moat + risk, optionally technical | 公司是否值得观察 + 短板 + 观察条件 |
| “A 和 B 哪个更好” | Company value + moat + risk + optional technical | 对比结论 + 分项胜负 + 适合谁进入自选 |
| “现在能不能买/观察/追” | Technical entry + risk | 只回答位置、条件、风险，不补完整行业报告 |
| “最大风险是什么 / 会不会回撤很大” | Risk assessment | 风险来源 + 回避条件 + 需要验证的数据 |
| “加入自选吗” | Relevant previous modules + watchlist conversion | 建议/暂缓/仅背景跟踪 + 保存理由 |
| “完整选股/帮我筛一个方向” | Full orchestration | 行业 -> 初筛 -> 精选 -> 技术/风险 -> 自选建议 |

## Customer Experience Rules

- Match the user's granularity. A narrow question deserves a narrow, high-signal answer.
- Start with the answer, then give evidence. Do not make the customer wait through the full framework before seeing the conclusion.
- For casual WeChat questions, avoid tables unless they clarify comparison; use short sections and bullet lists.
- If the customer asks a fragment, end with 1-2 natural follow-up choices, such as “要不要我继续筛 3 个候选？” or “要不要我再看技术位置？”
- Never expose skill names, file paths, local APIs, or internal module routing in the customer-facing response.
- Never expose localhost, port numbers, curl commands, API paths, Codex/ACP, logs, stack traces, or internal service/component names in the customer-facing response.
- Preserve the investment model internally, but do not force the customer to speak in that model.

## Terminology And State Boundaries

- The system has only two persistent stock pools:
  - `持仓池`: stocks the user currently holds or marks as held.
  - `自选池`: stocks the user wants to track or observe.
- Do not introduce a third persistent pool such as “观察池”.
- It is okay to say “观察候选” or “建议观察”, but if a stock is saved, say “加入自选池” or “已在自选池”.
- If the user says “放到观察池”, interpret it as “加入自选池” and reply using 自选池 terminology.
- For current state, use the actual service result. Do not guess the number of holdings or watchlist items.
- Do not claim the service was restarted, unresponsive, repaired, or checked unless the actual service/API response proves it.
- If an API call fails or times out, say the action did not complete and ask the user whether to retry; do not narrate imaginary recovery steps.

## Recommended Invocation Pattern

When the user asks a broad screening question, structure the answer in this order:

1. Theme judgment from `invest-agent-industry-outlook-analysis`.
2. Candidate-company shortlist.
3. For each finalist:
   - `invest-agent-company-value-analysis`
   - `invest-agent-competitive-moat-analysis`
   - `invest-agent-technical-entry-analysis`
   - `invest-agent-risk-assessment`
4. Merge into one final watchlist-ready conclusion.

When the user asks a narrower question, use fewer modules:

- Industry/theme only: industry-outlook first.
- Company comparison: company-value + moat + risk.
- “现在能不能观察”: technical-entry + risk.
- Risk-only: risk-assessment only.
- Watchlist decision: use the minimum modules needed to justify “加入/暂缓/背景跟踪”.

## Report Structure

```markdown
# 选股问答：主题

## 一、结论摘要

- 最值得进入自选观察：
- 暂不建议追的方向：
- 最大风险：

## 二、行业/主题判断

- 事实：
- 推断：
- 风险：
- 关键验证点：

## 三、初筛公司

| 公司 | 代码 | 业务关联 | 初筛理由 | 主要不确定性 |
| :--- | :--- | :--- | :--- | :--- |

## 四、精选候选

| 公司 | 代码 | 入选理由 | 风险点 | 观察条件 | 自选建议 |
| :--- | :--- | :--- | :--- | :--- | :--- |

## 五、与当前持仓/自选的关系

- 是否补足组合盲区：
- 是否与已有标的重复：
- 是否会放大同一类风险：

## 六、加入自选建议

| 公司 | 代码 | 建议 | 保存理由 | 后续验证点 |
| :--- | :--- | :--- | :--- | :--- |

## 七、数据来源与缺口

- 已使用数据：
- 缺失数据：
- 本报告仅作研究辅助，不构成收益承诺。
```

## Quality Rules

- The answer should be usable without being overconfident.
- Separate "can observe" from "can buy".
- Do not recommend adding too many candidates.
- A candidate without observation conditions is not a finished screening result.
- If the user wants to add candidates to the watchlist, the runtime should use deterministic watchlist tools after confirmation.
- Customer-facing wording must use 自选池/自选股 for saved watchlist items, never 观察池.
