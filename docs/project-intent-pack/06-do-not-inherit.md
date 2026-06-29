# Do Not Inherit

```yaml
do_not_inherit:
  - item: "服务层普通消息 triage / fast-lane / onboarding 包装"
    reason: "与当前直通 workspace Hermes 的主链路冲突。"
    risk_if_inherited: "把产品重新做复杂，削弱工作空间自治。"
    confidence: high
  - item: "Codex 作为 invest-agent 运行时 backend"
    reason: "当前统一 backend 已明确收敛为 Hermes stdio ACP。"
    risk_if_inherited: "制造不一致的 runtime 语义。"
    confidence: high
  - item: "把历史表和旧实现直接当成未来业务结构"
    reason: "旧表中有大量兼容、考古和过渡性内容。"
    risk_if_inherited: "污染新模型和新工作流。"
    confidence: medium
  - item: "自动迭代策略或自动落库预案"
    reason: "越过用户决策边界。"
    risk_if_inherited: "让 AI 替用户做策略决定。"
    confidence: high
  - item: "把 profile 变成方法载体"
    reason: "当前定位已收敛为兼容摘要/路由残留。"
    risk_if_inherited: "方法责任再次散落。"
    confidence: high
```
