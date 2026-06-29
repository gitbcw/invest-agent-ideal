# Lessons and Tradeoffs

```yaml
lessons_and_tradeoffs:
  - lesson_id: L-001
    topic: "代码不是需求"
    ideal_standard: "需求应该来自业务目标和验证过的场景。"
    real_world_collision:
      - "旧代码里会混入临时补丁、历史残留和 AI 生成推测。"
    decision_made:
      - "只保留有业务证据的内容。"
      - "低置信度内容必须显式标注。"
    taste_or_principle:
      - "宁可不完整，也不要把幻觉写成规格。"
    future_guidance:
      - "凡是只在代码里出现、却没有文档/测试/用户说明支撑的逻辑，默认降级。"
    confidence: high

  - lesson_id: L-002
    topic: "工作空间是方法载体"
    ideal_standard: "用户的投资方法和策略应该沉淀在 workspace。"
    real_world_collision:
      - "服务层过度承载后，方法会和平台实现纠缠。"
    decision_made:
      - "服务做确定性执行，skills 负责方法与判断。"
    taste_or_principle:
      - "机器房和操作手册分开。"
    future_guidance:
      - "后续新方法优先放 workspace 资产，而不是代码常量。"
    confidence: high

  - lesson_id: L-003
    topic: "策略与预案必须分闸"
    ideal_standard: "策略是上下文，预案是一次决策草案。"
    real_world_collision:
      - "AI 很容易把策略理解成可直接执行的答案。"
    decision_made:
      - "先确认策略匹配，再确认预案草案。"
      - "不自动落库。"
    taste_or_principle:
      - "让用户保留最后一道确定权。"
    future_guidance:
      - "任何会改变用户交易决策的输出，都应保留确认门。"
    confidence: high
```
