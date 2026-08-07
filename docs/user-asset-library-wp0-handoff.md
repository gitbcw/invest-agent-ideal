# 用户产物库 WP0 移交笔记

> 状态：WP0 文档已落盘，等待架构 reviewer 书面判定。
>
> 契约文件：[user-asset-library-contract.md](./user-asset-library-contract.md)

## 1. 冻结结果

- 用户资产契约版本：`2026-08-05`。
- 当前 Portal relay/runtime 兼容基线：`2026-07-04`。
- `2026-08-05` 是 WP3 对齐 Runtime、Relay、Portal 后才能启用的新协议版本；本 WP 没有修改 `user-portal-protocol.md`、代码或 schema。
- 新资源 scope 固定为 `(userId, instanceId, projectId)`；connector 注册 scope 和 MCP context 是权威来源，payload scope 不得覆盖。
- 新资产命令固定为：`asset.list`、`asset.get`、`asset.version.get`、`asset.versions.list`、`asset.upload`、`asset.rename`、`asset.archive`、`asset.restore_version`、`asset.references.list`。
- 通用任务允许无输入/无产物的推送任务；旧 `sourceAsset`/`asset` 进入兼容 adapter，不得静默映射为新任务输出策略。
- 首期自动化 update 只承诺 Markdown 完整替换和 CSV/XLSX 结构化维护；其余支持格式只读或新建。
- 资产 archive 是软归档；首期不硬删除、物理 purge 或提供 Portal 取消归档。

## 2. 事实证据

本次只读取了任务要求的项目入口、设计/任务/Portal/system 文档和列出的 Runtime/MCP 实现；在收到“停止深入源码读取”的指令后没有继续扩展源码范围。

关键事实已反映到契约兼容矩阵：

| 事实 | 证据位置 | 对 WP0 的处理 |
| --- | --- | --- |
| 当前 Portal envelope 是 `2026-07-04`，connector 注册 scope 权威，旧 commands 列表固定 | `docs/user-portal-protocol.md`；`src/portal/connector.ts` | 保留旧版本和旧命令；目标新协议标为 `2026-08-05` |
| `conversation_artifacts` 是对话/报告交付索引，按 user/instance 读取，使用 Workspace 相对路径；发布上限 15 MiB，HTML 1 MiB | `src/db/schema.ts`；`src/services/conversation-artifacts.ts` | 不就地改语义；新资产走独立 descriptor/版本提交；旧 artifact 命令继续兼容 |
| 旧 artifact library 是 reports 虚拟库，带 curated directory、durable <=1 MiB、cursor/limit 和 retention | `src/services/conversation-artifacts.ts`；`src/portal/connector.ts`；`docs/system-overview.md` | `artifact.library.list` 不复用为 `asset.list`，旧留存不自动升级为资产 |
| `automation_task_assets` 只有 `source`/`working`，路径在 `automations/<task-id>/...`，CSV/XLSX 校验，默认 25 MiB | `src/db/schema.ts`；`src/services/automation-tasks.ts`；`src/services/automation-spreadsheet.ts` | 未迁移旧任务保持行为；新 generic task 使用资产绑定，不填充旧私有文件模型 |
| 旧 `createAutomationTask` 当前要求 source asset，create/update 返回 paused revision | `src/services/automation-tasks.ts`；`src/portal/connector.ts` | 记录为兼容冲突；目标协议允许空 inputs，但旧 payload 保留 adapter |
| automation run 有 SQLite task mutex、lease token/expiry、attempt、幂等 key；默认 lease 15 分钟；失效 runner 被 fencing | `src/services/automation-tasks.ts`；`src/services/automation-runner.ts` | 冻结 run/lease/幂等语义，新版本提交必须在 lease 和 head 检查下完成 |
| 当前 runner 通过 staging 目录维护旧 working 文件，成功后刷新 working checksum；不是不可变 user asset version | `src/services/automation-runner.ts` | 只作为旧任务兼容；新任务必须提交不可变 version，失败不推进 head |
| Workspace browser 只读、最多 5,000 项、读取上限 15 MiB，拒绝路径逃逸/symlink/敏感目录 | `docs/user-portal-protocol.md`；`src/services/workspace-files.ts` | `assets/` 必须排除；资产不能通过 workspace.file.* 绕过服务协议 |
| 本地 `/api/portal/workspace/*` 和 `/api/portal/conversations/*` 是兼容 HTTP 路由，不是云 Portal 授权边界 | `src/routes/portal.ts`；`docs/system-overview.md` | 保留旧路由，不为新资产增加 direct Workspace 访问 |
| 既有 MCP `artifacts.publish` 发布 reports/config 文件，服务按 context scope 审计和校验 | `src/mcp/service-tools-core.ts`；`src/mcp/invest-agent-service-tools.ts` | 新资产 MCP 另设受控读/提交/对话保存工具；旧 artifacts.publish 不变 |

## 3. 冲突与已作决定

