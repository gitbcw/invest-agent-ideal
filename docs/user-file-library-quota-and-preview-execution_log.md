# 我的文件配额、映射与预览执行日志

## 2026-08-06：恢复执行

- 计划：`docs/user-file-library-quota-and-preview-execution-plan.md`
- 执行范围：Runtime 仓库与正式 Portal 仓库 `/Users/combo/MyFile/projects/invest-agent-portal`。
- 安全约束：仅 additive schema；不发布生产；不修改或迁移真实 Workspace、SQLite、`.env`、`reviews/`、`.state/` 或微信状态；保留两个仓库中既有的未提交改动。

### 已有实现与证据

- Runtime 已有统一 10MB 单文件限制、20MB 解码后请求辅助校验、200MB scope 配额展示、图片大于 1MiB 时的服务端 normalization、报告映射表和只读 reconciliation 脚本。
- Portal 已有容量条、来源筛选、10MB 客户端校验和右侧抽屉样式。
- 恢复前记录的验证：Runtime `npm run build`、完整 `npm test`、目标 `tests/user-assets.test.ts`、`npm run storage:reconcile`、`git diff --check` 通过；Portal `npm test`、`npm run build`、`npm run typecheck`、`git diff --check` 通过。

### 首轮独立基线判断

- 未通过：`reservedBytes` 尚未实现预留、提交、失败释放的真实生命周期，也缺并发/回滚/重试测试。
- 未通过：Portal 仍是单文件上传，缺 20MB 批次校验、逐文件状态和图片优化反馈。
- 未通过：详情仍由局部 `FileDialog` 加 CSS 模拟右抽屉，尚无全局 `none | asset-preview | workspace` 互斥状态。
- 未通过：对话交付物缺“保存到我的文件”的 Portal 操作与状态。
- 部分通过：报告映射只接入部分报告成功路径；`asset.list` 尚未返回真正统一的资产/报告条目。
- 未通过：图片边界矩阵、mock connector 资产能力、桌面/移动浏览器验收、隔离用户 smoke 记录与发布/回滚记录尚未完成。

### 执行代理轮次

#### Attempt 1：Claude Code

- 提示范围：一次性补齐 Runtime 和正式 Portal 的全部剩余缺口。
- 结果：进程运行约 15 分钟后停在无输出、无文件进展的等待状态，主 Agent 终止了该非交互进程；未取得执行摘要。
- 保留改动：Runtime 资产创建/版本提交增加 scope storage lock、预留、提交内复核与 finally 释放；新增并发近满配额、失败释放、普通幂等回放测试，以及独立图片 normalization 测试文件。
- 独立复核：目标 `user-assets` 测试 15/15 通过，但仍复现并发相同 idempotency key 时一个成功、一个 `ASSET_COMMIT_FAILED`；报告映射仍绕过 quota lock；按裸字节预留无法应对进程崩溃或重复释放；Portal 主要缺口未处理。
- 路由决定：后续执行拆为更窄的 Runtime 修复轮次和 Portal 修复轮次。

#### Attempt 2：Claude Code（仅 Runtime）

- 提示范围：只修 Runtime 侧 7 个独立验证的阻塞点，不动 Portal、不碰生产数据、保留既有未提交改动。
- 修复内容：
  1. `src/services/report-asset-mappings.ts` 的 INSERT 列数（13）与占位符（12）不匹配，已补齐为 13 个占位符（此前导致全量套件 37 项失败）。
  2. `createUserAsset` 在 scope storage lock 内增加权威幂等回放：相同 idempotency key 的并发调用现在都返回同一资产、配额只计一次，不再出现 `ASSET_COMMIT_FAILED`。
  3. 用 additive 的 `user_storage_reservations` 账本表替换按裸字节配对的预留：`reserveStorage` 返回 token，`commitStorageReservation`/`releaseStorageReservation` 按 token 幂等结算（重复 commit/release 不会二次生效）；过期 active 预留可被 `reclaimExpiredStorageReservations` 安全回收且不动已提交用量；`reservedBytes` 由账本实时求和。schema/init/Drizzle 均为 additive。
  4. `registerReportAssetMapping` 改为 async，scope/size 校验 + 配额强制，且在同一 scope storage lock 内串行化：仅对 unbacked 字节收费、按更新 delta 收费、同一 backing/version 不重复收费、校验 backing 资产/版本同 scope；失败不留 mapping 与预留。`conversation-artifacts` 与 `portal/connector` 调用方已 await。
  5. 所有公开 quota/mapping 入口（`getStorageUsage`、`authoritativeUsedBytes`、`reserveStorage`、`commit/releaseStorageReservation`、`reclaimExpiredStorageReservations`、`scopeStorageLockKey`、`registerReportAssetMapping`、`listReportAssetMappings`、`getReportAssetMappingForRead`）通过 `requireStorageScope` 拒绝空 userId/projectId/instanceId。
  6. 验证自动化 finalize 回调失败会回滚 DB 行、staged 文件与预留；未改动既有 lease 语义（现有调用路径已传 `run.leaseToken`），新增聚焦回滚测试。
  7. 10MB 单文件 / 20MB 单请求 / 200MB scope 契约保持不变；无物理删除、无真实数据迁移。
