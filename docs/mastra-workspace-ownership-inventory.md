# Mastra Workspace Ownership Inventory

日期：2026-08-12

本清单只盘点和分类，不执行数据迁移、删除目录或修改真实 Workspace。

## 分类规则

| 分类 | 定义 | 下一步 |
| --- | --- | --- |
| `runtime-environment` | Agent 启动/推理所需的 AGENTS、Skills、Codex session、Workspace 模型配置或用户根 cwd | 从 Mastra runtime 解耦，改为服务配置、Mastra instructions、受控 staging |
| `business-data` | 用户投资判断、偏好、方法、计划、记忆和调度配置 | 逐域定义 SQLite/service 或资产存储 ownership，双轨读取后再迁移 |
| `artifact-storage` | 上传文件、报告、XLSX、图片、附件和自动化 source/working bytes | 以 user_assets/conversation_artifacts/automation_task_assets + 受控文件根为权威 |
| `compatibility-history` | 旧 ACP/Workspace 兼容读取、回退、审计迁移、验收脚本 | 保留到替代路径有证据，再单独删除或归档 |

## Inventory

| 当前区域 | 现状 | 分类 | 目标 ownership | 阻断条件 |
| --- | --- | --- | --- | --- |
| `AGENTS.md`, `.codex/skills`, `.codex/auth.json` | 旧 ACP prompt/runtime 可读取 | `runtime-environment` | Mastra instructions + service tool schemas + secret provider | 需证明所有核心 prompt/tool 行为不再读取它们 |
| 普通对话 `cwd/workspacePath` | 当前 runtime context 仍携带 workspace path | `runtime-environment` | 临时 cwd 或 automation staging；普通对话不授予用户根目录 | artifact/legacy compatibility paths 尚未完全拆除 |
| `config/portfolio.yaml` | Workspace backend 的 portfolio/watchlist/plans 读写源 | `business-data` | SQLite service tables 或正式 asset store，需保留用户可见导出 | 现有 backend 默认仍为 workspace |
| `config/strategy.yaml`, `knowledge/methods/*.md` | 投资画像和方法配置 | `business-data` | SQLite profile/method tables + versioned method assets | 需要确认用户编辑/审计语义 |
| `plans/daily/*.yaml`, `memory/*.jsonl` | 日计划、观点、方法变更、行为记忆 | `business-data` | service tables for state; append-only event tables for memory | 周/月复盘读路径仍依赖 Workspace |
| `config/schedules.yaml`, `config/watch.yaml` | scheduler 配置读取 | `business-data` | scheduler-owned settings/rules tables | 需完成配置 schema 和冷启动默认值 |
| `reports/**`, `deliveries/**` | Workspace/Portal 报告与生成产物 | `artifact-storage` | `conversation_artifacts`, `report_asset_mappings`, `user_assets` | 需统一 preview/path contract |
| `attachments/**` | Portal/WeChat 临时上传字节 | `artifact-storage` | `conversation_attachments` + retention root | 现有兼容读取和 cleanup 仍存在 |
| `automations/<task-id>/source|working` | 自动化任务受控文件 | `artifact-storage` | `automation_task_assets` + staging | 可保留受控文件根，但不得回到用户 Workspace 根 |
| `workspace.file.list/get` | Portal 当前浏览 Workspace 文件 | `compatibility-history` + `artifact-storage` | asset library list/get | Portal UI 仍依赖 Workspace tree，需先完成 B2/B3 |
| `src/lib/workspace-compatibility.ts` | 模板 preflight/adoption/backup | `compatibility-history` | 仅保留迁移期工具，最终由 asset/config migration 替代 | 真实用户 Workspace 仍可能需要手工迁移 |
| `scripts/workspace-compatibility-acceptance.mjs` | 旧 ACP + Workspace 验收脚本 | `compatibility-history` | 重写为 Mastra/asset-store acceptance 或归档 | 当前脚本导入已删除 ACP 路径 |
| `reviews/` and `.state/` | 服务/历史发布和运行状态 | `artifact-storage` / service-owned | `reviews` 进入 formal asset mapping；`.state` 保持 runtime private root | 生产红线要求不触碰，需独立迁移方案 |

## 已确认的 service-owned 数据

当前 `docs/table-ownership.md` 已将 users、instances、conversation log、traces、scheduler、push、automation、assets、attachments、audit 和 alert 相关表定义为服务层所有。这些表不应因为移除 Workspace Agent runtime 而删除或回写到 Workspace。

## 推荐迁移顺序

1. 先让 Mastra 普通对话不读取 `AGENTS.md`、Skills、`.codex` 或用户根 cwd。
2. 将模型、工具授权、确认和方法读取路径改为服务-owned API/SQLite；保留显式导出能力。
3. 将 Portal Workspace tree 切换到 asset library；保留 workspace file API 只作为兼容读取。
4. 分域迁移 portfolio/watchlist/plans/preferences/methods/schedules，再迁 daily/review/memory 数据。
5. 完成双读校验、幂等导入、备份和回滚证据后，才删除旧读取路径。

## 当前结论

Mastra runtime 已经不依赖 ACP session、Codex CLI 或 Hermes 执行器，但仍有大量 Workspace 业务数据和文件兼容路径。可以立即推进“无 Workspace Agent 运行环境”；不能立即删除整个 Workspace。删除 Workspace 前至少需要解决 `workspace.file.*` Portal 契约、Workspace backend 默认读写、scheduler config 和用户资产迁移。
