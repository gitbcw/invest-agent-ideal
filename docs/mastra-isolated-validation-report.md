# Mastra 隔离验证报告

日期：2026-08-12

## 结果摘要

| 范围 | 结果 |
| --- | --- |
| 迁移分支全套测试 | 397 passed, 0 failed |
| 正式 Portal 仓库测试 | 43 passed, 0 failed |
| Mastra facade/model snapshot tests | 9 passed, 0 failed |
| 微信、scheduler、automation、push 相关测试 | 73 passed, 0 failed |
| Portal conversation smoke | passed |
| 23655 health/real Mastra turn | passed earlier; service remains isolated |

## 已验证行为

- 微信 inbound 幂等、长任务等待、发送协议和失败分类。
- scheduler task lease、review policy、market-watch `NO_PUSH`、push queue retry/expiry/idempotency。
- automation task lifecycle、Portal automation contract、XLSX staging/output、失败重试和 delivery 状态。
- Portal conversation cancellation、restart reconciliation、scope protection。
- Mastra Agent 每回合读取模型配置；配置变更只影响后续 Agent，不改变已创建回合。
- trace correlation fields and redacted neutral audit data.

## 发现与后续

`scripts/stage1-scheduled-tasks-smoke.mjs` 原先导入已删除的 `dist/acp/scheduled-tasks.js`，已改为 `dist/runtime/scheduled-tasks.js`。该脚本随后还暴露了两个旧假设：直接读取主用户 `schedules.yaml`，并使用共享本地数据库，无法作为隔离验收证据。业务状态机已有 73 项隔离测试覆盖；该 smoke 应在后续重构为显式 fixture/临时状态根后再纳入验收命令。

当前未开启真实微信发送、生产 scheduler、生产 push、客户灰度或生产数据迁移。
