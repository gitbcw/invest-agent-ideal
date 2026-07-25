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

---

## 2026-07-25 发布后复核

### Acceptance Verdict

Status: **Partial**

阻塞发布的问题已经解决：Runtime `c97b176` 与 Portal `298175e` 均已从干净 release tree 完成普通代码发布，当前生产 `invest-agent` 与 `invest-agent-portal` 均在线，三个真实 connector 已重新注册。发布后四个 retention 只读命令成功，新版 `backfill --dry-run` 前后 report 完全一致，确认此前“dry-run 写分类”的缺陷已修复并上线。

工作包仍不能标记为完整完成。生产当前只完成 additive schema、代码发布与只读盘点；60 个精选 Workspace 文件和 8 个历史附件候选尚未 apply，cleanup gate 仍为关闭状态，也未执行首次附件物理清理或 trash purge。根据工作包 Completion Definition，这些动作必须在备份、逐用户核对和负责人单独确认后执行，因此当前保持 `Partial` 是正确状态，而不是部署失败。

### Changed Acceptance Status

| 编号 | 当前状态 | 发布后证据与判断 |
| --- | --- | --- |
| D4 精选历史 | Partial | `backfill --dry-run` 扫描 17 个用户、62 个文件；60 个待注册、2 个已索引、0 错误。尚未 apply，因此生产文件树未完整纳入精选历史。 |
| D9 删除结果 | Partial | 代码、自动化和隔离 Portal UI 已通过；仍未经真实 connector 执行有副作用的联合删除验收。 |
| D15 首次清理门禁 | Partial | `cleanupEnabled=false`；附件 cleanup 与 trash dry-run 均扫描 0 条。8 个历史附件候选只在 backfill dry-run 中识别，未建立权威索引、未清理。首次 apply 仍需备份和明确确认。 |
| D16 生产健康 | Pass | Runtime `/health` 正常；Portal `/login` 返回 200；PM2 两进程 online；111/dyk/mg connector 在 22:22 CST 注册成功。发布后未发现本工作包相关新 ERROR。 |
| D17 数据保护 | Pass | Runtime/Portal `.env` 仍存在且权限为 `600`，修改时间早于本次发布；生产 SQLite `quick_check=ok`；data/workspaces 目录仍存在。发布采用代码发布路径，未执行 runtime-data apply。 |

### Findings

- **[P1] 生产数据阶段尚未完成。** 精选库 backfill 仍有 60 个待注册文件；8 个历史附件候选尚未回填。Completion Definition 中“现有用户精选历史完成幂等 backfill”尚未满足。
- **[P1] 首次真实清理仍需单独授权。** 当前 cleanup gate 为关闭，且本次复核没有执行 `--apply`、附件物理删除或 trash purge。这符合生产门禁，但意味着 Phase C/D 尚未完成。
- **[P2] Portal 健康检查手册与实现不一致。** 运维手册要求 `/api/portal/health`，生产该路由返回 404；`/login` 与 PM2 状态正常。应为 Portal 增加稳定健康端点或修正文档。
- **[P2] Relay `MaxListenersExceededWarning` 仍属独立技术债。** 本次发布后日志未出现新告警，但此前浏览器验收已复现；不阻塞当前工作包的代码发布结论。

### Verification Performed

- `npm run retention:report`：attachments 0；artifacts 21（durable 1、reference-only 20、unclassified 0）；cleanup disabled。
- `npm run retention:backfill -- --dry-run`：classification 扫描 0；Workspace 待注册 60；历史附件 cleanup candidates 8；0 errors。
- dry-run 后再次执行 `retention:report`：结果与 dry-run 前完全一致，确认新版 dry-run 没有修改 artifact 行。
- `npm run retention:cleanup -- --dry-run` 与 `npm run retention:trash -- --dry-run`：均扫描 0、删除 0、错误 0。
- Runtime `/health`：`status=ok`；Portal `/login`：HTTP 200；PM2：`invest-agent`、`invest-agent-portal` online。
- Connector 日志：`invest-agent-111`、`invest-agent-dyk`、`invest-agent-mg` 均在发布后重新注册；微信监听恢复。
- SQLite 只读检查：`quick_check=ok`；未打印生产 `.env` 内容或任何 token。

### Follow-Up Checklist

