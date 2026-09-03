# 用户产物库与通用自动化验收报告

验收依据：[`user-asset-library-and-general-automation-tasks.md`](./user-asset-library-and-general-automation-tasks.md)、[`user-asset-library-and-general-automation-design.md`](./user-asset-library-and-general-automation-design.md) 及 WP0 契约。

验收日期：2026-08-05（Asia/Shanghai）

## Acceptance Verdict

状态：**Pass with caveats**

Runtime、Portal、MCP/connector、资产版本服务、通用自动化 runner、投递状态回写和旧任务迁移均已实现，并通过全量自动验证。隔离 Portal 的桌面/移动浏览器检查也已完成资产库空状态、上传、版本预览、重命名和通用任务编辑器核心控件。没有发现跨 scope、失败推进版本、重复运行推进版本或错误推送的 P0/P1 阻断。

仍有两个非阻断验收缺口：本次 in-app browser 点击下载未产生可捕获的 download event，且没有在 UI 中构造第二个历史版本后完成恢复确认。下载路由、版本恢复和失败语义由 Runtime/connector 合同测试覆盖，但上线前仍应补一次真实浏览器下载与恢复 smoke。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| WP0 | 契约、格式/MIME/大小矩阵、兼容矩阵和错误码冻结 | Pass | [`user-asset-library-contract.md`](./user-asset-library-contract.md)、[`user-asset-library-wp0-handoff.md`](./user-asset-library-wp0-handoff.md) | `asset-automation-v1` 契约已冻结，明确排除格式和旧对象兼容边界。 |
| WP1 | additive schema、三元 scope、受控 staging、checksum、不可变版本和失败回滚 | Pass | [`src/db/schema.ts`](../src/db/schema.ts)、[`src/db/index.ts`](../src/db/index.ts)、[`src/services/user-assets.ts`](../src/services/user-assets.ts)、`tests/user-assets.test.ts` | 全量测试覆盖建表幂等、scope、格式/MIME、symlink、checksum、幂等、head 冲突、restore 和 archive。 |
| WP2 | MCP 资产读/提交/对话保存，普通对话确认边界和 artifact 关联 | Pass | [`src/mcp/service-tools-core.ts`](../src/mcp/service-tools-core.ts)、[`tests/user-assets-mcp.test.ts`](../tests/user-assets-mcp.test.ts)、[`src/services/conversation-artifacts.ts`](../src/services/conversation-artifacts.ts) | MCP 工具不接收绝对路径；长期写入绑定当前 turn/run 或确认上下文。 |
| WP3 | `asset.*` connector、Portal API、注册 scope 和错误映射 | Pass | [`src/portal/connector.ts`](../src/portal/connector.ts)、Portal `src/app/api/assets/`、`tests/user-assets-portal-contract.test.ts` | 请求不能声明 scope；浏览器响应不暴露 user/project/instance 或物理路径。 |
| WP4 | 资产库列表、空状态、上传、预览、版本时间线、重命名、归档、下载、恢复入口 | Partial | Portal `src/app/assets/page.tsx`、`src/components/assets/AssetLibraryShell.tsx`（旧 invest-agent-portal 仓库，不在本仓内）、隔离浏览器桌面/390x844 | 浏览器已实际完成空状态、Markdown 上传 v1、版本预览和重命名；下载事件未被浏览器控制层捕获，恢复需要第二版本，均由自动合同测试覆盖。 |
| WP5 | 通用任务 `none/create/update`、可选输入资产、北京时间和 immutable revision | Pass | [`src/services/automation-tasks.ts`](../src/services/automation-tasks.ts)、[`src/services/generic-automation-runner.ts`](../src/services/generic-automation-runner.ts)、Portal `src/components/automation/AutomationShell.tsx`（旧 invest-agent-portal 仓库，不在本仓内）、`tests/automation-generic-tasks.test.ts` | 自动化测试覆盖无资产推送、Markdown 创建、CSV 更新目标、非法绑定和 revision 重新暂停；浏览器检查确认编辑器提供三种输出模式。 |
| WP6 | ACP 结构化输出、资产提交/run 成功原子闭环、lease/锁、幂等和独立投递重试 | Pass | [`src/services/generic-automation-runner.ts`](../src/services/generic-automation-runner.ts)、[`src/services/push-queue.ts`](../src/services/push-queue.ts)、`tests/automation-generic-tasks.test.ts`、`tests/automation-scheduler-reliability.test.ts` | ACP 失败、非法输出、版本冲突、重复 push、任务 busy、lease recovery 均有通过证据；推送状态会回写 run。 |
| WP7 | 旧 CSV/XLSX 兼容、逐任务备份迁移、paused 新 revision 和失败回退 | Pass | [`src/services/automation-task-migration.ts`](../src/services/automation-task-migration.ts)、`tests/automation-task-migration.test.ts`、`tests/automation-tasks.test.ts` | fixture 覆盖迁移、备份、绑定、暂停、审计和跨 scope 拒绝；未迁移旧任务路径保留。 |
| WP8 | 跨仓库测试、隔离 scope、故障注入、浏览器检查和发布/回退准备 | Pass with caveats | 下方验证记录；本报告；[`user-asset-library-and-general-automation_execution_log.md`](./user-asset-library-and-general-automation_execution_log.md) | 自动证据完整；浏览器下载/恢复仍需上线前补 smoke。 |

