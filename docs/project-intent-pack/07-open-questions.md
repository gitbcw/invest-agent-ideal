# Open Questions

```yaml
open_questions:
  - question: "investment_model 与 trading_strategy 的最终主从关系是否会升级为 model -> plan 的唯一入口？"
    reason: "当前文档已提出方向，但仍在渐进演进中。"
    risk: "如果时机未到，过早重构会扰动现有预案链路。"
    status: inferred
  - question: "复盘如何系统性反哺模型而不越过用户意志？"
    reason: "当前明确不让复盘直接反哺策略本体，但模型层闭环仍未完全定型。"
    risk: "规则过松会污染方法，过严会失去学习能力。"
    status: unverified
  - question: "旧 SQLite 残留表的最终清理节奏是否仍按当前迁移文档执行？"
    reason: "文档显示有保留期和冻结期，但实际收口依赖后续执行。"
    risk: "过早清理影响回退，过晚保留增加维护噪声。"
    status: conflicting
```
