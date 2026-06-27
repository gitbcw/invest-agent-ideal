---
name: core-company-fundamental-review
description: Analyze a company in the user's holdings or watchlist using financial reports, peer comparison, industry context, policy fit, governance checks, and the user's confirmed strategy. Use when the user asks for 公司财报分析, 财务分析, 长期持有价值, 护城河, 管理层, 同行对比, or company fundamental review.
---

# Company Fundamental Review

## Purpose

Evaluate whether a company still fits the user's investment strategy and whether any fundamental warning has appeared. This skill is generic and must not assume any built-in company list. It should use the target company requested by the user or found in `config/portfolio.yaml`.

## Inputs

- `AGENTS.md`
- `config/portfolio.yaml`
- `config/strategy.yaml`
- `config/sources.yaml`
- `config/paths.yaml`
- `config/evidence_policy.yaml`
- `config/risk_taxonomy.yaml`
- `config/decision_policy.yaml`
- `knowledge/decision_protocol.md`
- `knowledge/methods/fundamental.md`
- `knowledge/methods/macro.md`
- `knowledge/methods/risk.md`
- Financial files under `financials/companies/<code>/` when available

## Workflow

1. Resolve the target company name and code from the user request, holdings, or watchlist.
2. Inspect `financials/companies/<code>/` for annual, interim, and quarterly reports.
3. Prefer official reports and primary disclosures. Use secondary data only for cross-checking. If official reports are missing, downgrade confidence and produce a "待验证风险清单" instead of a definitive financial conclusion.
4. Build a multi-year financial table using metrics relevant to the company type.
5. Compare strategy promises with later execution when historical reports are available.
6. Select relevant peers and compare growth, profitability, cash flow, balance sheet quality, moat, valuation, and risk.
7. Check governance, regulatory, disclosure, financing, dilution, safety, environmental, and reputational risks.
8. Build a WeChat-friendly fundamental warning card first, then the full fundamental warning section. Cover revenue/profit quality, cash flow, leverage, inventory or asset quality, capital expenditure, dividend/buyback sustainability, governance, policy, and industry-cycle risks.
9. Connect the company analysis to the user's actual position, target weight, buy/sell rules, and risk limits; distinguish analysis-only, rule-near-trigger, rule-triggered, and risk-override conclusions.
10. Save the report to `reports/company/YYYY-MM-DD-<code>-<name>.md`.
11. If the analysis suggests changing strategy or role, ask for user confirmation before modifying memory or config.

## Report Structure

```markdown
# 公司名称财务与长期持有检验报告

> 生成日期：
> 股票代码：
> 财报目录：

## 一、最终结论

## 二、基本面预警卡片

| 项目 | 状态 | 说明 |
| :--- | :--- | :--- |
| 收入/利润质量 | 正常/关注/预警 |  |
| 现金流 | 正常/关注/预警 |  |
| 资产负债 | 正常/关注/预警 |  |
| 库存或资产质量 | 正常/关注/预警 |  |
| 资本开支 | 正常/关注/预警 |  |
| 分红/回购可持续性 | 正常/关注/预警 |  |
| 治理与声誉 | 正常/关注/预警 |  |
| 政策和行业周期 | 正常/关注/预警 |  |

## 三、资料来源与覆盖范围
## 四、近多年财务横向对比
## 五、战略方向与承诺兑现
## 六、经营质量分析
## 七、同行对比
## 八、护城河与治理检查
## 九、基本面预警

| 预警项 | 当前状态 | 证据 | 严重程度 | 对持仓影响 | 后续验证点 |
| :--- | :--- | :--- | :--- | :--- | :--- |

## 十、行业周期、政策和国际环境
## 十一、结合用户持仓的操作指引
## 十二、后续跟踪清单
## 十三、备注
```

## Style Rules

- Write in Chinese.
- Do not force a bullish conclusion because the company is held.
- Do not invent missing financial data.
- Cite or record sources.
- Separate facts, inference, and uncertainty.
- Clearly separate company quality, valuation, and position sizing.
- Always include fundamental warnings, even if the conclusion is that no material warning is currently found.
