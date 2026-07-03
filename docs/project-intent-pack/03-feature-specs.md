# Feature Specs

```yaml
feature_specs:
  - feature_id: F-001
    feature_name: "微信直通工作空间"
    business_goal: "让用户通过微信直接进入当前 workspace 的投资工作流。"
    user_value: "少操作、少心智负担、消息即任务。"
    must_have_behavior:
      - "仅添加最小通道上下文"
      - "把原始消息交给 workspace-scoped ACP backend，当前默认 Codex"
      - "不在服务层做普通消息意图 triage"
    success_standard:
      - "用户不需要学习路由规则"
      - "消息能稳定落到正确 workspace"
    anti_requirements:
      - "不得恢复 fast-lane / onboarding / review-intent 之类服务层分类"
    evidence:
      - source: "CLAUDE.md"
        type: doc
      - source: "docs/README.md"
        type: doc
    confidence: high

  - feature_id: F-002
    feature_name: "选股问答 -> 自选"
    business_goal: "把行业/题材/公司问题变成可筛选、可比较、可收藏的候选。"
    user_value: "减少从信息到候选的筛选成本。"
    must_have_behavior:
      - "先做行业趋势判断"
      - "再做基本面与技术面二筛"
      - "输出 3-5 个候选并附观察条件"
    success_standard:
      - "候选不是只给结论，还要给风险与观察点"
      - "用户能清楚决定是否加入自选"
    anti_requirements:
      - "不得只写看多理由"
      - "不得把低置信度内容伪装成确定结论"
    evidence:
      - source: "docs/04-core-workflows.md"
        type: doc
      - source: "docs/02-investment-methodology.md"
        type: doc
    confidence: high

  - feature_id: F-003
    feature_name: "交易策略 -> 预案两道闸门"
    business_goal: "把策略匹配与预案起草拆成两次确认，防止 AI 自主落库。"
    user_value: "策略、预案、落库三件事都可控且可追溯。"
    must_have_behavior:
      - "先推荐适用策略"
      - "用户确认后再起草预案"
      - "预案确认后才写入 stock_plans"
    success_standard:
      - "任何场景都不能跳过第一道闸门"
      - "草案只含 support/resistance/target/stopLoss/notes"
    anti_requirements:
      - "不得自动落库"
      - "不得输出仓位上限、持仓金额、持股数量、时间约束"
    evidence:
      - source: "docs/trading-strategy-design.md"
        type: doc
      - source: "AGENTS.md"
        type: doc
    confidence: high

  - feature_id: F-004
    feature_name: "复盘闭环"
    business_goal: "把日/周/月复盘变成能验证前序观点的审计循环。"
    user_value: "知道之前判断对不对，下一步该怎么修正。"
    must_have_behavior:
      - "日复盘产出观点与次日观察点"
      - "周/月复盘回看日观点和方法变化"
      - "记录命中、误报、漏报、不确定"
    success_standard:
      - "复盘能驱动后续观察和修正"
      - "观点有明确来源和验证状态"
    anti_requirements:
      - "不得只写成散文式总结"
      - "不得把历史妥协写成未来标准"
    evidence:
      - source: "docs/04-core-workflows.md"
        type: doc
      - source: "AGENTS.md"
        type: doc
    confidence: high

  - feature_id: F-005
    feature_name: "复合指标分层"
    business_goal: "让复杂指标在安全边界内可扩展。"
    user_value: "复杂判断能做，但不会污染平台与主进程。"
    must_have_behavior:
      - "优先使用标准 L1/L2 能力"
      - "必要时用 L3a 规则树"
      - "再必要时才用 L3b 沙箱脚本"
    success_standard:
      - "用户私有指标不进 SQLite"
      - "估算型能力必须显式告知"
    anti_requirements:
      - "不得使用自由 eval"
      - "不得让复杂指标拖垮巡检"
    evidence:
      - source: "docs/composite-indicator-system.md"
        type: doc
    confidence: high
```
