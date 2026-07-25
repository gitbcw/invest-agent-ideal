# Portal 文件生命周期与文档库工作包独立验收

验收日期：2026-07-25

## Acceptance Verdict

Status: **Partial**

Runtime 与 Portal UI 的主体实现已经存在，两个仓库均可构建，Runtime 全量 `npm run verify` 通过，Portal 隔离 mock 的桌面浏览器验收 28/28 通过。生产机也确实已经部署了早期本地工作树版本，两个 PM2 进程在线，三个真实 connector 已注册。因此“无法部署到生产 Portal”不是准确描述。

工作包仍不能判定完成：两个仓库的全部实现仍未提交，当前生产版本也不含本轮新增的持久审计、可恢复删除、path lock、真实下载和 dry-run 修复，无法由当前 Git HEAD 重建。生产清理开关未启用且没有 retention job 运行记录。首次生产 `backfill --dry-run` 还暴露出旧 CLI 会写 artifact 分类的缺陷：16 条记录被实际分类为 1 条 durable 与 15 条 reference-only；workspace/attachment backfill、cleanup 与 trash 均未 apply。

## Acceptance Checklist

| 编号 | 状态 | 证据与判断 |
| --- | --- | --- |
| D1 上传 7 天 | Pass | `tests/file-retention.test.ts` 验证服务端 `storedAt + 7d` 与读取不续期；Portal/微信写入路径均已接入权威索引。 |
| D2 到期状态 | Pass | Runtime 到期读取/清理测试通过；隔离 Portal 浏览器中到期卡片保留对话并显示“附件已过期”。 |
| D3 永久阈值 | Pass | `1,048,576` 与 `1,048,577` 精确边界测试通过。 |
| D4 精选历史 | Partial | 代码与 mock UI 已具备；生产 artifact 分类现为 `total=21, durable=1, referenceOnly=20, unclassified=0`，但 workspace curated 注册仍只做 dry-run（60 个待注册）。 |
| D5 内部隔离 | Pass | 固定精选目录、realpath/symlink、隐藏/临时目录过滤存在；浏览器树负向检查通过。 |
| D6 图片路由 | Pass | Runtime 返回 `openRoute=image`；两个桌面视口均验证图片进入 Lightbox 而非标签页。 |
| D7 其他文件 | Pass | `openRoute=download` 现直接下载；两个桌面视口均监听到 CSV browser download，且标签数不变。 |
| D8 删除确认 | Pass | scope-bound、短时、一次性 token 的 Runtime 测试通过；Portal 取消删除无副作用。 |
| D9 删除结果 | Partial | Runtime 验证移动到 30 天回收区及同路径 tombstone，mock UI 验证树移除；未用真实 connector 联合验证树、标签、历史卡片三者一致。 |
| D10 删除安全 | Pass | 跨 scope、内部文件拒绝与 path/checksum 冲突有测试；同路径读删使用共享进程内锁并有序列测试；完成 token 重放幂等返回原结果。 |
| D11 清理幂等 | Pass | 附件 cleanup、缺失文件与 trash purge 幂等测试通过；scheduler 使用 `scheduled_task_runs` claim。 |
| D12 Backfill 幂等 | Pass | 固定目录扫描、path+checksum 去重、排除目录及不改写文件的测试通过。 |
| D13 迁移兼容 | Pass | fresh/init 重复执行、全量 migration smoke、生产 additive schema 启动均通过。 |
| D14 审计 | Pass | 新增 `file_lifecycle_events`，并覆盖 classify/backfill/expiry/delete/purge；测试验证事件持久化且 summary 不泄露绝对路径。 |
| D15 首次清理门禁 | Partial | 当前 `.env` 与 PM2 均未启用 cleanup，生产没有 retention run；但未找到备份、quick_check、逐用户 dry-run 和用户明确确认的持久证据，不能宣称 Phase C 完成。 |
| D16 生产健康 | Pass | 生产 Portal `/login` 200；`invest-agent`/`invest-agent-portal` online；111/dyk/mg 在 12:23 UTC 重新注册；部署后检查未见新的相关 ERROR。 |
| D17 数据保护 | Pass | Runtime 发布脚本排除 `.env`、DB、workspaces、reviews、`.state`；生产文件哈希与本地实现一致，运行资产未被代码包替换。 |

