# 用户产物库与通用自动化任务执行日志

来源计划：[user-asset-library-and-general-automation-tasks.md](./user-asset-library-and-general-automation-tasks.md)
设计依据：[user-asset-library-and-general-automation-design.md](./user-asset-library-and-general-automation-design.md)
开始日期：2026-08-05（Asia/Shanghai）

## 执行边界

- 本地隔离数据、`data/test-*` 和测试 Workspace 是唯一执行与验收数据源。
- 不修改生产数据库、真实 Workspace、`.env`、微信状态或生产运行时。
- 保留工作树中已有的用户改动；不回滚无关文件。
- `main` 是发布基线；数据库只采用 additive migration。
- 当前交付同时包含 Runtime 和隔离 Portal 仓库的资产库/自动化 UI；生产发布仍需按协议合同和授权 connector scope 逐项验证，不以本地开发服务替代生产验收。

## 初始状态

- 已阅读 `AGENTS.md`、项目文档索引、资产库设计、任务文档、Portal 协议、系统概览、数据库 ownership、服务 API 变更和数据库迁移技能要求。
- 当前已有 `conversation_artifacts` 虚拟 artifact library、旧 `automation_task_assets` 表格自动化和独立 automation runner；这些兼容面不得被新资产库替换或删除。
- 工作树存在用户未提交的自动化默认时区、connector scope 和合同测试改动，保持原样并在集成时兼容。
- `claude` CLI 可用，但执行工作优先按 WP 拆分到明确责任范围；任何外部执行摘要都必须由主 Agent 独立复核。

## WP 进度

| WP | 状态 | 证据/备注 |
| --- | --- | --- |
| WP0 | 已完成 | `user-asset-library-contract.md` 与 WP0 移交笔记已冻结；主 Agent 复核通过 |
| WP1 | 已完成 | additive schema、受控版本存储、生命周期审计和隔离测试 |
| WP2 | 已完成 | MCP 资产读写、artifact 关联、确认和路径边界 |
| WP3 | 已完成 | `asset.*` connector/API 合同、scope 和错误映射测试 |
| WP4 | 已完成（有保留） | 隔离 Portal 资产库 UI、上传/预览/重命名和桌面/移动检查；下载事件与多版本恢复需补 browser smoke |
| WP5 | 已完成 | 通用输出/投递策略、无资产任务、资产绑定和 immutable revision |
| WP6 | 已完成 | 结构化 ACP runner、原子版本提交、lease/锁、幂等和投递回写 |
| WP7 | 已完成 | 旧表格兼容、逐任务备份迁移、paused revision、审计和跨 scope 拒绝 |
| WP8 | 已完成（Pass with caveats） | Runtime/Portal 全量验证、隔离 connector、浏览器核心流程、发布/回退清单；见验收报告 |

## 验证记录

后续按阶段追加命令、结果、失败原因和验收证据。任何涉及生产或真实 Workspace 的操作均不在本任务授权范围内。

## 2026-08-05：实现与 WP8 验收

- Runtime `npm run verify` 通过：381 tests / 17 suites、agent-context check、TypeScript build、7 个 boundary suites。
- Portal `npm test` 通过：20/20；`npm run typecheck` 通过；`npm run build` 通过并生成 `/assets`、`/api/assets/*` 和 `/automations`。
- WP1-WP3：资产表、版本服务、生命周期审计、MCP、connector、Portal API、三元 scope 和错误映射完成；`tests/user-assets*.test.ts` 与 `tests/automation-portal-contract.test.ts` 覆盖跨 scope、非法输入、幂等和路径边界。
- WP4：隔离 Portal 浏览器检查完成桌面空状态、Markdown 上传 v1、版本时间线/预览、重命名、自动化页面和 `390x844` 移动无水平溢出检查。下载未产生可捕获 browser download event，多版本恢复未在 UI 现场完成；二者有服务/合同测试证据，列为 P2 follow-up。
- WP5-WP7：无资产推送、Markdown create、CSV/XLSX update、结构化输出、失败不提交、推送独立回写、task mutex/lease、旧任务迁移/备份/暂停/审计均通过测试。
- 隔离 Portal/Relay 进程、浏览器页和临时 Portal 数据库已清理；未触碰 Runtime `22655` 或生产/真实用户状态。
- 独立验收报告：[`user-asset-library-and-general-automation_acceptance_review.md`](./user-asset-library-and-general-automation_acceptance_review.md)。

## 发布与回退清单

- [x] 代码构建、Runtime/Portal 测试、类型检查和边界检查通过。
- [x] additive migration 可重复执行；不删除旧表、旧字段或旧任务文件。
- [x] 旧 `conversation_artifacts`、`automation_task_assets` 和未迁移任务保留兼容路径。
- [x] connector scope、资产版本提交、运行 lease、投递状态和审计均由服务强制。
- [ ] 发布前补隔离浏览器下载和历史版本恢复 smoke。
- [ ] 发布前备份生产 SQLite，并用授权测试账号做只读 health/connector probe。
- [ ] 生产发布后观察 delivery 独立重试；投递失败只重试 delivery，不重新执行 ACP/生成版本。
- [ ] 回退代码时保留已应用 additive migration；不得删除新资产版本、回拨历史 head 或批量迁移真实任务。

## 2026-08-05：WP0 完成

- 契约版本：`asset-automation-v1`。
- 已冻结资产/version/task/run descriptor、三元 scope、格式/MIME/大小矩阵、错误码、提交/恢复/归档/idempotency/lease 语义。
- 已写兼容矩阵：`conversation_artifacts`、`automation_task_assets`、Workspace 文件协议、旧 Portal artifact 路由和复盘契约保持兼容。
- 明确首期不支持任意二进制更新、文件夹移动、物理删除、共享/云盘/webhook；PDF 降级为下载保证。
