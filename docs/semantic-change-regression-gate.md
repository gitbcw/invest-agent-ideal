# 语义变更回归门（两级）

状态：v1（2026-09-06，治理闭环 T5 / T-470）——回答 [ai-application-operating-loop.md](./ai-application-operating-loop.md) 未决问题 2「语义回归门的形态」

## 一、定位

- 程序回归门（`npm run verify`、边界测试、release 快照/known-good/回滚链、[evaluation-assets-registry.md](./evaluation-assets-registry.md) 变更门选择规则）**维持不变**；本门只补语义面：防「程序测试全绿，但用户体验或投资产出变差」的变更进入更大范围。
- 本门是**记录与放行规则**，不是新测试框架，不启用 LLM Judge，不把语义问题改造成服务端规则（服务层只接管格式类不变量，判断仍住 agent 区——见提示词改动哲学）。
- 与 [release-governance-evidence-template.md](./release-governance-evidence-template.md) 的关系：发布记录的「隔离行为评估与 Bad Case 回归」门引用本门的 SCR 结论；SCR 不替代发布记录。

## 二、触发面

变更落在以下任一面时必须出语义变更记录（SCR）：

1. Prompt / Workspace Skill / 方法表达；
2. 模型更换或模型参数、路由变化；
3. 工具发现策略、工具清单、MCP 装配变化；
4. 自动化产出格式与推送内容契约（summary、简报、表格模板）；
5. 数据方法与投资数据口径（指标定义、数据来源绑定、跨月/跨日 rollover）；
6. 涉及用户可感知产出的 Portal 交互变化。

不触发：纯内部重构、测试、文档、构建输入（无用户可感知语义面）。

## 三、两级门

| | Tier-1 非阻塞门 | Tier-2 阻塞门 |
| --- | --- | --- |
| 适用 | 低风险、可隔离、可回滚：单场景措辞、非交付路径文案、表达优化 | 涉及**权限/scope、投资数据口径、自动化推送内容契约、模型/工具边界、任务修订语义**的变更 |
| 发布前要求 | SCR 记录完整（模板见 §四） | SCR 记录完整 + 语义验证已执行且硬门槛全过 + owner 复核 |
| 失败动作 | 记录结论，下次自然 run / rubric 采样核对；复发即回滚 | **停止扩大灰度 / 自动回滚**；SCR 结论 no-go 时发布记录同门不得标 pass |
| 升级规则 | 观察窗口内出现同型 semantic FP → 升 Tier-2 补验证 | — |

判级拿不准时按 Tier-2 处理（向上兼容，不允许降级规避）。

## 四、语义变更记录模板（SCR）

```text
scr_id: SCR-YYYYMMDD-NN
date / author / linked_commit_or_task:
变更内容与影响范围:
变更面: prompt | skill | model | tool | automation_output | data_method | ui
门级: tier-1 | tier-2
受影响评估资产（EV-*）与 rubric（R*/W*）:
预期改善的 failure pattern（taxonomy_ref / BC-* / FP-*）:
语义验证方式: 确定性断言 | 回放样本 | rubric 评分 | 定向真实任务观察
观察窗口: 起止时间 + 必看信号（S1~S7、semantic FP、rubric 维度）
失败动作: 回滚 commit / 隔离 allowlist / 停止灰度
结论（四栏独立判定，不得互相替代或平均）:
  程序正确:   pass | fail   （verify、边界测试）
  语义正确:   pass | fail   （硬门槛、rubric、回放）
  性能正确:   pass | fail | n.a. （首字延迟、预算、成本）
  业务终态正确: pass | fail   （推送送达且内容实质、资产正确落库、用户可继续工作）
最终: go | go-with-isolation | no-go
复核: tier-2 需 owner；tier-1 复核可后补
```

落档：随变更走——代码变更进 commit message 引用 scr_id，Prompt/Skill 变更进对应方法文档变更记录；不另建目录。

## 五、硬性条款

1. 硬门槛（行业复盘 H1~H5、盯盘 H1~H3、安全/scope/确认/幂等/重复副作用）**不与任何均分平均**；任一命中 = 语义正确 fail，最终 no-go。
2. rubric 均分与未来 judge 总分只能作信号与排序，**不得替代确定性服务契约断言**；「模型回答看起来不错」不是任何一栏的 pass 依据。
3. 业务终态正确必须引用可定位证据（push 终态 + 内容指针、资产 version、诊断链 ID），不接受「模型说已完成」。
4. Tier-2 变更无 SCR 时：发布证据模板「隔离行为评估与 Bad Case 回归」门不得标 pass，扩大灰度自动冻结。

## 六、首例与接线

- 首个消费者：T-472（诊断链观测口径修复——微信关联键统一 + scheduler n.a. 过滤）发布时须出首份 SCR：变更面=model 相邻的观测写入侧 + automation_output 无涉；受影响资产 EV-017/EV-022/EV-034；预期改善=诊断覆盖率报告 GAP-1/GAP-2；观察窗口=发布后 7 天复测覆盖率。
- 信号联动：SCR 观察窗口内的 semantic FP / rubric fail / S7 告警即失败动作触发器（定义见 [customer-friction-signal-collection-design.md](./customer-friction-signal-collection-design.md)）。
- 复核节奏：每次治理放行复核（模板见 release-governance-evidence）清点在观察窗口内的 SCR 清单。
