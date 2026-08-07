# 我的文件配额、映射与预览验收记录

## 2026-08-06：恢复执行基线

## Acceptance Verdict

Status: Partial

基础限额、容量展示、图片 normalization 和报告映射骨架已存在，且已有构建和自动测试通过记录；但原子预留、多文件上传、统一 FilePanel、显式保存、统一报告条目和完整浏览器验收仍是计划内的实质缺口，当前不能验收。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Runtime | 10MB 单文件、20MB 单请求、200MB scope 限制 | Partial | `src/services/user-storage-quota.ts`、已有测试记录 | 基础常量和检查存在；批量入口与真实 reservation 生命周期不完整。 |
| Runtime | 原子预留、结算、失败释放、并发不超额 | Fail | `src/services/user-storage-quota.ts` | `reservedBytes` 只读取；没有 reserve/commit/release。 |
| Reports | 零复制映射、去重计费、统一 catalog | Partial | `src/services/report-asset-mappings.ts` | 骨架存在；成功路径和统一返回模型覆盖不足。 |
| Images | 仅 >1MiB normalization，最终 <=10MB | Partial | `src/services/image-normalization.ts` | 基础路径存在；透明 PNG、WebP、EXIF、伪 MIME、不可解码和压缩后超限矩阵不完整。 |
| Portal | 容量、来源筛选、搜索、归档 | Pass | `AssetLibraryShell.tsx`、已有构建记录 | 容量和筛选已实现。 |
| Portal | 多文件、20MB 批次、逐文件状态、优化反馈 | Fail | `AssetLibraryShell.tsx` | 当前仍是单文件流程。 |
| Portal | 全局 FilePanel，和 workspace 互斥 | Fail | `AssetLibraryShell.tsx`、`globals.css` | 仅 CSS 将局部对话框移到右侧。 |
| Conversation | 明确“保存到我的文件”并显示结果 | Fail | 对话组件与 API 检查 | Runtime 能力存在，Portal 未接入。 |
| Verification | 自动测试、桌面/移动浏览器、隔离用户 smoke | Partial | 恢复前测试记录 | 自动测试已有；专用浏览器与隔离用户证据缺失。 |
| Operations | additive migration、发布/回滚记录 | Partial | schema 与计划 | additive 方向正确；最终记录缺失，且本次不执行生产发布。 |

## Findings

- [Critical] 配额并发语义未达标：权威统计每次动态求和，但 `reservedBytes` 没有形成原子预留与失败释放，因此 staging 与最终提交之间缺少计划要求的生命周期和证据。
- [High] Portal 核心交互未达标：批量上传、全局互斥 FilePanel 和对话显式保存均缺失。
- [High] 报告 catalog 仍是独立集合，尚未提供真正统一、可预览/下载的文件条目。
- [Medium] 图片安全与格式测试矩阵不完整，浏览器验收尚未形成可重复证据。

## Follow-Up Checklist

- [ ] 完成原子 reservation 与并发/回滚/幂等测试。
- [ ] 完成批量上传、图片优化反馈、统一 FilePanel 和显式保存。
- [ ] 完成报告映射成功路径与统一 catalog。
- [ ] 完成 Runtime/Portal 全量验证、桌面/移动浏览器验收和最终发布/回滚记录。

## 2026-08-07：最终独立验收

## Acceptance Verdict

Status: Pass

实现按计划完成且未执行生产发布。以下结论来自当前代码、全量自动测试和隔离 Portal + mock connector 的实际浏览器流程，而非执行方自述。

| Area | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| Runtime | 10MB 单文件、20MB 解码后请求、200MB 三元 scope 配额 | Pass | `tests/user-assets.test.ts`、`tests/user-assets-portal-contract.test.ts`；Runtime 全量 421/421。 |
| Runtime | 原子预留、幂等、失败释放、过期回收、并发不超额 | Pass | token reservation ledger、并发近满、重复 key、finalize rollback 测试。 |
| Reports | scope-bound 零复制映射、backing 去重、统一 catalog/预览 | Pass | `report-asset-mappings.ts`、Connector backing read contract test、`/api/assets` catalog 转发。 |
| Images | <=1MiB 原样；>1MiB 服务端 normalization；前端候选反馈 | Pass | `image-normalization.test.ts`、`user-assets.test.ts`；Portal 上传候选与大小提示。 |
| Portal | 容量、来源、搜索、归档、批量及配额错误路径 | Pass | Portal 24/24 测试；隔离浏览器 10MB/20MB 客户端拒绝。 |
| Preview | 单一 `none | asset-preview | workspace`、报告/对话/自动化入口、Esc/focus/mobile | Pass | `FilePanelProvider`、`ChatShell`、`AutomationWorkspace`；浏览器桌面/390px 验收。 |
| Conversation | 临时附件不自动入库；交付物必须显式保存 | Pass | Runtime MCP tests、聊天卡 save route、隔离浏览器 explicit-save 流程。 |
| Operations | additive-only、隔离 smoke、发布与回滚记录 | Pass | schema/init additive 实现、执行日志最终验证与发布边界；无生产变更。 |

### Verification Record

- Runtime `npm test`: 421 passed, 0 failed.
- Runtime `npm run build`: passed.
- Portal `npm test`: 24 passed, 0 failed.
- Portal `npm run typecheck` and `npm run build`: passed.
- Both repositories `git diff --check`: passed.
- `npm run acceptance:assets-browser`: 10/10 passed against an isolated temporary database and mock connector; processes stopped after the run.

### Residual Risk

- Production rollout has intentionally not been performed. Production must take the existing SQLite backup and repeat the isolated-user smoke before deployment; rollback preserves additive tables and committed user assets/mappings.
