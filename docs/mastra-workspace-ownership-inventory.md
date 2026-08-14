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
| `scripts/workspace-compatibility-acceptance.mjs` | 旧 ACP + Workspace 验收脚本 | `compatibility-history` | 已从迁移分支运行入口删除；历史说明保留在 archive/ownership 文档，不作为当前验收命令 | 旧脚本曾导入已删除 ACP 路径 |
| `reviews/` and `.state/` | 服务/历史发布和运行状态 | `artifact-storage` / service-owned | `reviews` 进入 formal asset mapping；`.state` 保持 runtime private root | 生产红线要求不触碰，需独立迁移方案 |

## 已确认的 service-owned 数据

当前 `docs/table-ownership.md` 已将 users、instances、conversation log、traces、scheduler、push、automation、assets、attachments、audit 和 alert 相关表定义为服务层所有。这些表不应因为移除 Workspace Agent runtime 而删除或回写到 Workspace。

## 推荐迁移顺序

1. 先让 Mastra 普通对话不读取 `AGENTS.md`、Skills、`.codex` 或用户根 cwd。
2. 将模型、工具授权、确认和方法读取路径改为服务-owned API/SQLite；保留显式导出能力。
3. 将 Portal Workspace tree 切换到 asset library；保留 workspace file API 只作为兼容读取。
4. 分域迁移 portfolio/watchlist/plans/preferences/methods/schedules，再迁 daily/review/memory 数据。
5. 完成双读校验、幂等导入、备份和回滚证据后，才删除旧读取路径。

## 代码路径分类盘点（2026-08-14）

对 src/ 全部 Workspace 引用（`WORKSPACE_BACKEND` / `ensureWorkspace` / `WorkspaceStore` / `resolveWorkspacePath` / `ACTIVE_BACKEND`）按 mastra 模式行为逐路径分类。

### 运行环境结论：代码级验证通过

- src/ 内全部 35 处 `new WorkspaceStore` 调用点均有 `ACTIVE_BACKEND` / `isWorkspaceBackend` 守卫，mastra 模式零实例化（漏守卫会因 `ensureReady()` 抛 `WORKSPACE_NOT_INITIALIZED` 硬失败，不会静默写盘）。
- 全部 `ensureWorkspace`（模板复制建目录）位于非 mastra 分支；mastra 模式启动与请求路径只经 `mastraWorkspaceRegistry.bootstrap` 建 `MASTRA_PROJECTS_ROOT`（默认 `data/mastra-projects`）下受控项目根，无模板复制、无用户文件导入。
- mastra 路径不读 `AGENTS.md` / `.codex` / 用户 cwd；`scheduler/review.ts:hasWorkspace()` 在 mastra 下恒 true。

### 分类结果

| 分类 | 文件 | 说明 |
| --- | --- | --- |
| 基础设施/切换层 | `lib/data-backend.ts`、`lib/workspace.ts`、`lib/workspace-store.ts`、`mastra/workspace-registry.ts`、`services/project-storage-root.ts`、`mcp/mcp-registry.ts`（env 引用清单）、`lib/user-identity.ts` | workspace.ts 的 mastra 对应物是 workspace-registry.ts（受控项目根，非用户目录）；user-identity 的 `backend` 参数类型为字面量 `"mastra"`，else 分支类型层面不可达 |
| 仅 workspace 模式实现（保留 backend） | `lib/workspace-{portfolio,watchlist,plan}-backend.ts`、`lib/schedules-loader.ts`、daily-plan / periodic-review / method-change / review-viewpoint / weixin-conversation-memory 各自的 workspace 实现段 | 只经 `data-backend.ts` 选择器在 `WORKSPACE_BACKEND=workspace` 时可达；sqlite 回退模式下部分 else 分支也会构造 WorkspaceStore（既有债务，不影响 mastra） |
| 有 service-owned 分支（已收敛） | scheduler/index、scheduler/review、scheduler/alert-check、handlers/review、runtime/context-packet（不活跃）、runtime/scheduled-tasks、services/onboarding、onboarding-drafts、conversation-log、file-retention、workspace-files、workspace-report-assets、automation-runner、generic-automation-runner、automation-tasks、user-assets、server、routes/platform、platform/project-registry、mcp/service-tools-core、routes/sandbox（多数） | mastra 分支读 `mastra_*` 投影表 / `MastraUserPreferenceStore` / 注册项目根；对话记录、任务/资产索引、审计全 SQLite |
| 显式 fail-closed（有意） | `services/l3a-indicator-runner.ts`、`services/l3b-indicator-runner.ts` | L3a 复合指标与 L3b 脚本指标在 mastra 下禁用，等待“配置/脚本发布契约”；属产品待决，非数据缺口 |
| 历史兼容/治理 | `services/file-retention-backfill.ts`、`services/automation-task-migration.ts`（备份根已改为 scope-aware）、`lib/workspace-compatibility.ts`（旧清单已分类） | 一次性治理/迁移工具，只读或已修复 |

### mastra 模式能力缺口（详见幂等文档 G11+）

已全部修复或关闭：策略库 CRUD（`mastra-strategy-library.ts`）、复盘行为纠偏统计（`collectMastraBehaviorStats`）、automation-task-migration 备份根、调度激活（2026-08-14 用户裁决：**走完 onboarding 即可调度**）；按核对关闭：微信对话记忆与 methodology profile（`chat_history` / `methodology_profiles` 均为 service-owned SQLite，满足目标 ownership，并入 mastra 台账属 WP2 命名收敛）；按产品裁决关闭：确认后文件快照交付（YAML 非面向用户的交付物）。Portal 实测新增两项待改进（G22 对话内文件直链、G23 trace 工具终态观测）。巡检可见性记录为后续 Portal 设计点（G21）。

## 当前结论

Mastra runtime 已经不依赖 ACP session、Codex CLI 或 Hermes 执行器，**且“无 Workspace Agent 运行环境”经代码级验证成立**（35 处实例化点全守卫、ensureWorkspace 全隔离、无 AGENTS.md/cwd 读取）。剩余工作是业务数据与能力收敛：`workspace.file.*` 已重定向到注册项目根（Portal 文件页依赖它，非纯兼容层）；portfolio/watchlist/plan 后端默认读写已具备 mastra 投影路径（含新用户空默认语义）；删除 Workspace 前仍需解决策略库投影、行为事件数据源、methodology 投影和调度激活语义（见幂等文档缺口清单）。