## Findings

1. **[P2] 浏览器下载事件未捕获。** 在隔离 Portal 产物详情中点击“下载”后，页面 URL 不变、无 console error，但 in-app browser 没有产生可捕获的 `download` event。Runtime 版本读取/下载合同和 Portal 构建均通过；需要在发布前用真实浏览器保存结果确认下载字节、文件名和 checksum。

2. **[P2] UI 恢复流程未完成端到端浏览器操作。** 本次上传只有 v1，无法在 UI 中选择历史版本恢复；服务测试已证明恢复生成新 version、保留旧版本并推进 head。应在隔离账号先提交 v2，再通过版本时间线点击恢复并确认新版本号。

3. **[P2] 未执行真实 ACP/微信生产投递。** runner 使用隔离 fixture executor 和推送 fake sender 验证结构化协议、版本提交和投递回写；本任务明确禁止触碰真实微信/生产环境，因此真实 provider 观察留给发布后的只读/测试账号 smoke。

## Verification Performed

- Runtime `npm run verify`：通过，381 tests / 17 suites、agent-context check、TypeScript build、7 个 boundary suites。
- Portal `npm test`：通过，20/20。
- Portal `npm run build`：通过，包含 `/assets`、`/api/assets/*`、`/automations` 路由。
- Portal `npm run typecheck`：通过；此前与 build 并行导致的 `.next/types` 短暂缺失已在 build 完成后顺序重跑并通过。
- 隔离 Portal 浏览器桌面视口：资产库空状态、上传 Markdown v1、版本预览、重命名；自动化页面打开并检查 `none/create/update`、Markdown/CSV/XLSX、推送和可选输入产物控件。
- 隔离 Portal 浏览器移动视口 `390x844`：资产库和自动化编辑器无水平溢出（`scrollWidth = clientWidth = 390`）。
- 隔离 connector/runtime：资产命令、版本恢复/归档、跨 scope、MCP 确认、通用任务、运行幂等/lease、迁移和推送失败测试均通过。
- 隔离 Portal/Relay 进程和临时数据库已停止/清理；未触碰 Runtime `22655`、生产 `.env`、SQLite、真实 Workspace、`reviews/`、`.state/` 或微信状态。

## Release Readiness

结论：**代码候选可进入发布准备；生产发布本次未执行。**

- 发布前：在隔离账号补真实浏览器下载与 v2 恢复 smoke；再次确认 Runtime/Portal 使用同一协议版本和 connector 注册 scope。
- 数据库：仅执行 additive migration；发布前备份生产 SQLite，禁止重建/删除资产表，旧 `conversation_artifacts`、`automation_task_assets` 和未迁移任务继续保留。
- 发布验证：Runtime 执行 `npm run verify`，Portal 执行 `npm test && npm run typecheck && npm run build`，再用只读测试账号做 health/connector smoke。
- 回退代码：回退到发布前 `main` 代码快照；不回退或删除已经应用的 additive columns/tables。旧任务继续沿兼容 adapter 运行。
- 回退数据：不得删除新资产版本或改写历史 head；若发布后只出现投递故障，单独重试 delivery，不重新执行 ACP 或生成第二版本。

## Follow-Up Checklist

- [ ] 用隔离账号上传/生成 v2，并在 Portal 版本时间线完成“恢复此版本”浏览器 smoke。
- [ ] 用同一隔离账号在真实浏览器确认下载文件名、字节和 SHA-256；记录结果后关闭临时资产。
- [ ] 发布后使用授权测试账号执行只读 health/connector probe；不以生产用户资产写入作为部署 smoke。
- [ ] 将本报告的 P2 项关闭后再把 WP8 标记为无保留通过。
