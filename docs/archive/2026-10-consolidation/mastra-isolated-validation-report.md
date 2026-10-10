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

备份快照安全：`scripts/mastra-backup-snapshot-test.mjs` 将灾备快照中的数据库、运行数据和显式选择的 Workspace 复制到一次性临时目录，拒绝源目录作为运行时路径，并在测试前后对源快照计算摘要，源发生变化即失败。最新完整快照 `2026-08-12T010004+0800` 的复制与完整性 smoke 已通过；未写入生产数据或备份源。

冷启动验收：使用该快照复制副本在 `23656` 启动 Mastra runtime，`/health` 返回 `ok`，trace coverage 成功读取快照历史数据；通过 Platform API 创建隔离测试实例并生成 Workspace，写入仅发生在临时 SQLite/Workspace。服务已停止，临时副本已删除；`23655` 全程保持运行。

人工验收：用户已确认 `23656` Portal 页面可正常加载并完成验收。过程中发现并修复 `view-audit.ts` 自动化审计模板的非法多行 JavaScript 字符串；修复后运营总览、质量和审计页面均可加载。该验收服务已关闭，未进入生产数据迁移或端口切换。

备份迁移验证：新增 `scripts/mastra-backup-migration-smoke.mjs`，对灾备数据库快照和 Workspace 快照复制出 source/target 临时树，在 target 写入迁移标记并比较核心表计数。快照 `2026-08-12T010004+0800` 与 Workspace `2026-08-10T235031+0800` 验证通过：users=4、ai_instances=4、conversation_sessions=103、conversation_messages=1439，source 摘要保持不变。该 smoke 不写入生产源，临时树执行后删除。

运行时边界重构：Mastra prompt context 不再向用户 Workspace 写入 `.sandbox-token`；日复盘和盘中简报 prompt 不再要求读取 `AGENTS.md`、Workspace Skills 或历史内核规则，改为服务工具权限与注入上下文。Portal 成本视图中的旧 Codex 命名已改为 Agent 中性命名。新增边界/契约测试通过。

`scripts/stage1-scheduled-tasks-smoke.mjs` 原先导入已删除的 `dist/acp/scheduled-tasks.js`，已改为 `dist/runtime/scheduled-tasks.js`。该脚本随后还暴露了两个旧假设：直接读取主用户 `schedules.yaml`，并使用共享本地数据库，无法作为隔离验收证据。业务状态机已有 73 项隔离测试覆盖；该 smoke 应在后续重构为显式 fixture/临时状态根后再纳入验收命令。

当前未开启真实微信发送、生产 scheduler、生产 push、客户灰度或生产数据迁移。