## Findings

- **[P1] 发布不可复现，当前不能安全地继续发布或回滚。** `invest-agent-ideal` 的核心新增文件和 `invest-agent-portal` 的 Portal UI 均不在当前 Git HEAD；两个仓库都有大量未提交、未跟踪文件。生产文件哈希虽然与本地脏工作树一致，但任何从 `main`/HEAD 的干净发布都会丢失本工作包。这是 agent 所谓“无法部署”背后的真实工程阻塞：代码已经被直接部署，但没有形成可发布版本。
- **[P1] 生产迁移事实与手册记录矛盾。** Portal `MANUAL_TESTING.md` 声称 Phase B 已产生 21 条 durable、Phase C 已启用；生产只读查询实际为 0 durable、16 unclassified、0 retention runs，且 cleanup gate 为 missing/false。工作包页首“Phase C/D 待确认”更接近事实。
- **[P1] 旧版 backfill dry-run 会写数据。** 生产执行 `backfill --dry-run` 时 artifact classification 实际更新了 16 条记录。没有移动或删除文件，但违反了只读预期。本地已让 classification 接收 `dryRun` 并补“不写行”测试；修复发布前不得再次在生产运行该命令。
- **[P2] Relay 高并发请求监听器告警。** 28/28 浏览器验收期间出现 `MaxListenersExceededWarning`。本次请求均完成，但 Relay 的每请求 WebSocket listener 模型应单独整改，避免高并发下泄漏风险。

## Verification Performed

- `invest-agent-ideal`: `npm run verify` 通过，包含类型检查、全量测试、构建及迁移/安全 smoke。
- `invest-agent-portal`: `npm run typecheck`、`npm test`、`npm run build` 通过。
- Portal 隔离 mock 浏览器验收：`1440x900`、`1920x1080`，28/28 断言通过；测试服务已关闭。
- 生产只读核查：Runtime 与 Portal 关键源文件 SHA-256 均与本地实现一致；Portal `/login` 200；两个 PM2 进程 online；111/dyk/mg connector 已注册。
- 生产 retention：attachments 0；artifact dry-run 前为 21 条（unclassified 16），因旧 CLI 缺陷被分类后为 durable 1、reference-only 20、unclassified 0；workspace dry-run 待注册 60、附件 cleanup candidates 8；cleanup/trash dry-run 均为 0。
- 生产门禁只读核查：`.env` 与 PM2 均未设置 `FILE_RETENTION_CLEANUP_ENABLED=true`。

## Follow-Up Checklist

- [ ] 分别整理两个仓库的变更边界，排除无关文件，形成可审查提交并从干净 release tree 重做可复现发布。
- [ ] 删除或修正 Portal 手册中与生产事实冲突的 Phase B/C 与“已完成”记录。
- [x] 增加 lifecycle 持久审计事件及测试，覆盖 classify/backfill/expiry/delete/purge，且不记录绝对路径。
- [x] 把 delete confirm 改成可恢复状态机，移动失败后同 token 可重试，完成重放幂等。
- [x] 增加 artifact 同路径读取与删除锁及序列测试。
- [x] 执行生产 retention report/backfill/cleanup/trash dry-run；其中 backfill 暴露旧 CLI 误写分类，已记录并在本地修复。
- [ ] Phase C 仍需单独展示备份、quick_check、拟删除统计并取得明确确认；当前不得启用真实清理。
- [x] 补 Portal 真实下载行为自动化验收。
- [ ] 补真实 connector 联合删除状态与 offline 恢复的自动化验收。