- [x] 从可复现提交和干净 release tree 发布 Runtime 与 Portal。
- [x] 发布后确认新版 `backfill --dry-run` 不再写 artifact 分类。
- [x] 核对 Runtime/Portal 健康、PM2、三个 connector、SQLite 与 `.env` 保护状态。
- [ ] 审阅 60 个精选文件的逐用户清单，完成备份后单独确认并执行 workspace backfill apply。
- [ ] 审阅 8 个历史附件候选，确认归属与预期到期状态后执行 attachment index backfill apply。
- [ ] 在备份、`quick_check`、拟删除统计和负责人明确确认后，才启用首次 cleanup；执行后关闭临时门禁或按正式策略留存。
- [ ] 补真实 connector 删除状态与 offline 恢复验收。
- [ ] 另行处理 Relay listener 告警，并统一 Portal 健康检查端点与运维手册。

---

## 2026-07-25 索引可见性修复

### 修复结果

此前 Portal 侧边栏只显示 1 个文件，并非代码回退，而是生产精选 Workspace 文件尚未写入 `conversation_artifacts` 索引。经只读盘点，旧的 22 条 `origin=legacy` 记录按设计保持 `reference_only/conversation_only`，没有将它们错误升级为永久库；真正缺失的是 60 个 `reports/**` 精选文件的 backfill 索引。

已完成一次非破坏性修复：

1. 生产 SQLite 备份：`data/backups/invest-agent.db.2026-07-25T14-33-14-936Z-file-retention.bak`，备份前 `quick_check=ok`。
2. 执行 `retention:backfill -- --apply`，仅写入 artifact/attachment 索引，不移动、不删除任何文件。
3. Workspace backfill：17 个用户、62 个文件扫描，60 条注册，2 条已存在，0 错误。
4. 附件 backfill：8 条历史附件建立权威索引，标记为 cleanup candidate，但未物理删除。
5. cleanup gate 仍为 `false`，未执行 cleanup/trash purge。

### 修复后验证

- 生产报告：artifacts 总数 83，`durable_library=61`，`reference_only=22`，`unclassified=0`。
- 当前 111 Portal 页面侧边栏已恢复分类文档：日复盘 6 条、周复盘 3 条。
- 原有对话内 SVG 查看/下载、Markdown 下载、“打开制品”按钮仍存在。
- SQLite `quick_check=ok`，Runtime/Portal 进程未重启，未发生文件字节删除。

### 当前结论

索引可见性回退已修复。剩余 `Partial` 只涉及首次真实附件清理、回收站 purge、真实 connector 删除联合验收和 Relay 健康端点/监听器技术债；不再是 Portal 代码部署失败或版本回退问题。

### HTTP 生产兼容约束

火山云 Portal 使用固定公网 IP + HTTP，当前不具备域名备案条件，HTTPS 不能作为依赖或整改前提。生产复现确认 `crypto.subtle` 在该非安全上下文不可用，并导致 artifact checksum 校验抛错、界面永久停在“加载制品中...”。后续验收必须在实际 HTTP 入口覆盖图片 Lightbox、Markdown/HTML 文档、download-only 文件和附件读取；所有 checksum 实现必须支持非 secure context，所有异步异常必须进入可见错误/重试状态。

Portal `09c5f4f` 已将 checksum 改为纯 JavaScript SHA-256，并为 artifact 异步加载增加可重试错误收敛；`npm test`、`npm run typecheck`、`npm run build` 通过。该提交已发布到火山云，生产 HTTP 入口实测 SVG 图片正常显示并提供下载按钮，侧边栏 Markdown 正常打开和渲染，浏览器不再出现 `crypto.subtle.digest` 错误。

---

## 2026-07-25 当前生产状态复核

- `retention:report`：artifacts `86`，其中 `durable_library=61`、`reference_only=25`、`unclassified=0`；附件索引 `8` 条，`expiredPending=8`、`cleanupCandidates=8`、`deleted=0`；cleanup gate 仍为 `false`。
- `retention:cleanup --dry-run` 扫描 8 条，结果为 `missing=8`、`errors=0`、`deletedFiles=0`；这 8 个候选的文件字节已不存在，当前没有待由本次任务物理删除的附件，但索引仍需通过 apply 标记为 missing/完成状态。
- `retention:trash --dry-run` 扫描 0 条，没有回收站文件待 purge。

因此当前未完成项已收敛为：

1. 关闭 8 条已缺失附件的索引尾账，并确认不会误标成可恢复文件。
2. 在明确的生产负责人确认后，执行一次小批量 cleanup apply，验证审计、幂等和 scheduler 运行记录；在此之前继续保持 cleanup disabled。
3. 用真实 connector 完成删除后的树、标签、历史卡片一致性和 offline 恢复联合验收。
4. 单独处理 Relay listener 告警，以及 Portal 健康端点文档差异。

不再属于未完成项的内容：Runtime/Portal 可复现发布、精选历史 backfill、HTTP 下图片预览/文档打开/下载、checksum 校验和侧边栏索引可见性均已完成并在生产验证。