| 冲突 | 冻结决定 | 下游动作 |
| --- | --- | --- |
| 旧协议 `2026-07-04` vs 新资产命令 | 不在旧版本伪装新命令；目标版本为 `2026-08-05` | WP3 同步 Portal protocol types、connector、Relay contract tests |
| `conversation_artifacts` 的 `user+instance` 读 scope vs 新三元 scope | 旧 artifact 保持兼容；新 asset/version/task/run 强制三元 scope | WP1 起所有新表查询都带三元 scope |
| `artifact.library.list` 看起来像产物库，但实际是 reports curated library | 两者不合并；新资产只能 `asset.*` | Portal 新增资产入口时不得调用 artifact.library.list |
| 旧自动化 create 强制上传 CSV/XLSX vs 通用任务允许无输入 | 旧 payload 走 legacy adapter；目标 descriptor 的 `inputs=[]` 合法 | WP5 保留旧读模型和执行器，新增通用 revision |
| 旧 automation `source/working` 可变 working 文件 vs 新不可变版本 | 不迁移、不重命名旧文件；新运行只提交 user asset version | WP6 把提交和 run finish 放入同一服务闭环 |
| 当前 schedule 接受任意 timezone vs 产品要求北京时间 | 新 generic task 只接受 `Asia/Shanghai`；历史旧任务保持已存 timezone | WP5 在新 schema 校验，不能重写旧任务 |
| 当前 artifact MIME 包含 TXT/JSON/YAML/CSV，而资产首期白名单更窄 | 旧 artifact/Workspace 兼容继续支持；asset.upload 不接受排除格式 | WP1/2 使用一份共享 asset format registry |
| Workspace file browser 当前实现未体现 `assets/` 排除 | 契约先冻结禁止暴露；这是 WP1/WP3 的阻断验收项 | 在资产 storage 和 Workspace browser 变更同一窗口补测试 |
| 当前 runner 固定一个 working asset vs 新 output `none/create/update` | 旧任务单 working 保持；新任务最多一个 output，禁止 fan-out | WP5/WP6 显式区分 legacy 和 generic runner |

## 4. 首期排除项

格式排除：TXT、JSON、YAML、JSONL、TSV、源码、GIF/TIFF/BMP、DOC/DOCX、PPT/PPTX、ODS、压缩包、数据库、音视频、可执行文件、未知格式。

任务排除：任意 cron、非北京时间、webhook、第三方云盘、共享/协作、文件夹树与移动、任务编排、fan-out、多输出、任意 shell/代码执行、任意 URL 抓取、后台修改持仓/策略/规则/配置、真实数据批量迁移、硬删除、物理 purge、首期取消归档。

## 5. 待确认项与文案

契约语义已冻结，以下只需要产品/架构 reviewer 确认最终文案和发布门槛，不应重新解释资源或权限模型。

### 必须确认

1. 架构 reviewer 是否书面批准 `2026-08-05` 作为新 asset/generic automation protocol version，并接受旧 `2026-07-04` 双轨兼容。
2. Portal 是否接受 XLSX/PDF 首期 `download-only`，以及 CSV 超过 15 MiB 时“可下载但不 inline preview”的展示。
3. Portal 是否接受 archive 后首期不能直接取消归档；如不接受，需要新增明确的 unarchive contract，不得由 UI 自行猜测。
4. 产品是否接受所有新任务最多一个 output；若需要多输出，应先扩展 descriptor、幂等和提交事务，再进入 WP5/WP6。

### 建议直接采用的 UI 文案

- 保存对话产物确认：`保存到产物库会创建长期产物“{name}”的第 1 个版本；对话附件仍按短期留存。确认保存？`
- 上传成功：`已上传“{name}”，当前版本为 v{versionNumber}。`
- 归档确认：`归档后“{name}”不会出现在默认列表，也不能被新自动化绑定；历史版本仍可查看和下载。确定归档？`
- 恢复确认：`将 v{sourceVersionNumber} 的内容创建为新的当前版本；历史版本不会被修改。继续恢复？`
- 自动化更新提示：`任务成功后会为“{name}”生成一个新版本；任务失败不会改变当前版本。`
- XLSX/PDF 预览提示：`此格式首期支持下载，不提供在线预览。`
- 条件推送说明：`只有任务返回结构化“需要通知”结果时才会推送；普通文字不会触发通知。`
- lease/版本冲突提示：`任务未提交新版本，当前产物保持不变。请刷新版本后重试。`

## 6. 下游接力顺序

1. 架构 reviewer 书面确认本文件和上述待确认文案。
2. WP1 按本文件建立 additive schema、format registry、受控 storage/staging、scope/安全测试；不要迁移真实数据。
3. WP2 实现 `assets.version.read`、`assets.version.commit`、`assets.conversation.save` 和对话 artifact 可选关联字段。
4. WP3 同步 `2026-08-05` connector/Portal contracts 和错误码，确保旧 `artifact.*`、`workspace.file.*`、旧 automation 命令回归。
5. WP5/WP6 实现通用 task/revision/run、幂等、lease、版本提交和投递；WP7 仅逐任务迁移旧表格任务。

WP0 交付边界已满足：只新增本契约文件和本移交文件；没有修改代码、schema、UI、生产数据或其他工作包资产。