- 变更文件：`src/services/user-storage-quota.ts`、`src/services/report-asset-mappings.ts`、`src/services/user-assets.ts`、`src/services/conversation-artifacts.ts`、`src/portal/connector.ts`、`src/db/schema.ts`、`src/db/index.ts`、`tests/user-assets.test.ts`。
- 测试结果（NODE_ENV=test）：
  - 目标 `tests/user-assets.test.ts`：22/22 通过（含并发同 key、token 账本 success/failure/重复结算/过期回收、报告映射 over-limit/负 size/幂等 delta/backed no-copy/跨 scope、空 scope 拒绝、finalize 回滚）。
  - `image-normalization` + `conversation-artifacts` + `user-assets-mcp` + `workspace-report-assets`：52/52 通过。
  - `npm run build`：通过（无类型错误）。
  - `npm test` 全量：416 tests / 0 fail。
  - `git diff --check`：通过。
- 已知边界（非本轮阻塞点）：通过 publish 路径登记的 unbacked 报告映射，若 scope 已满 200MB，`registerReportAssetMapping` 抛 `USER_STORAGE_QUOTA_EXCEEDED`，调用方按"mapping 是 best-effort 目录项"吞掉该错误，报告 artifact 仍持久化但无映射且不计字节；属满配额报告发布的窄场景。
- 剩余 Runtime 阻塞点：无。Portal 侧缺口（多文件/20MB 批量、全局互斥 FilePanel、对话显式保存、浏览器验收）仍待 Portal 修复轮次。

#### Attempt 3：主 Agent 直接完成 Portal 与端到端收口

- Portal 以可选兼容字段扩展协议：`asset.list` 返回资产与报告统一 catalog、用量；`asset.upload` 支持批量结果；新增 `asset.conversation.save` 与 `report.mapping.get`。新增错误码映射保持旧客户端兼容。
- `/assets` 现在提供容量条、来源筛选、批量上传的 10MB 单文件和 20MB 总量前置校验；大于 1MiB 的 JPEG/WebP 会生成保守本地候选，并显示原始到候选大小。服务端仍负责最终压缩、MIME、大小与配额判断。
- 新增应用级 `FilePanelProvider`，状态严格为 `none | asset-preview | workspace`。资产、报告、聊天交付物和自动化运行结果统一走同一预览入口；聊天打开预览时关闭既有 workspace。抽屉支持关闭按钮、Esc、焦点恢复，桌面宽度为 360-640px，窄屏为全屏。资产页在窄屏隐藏桌面侧栏，避免主区域被挤压。
- 对话交付物卡新增“保存到我的文件”显式操作和成功/失败状态；mock fixture 仅增加隔离验收用交付物卡，未影响 Runtime 或真实数据。
- 修复 `GET /api/assets` 丢弃 catalog 的问题；修复 backed report mapping 的零复制读取：连接器会在同 scope 读取 backing asset/version，不依赖 Workspace 路径。
- 新增验证：Runtime Connector 批量上传的全量预校验、10MB/20MB 解码后限制、无部分写入、报告 backing 无复制读取；Portal 协议/错误码/批量 schema 测试；`scripts/acceptance-assets-browser.mts` 隔离浏览器验收。

### 最终验证（2026-08-07）

- Runtime：`npm test` 通过，421 tests / 0 fail；`npm run build` 通过；`git diff --check` 通过。
- Portal：`npm test` 通过，24 tests / 0 fail；`npm run typecheck`、`npm run build`、`git diff --check` 通过。
- 隔离浏览器 smoke：临时 Portal SQLite `/tmp/invest-assets-acceptance.DV8lE0/portal.db`、独立端口 `3211/3212` 和 online mock connector；完成后已停止全部进程。桌面与 390px 移动端均验证容量条、报告统一预览、Esc、桌面焦点恢复；桌面验证 10MB/20MB 前置拒绝与对话显式保存。结果由 `npm run acceptance:assets-browser` 输出，10/10 通过。

### 发布与回滚边界

- 本次未部署、未迁移生产 SQLite、未修改真实 Workspace、`.env`、微信状态或 `reviews/`/`.state/`。
- 发布前应按现有生产流程备份 SQLite，并使用隔离用户重新运行配额、报告映射、图片与对话保存 smoke；新增表为 additive，禁止重建资产表或批量移动 Workspace 文件。
- 回滚仅回滚 Runtime/Portal 代码与新增 UI。保留已经写入的资产版本、报告映射和 reservation 审计；旧代码必须容忍新增表存在。
