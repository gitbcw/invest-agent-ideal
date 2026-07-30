# Onboarding 草稿确认与统一提交当前契约

本文件描述已实现的 Onboarding 草稿状态机与提交不变量。历史设计、实施阶段、风险清单和交接提示见
[`archive/onboarding-draft-commit-design-pre-consolidation-2026-07-28.md`](./archive/onboarding-draft-commit-design-pre-consolidation-2026-07-28.md)。

## 核心原则

Onboarding 先收集并逐步确认草稿，最后冻结一个完整快照统一提交。对话中的临时答案不是正式 Workspace 状态；只有完成确认和 commit 的快照才会写入正式配置。

## 状态模型

草稿状态：

```text
collecting -> ready_to_commit -> queued -> applying -> completed
     ^               |                       |
     |               +------ retry ---------+
     +-- failed_retryable

collecting / ready_to_commit / failed_retryable -> cancelled
```

实现中的状态集合为：

- `collecting`
- `ready_to_commit`
- `queued`
- `applying`
- `completed`
- `failed_retryable`
- `cancelled`

步骤顺序为：

1. `portfolio`
2. `style`
3. `review_schedule`
4. `market_watch_schedule`
5. `notification`
6. `watch_rules`

步骤状态为 `drafted`、`awaiting_confirmation`、`accepted`、`superseded`、`skipped`。`watch_rules` 可以由用户明确跳过；其他步骤必须被接受后草稿才能进入 `ready_to_commit`。

## 确认契约

每个步骤的确认必须：

- 绑定 user、project、instance、conversation；
- 绑定 draft、step、revision 和规范化 payload；
- 在请求确认之后的用户轮次明确给出；
- 未过期且未被消费、取消或 supersede。

修改已确认步骤会产生新 revision，并使旧 confirmation 失效。不能把同一轮的肯定措辞当成确认，也不能把一个步骤的确认用于另一个步骤或最终提交。

## 统一提交

进入提交时，服务层冻结 `{ revision, steps }` 快照并生成稳定 `commitKey`。`queued` 或 `applying` 状态不允许继续修改草稿。

提交器：

1. 使用资源 mutation lock 串行化同一实例的相关写入。
2. 只读取冻结快照，不读取之后的对话内容。
3. 合并并写入核心 Workspace 配置。
4. 幂等创建已确认的 watch rules。
5. 完成正式 onboarding state。
6. 将完成通知作为独立、幂等的投递步骤处理。

失效 lease 可以被重新领取；失败进入 `failed_retryable`，最多尝试 3 次。部分成功后的重试必须依靠相同 `commitKey` 和幂等写入收敛，不能重复创建规则或通知。

## 所有权与审计

- `onboarding_drafts` 与待确认记录由服务层持久化。
- 正式用户配置仍按 [`table-ownership.md`](./table-ownership.md) 和 Workspace 所有权规则落盘。
- MCP 服务工具负责向 Workspace ACP 暴露状态机操作；Skill 负责提问与解释，不自行模拟提交完成。
- 成功、失败、取消和确认消费必须可从数据库、conversation log、sandbox audit 与 push job 追溯。

## 权威实现

- `src/services/onboarding-drafts.ts`
- `src/services/onboarding.ts`
- `src/mcp/service-tools-core.ts`
- `src/lib/sandbox-confirmation.ts`
- `src/services/resource-mutation-lock.ts`
- `src/db/schema.ts`

## 验证

```bash
npm run smoke:onboarding-confirm-step
npm run smoke:onboarding-draft-commit
npm run verify
```

关键回归还包括 `tests/onboarding-context-order.test.ts`、`tests/onboarding-contract.test.ts` 和 `tests/onboarding-watch-setup-completion.test.ts`。
