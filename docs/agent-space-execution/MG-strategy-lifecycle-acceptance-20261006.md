# MG 策略改进生命周期验收

日期：2026-10-06  
范围：单个策略候选的草案、确认、采用、回读与失败补偿  
环境：隔离 SQLite / Workspace fixture；不接触 MG 真实 Workspace、不发送微信

## 结论

状态：`Pass`（隔离闭环）；生产/真实 MG 仍未执行写入验收。

服务层已经证明候选可以安全地从草案进入正式策略，保存不可变版本，并在用户确认后把旧版本恢复为新的当前版本；失败时会恢复旧策略。

## 已验证

执行：

```text
node --import tsx --test tests/method-change-apply.test.ts tests/run-diagnostic-chain.test.ts
```

结果：3/3 通过。

覆盖证据：

- `method_changes.propose` 只创建 `proposed` 候选，不改变当前策略。
- `confirmations.request(method_changes.apply)` 生成精确绑定的采用预览。
- 没有后续用户确认时，采用被拒绝。
- 修改确认 payload 后，绑定校验拒绝篡改内容。
- 用户确认后，`method_changes.apply` 写入策略投影并回读校验。
- 候选状态变为 `confirmed`，审计记录与诊断链可关联。
- 重复消费同一 confirmation 被拒绝；已确认候选不能重复采用。
- 当前策略 revision 变化后，旧草案被拒绝，pending confirmation 保留。
- 候选决策失败时，策略恢复到采用前内容，候选保持 `proposed`，confirmation 保持可重试。
- `strategy.versions.read` 可按 scope 读取当前版本指针和不可变版本列表。
- `strategy.rollback` 通过独立确认门选择旧版本，回滚后生成新的 `rollback` 版本并回读当前指针。

## 当前 MG 三闭环总状态

| 闭环 | 状态 |
| --- | --- |
| 全持仓真实筛选与批量行情 | Pass with caveats |
| 可靠性分层与失败降级 | Pass with caveats |
| 策略候选采用、回读与失败补偿 | Pass |
| 成功采用后的用户主动版本回滚 | Pass（隔离验证） |

本记录不改变任何正式策略或用户资产。生产 rollout 仍需单独备份、维护窗口和只读验证，不在本任务执行。
