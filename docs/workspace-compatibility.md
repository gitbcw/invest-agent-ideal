# Workspace 兼容预检与受控升级

## 目的

真实用户旧 Workspace 是长期兼容资产，不随普通代码发布整体覆盖。当前 Mastra Agent 只挂载注册项目根下的 `skills/`，不读取旧 Workspace 的 `AGENTS.md`、`.codex/skills` 或 `skills/`。Mastra Skill 的模板与播种流程见 `docs/context-and-prompt-architecture.md`；本文件只描述旧 Workspace 数据的兼容预检。

这套流程不替换 SQLite、Workspace 目录、复盘、微信状态或用户配置，也不属于 `volcano:package-runtime` / `volcano:apply-runtime` 数据迁移路径。

## 所有权边界

必须强制执行的系统契约属于服务/MCP 层，包括工具 scope、权限、确认、审计、scheduler 与推送门禁。Workspace 文本不是安全边界。

`src/lib/workspace-compatibility.ts` 将文件分成两类：

- `WORKSPACE_MANAGED_ASSETS`：不可由用户定制的系统元数据；当前为空，不包含任何 Skill。
- `WORKSPACE_OPTIONAL_TEMPLATE_ASSETS`：当前为空。旧 `AGENTS.md`、`.codex/skills` 和其他提示词资产都不再有可采用的模板标准版本。

以下资产始终由用户或实例拥有；其中登记为可选模板资产的文件，也只能在负责人逐文件确认后采用标准版本：

- `AGENTS.md`。
- 所有 `.codex/skills/`，包括最初从标准模板复制的 Skill。
- `config/` 下的持仓、策略、时间、通知、规则和用户偏好。
- `reports/`、`memory/`、`financials/`、预案和历史产物。
- 投资方法和其他自定义文件。

兼容工具仍可为隔离迁移创建旧 Workspace 数据骨架，但该目录不是 Mastra Agent 的运行项目。现有 Workspace 在普通运行、代码发布和兼容迁移中都不会补齐、覆盖或删除旧 Skill。

## 只读预检

预检不会修改 Workspace：

```bash
npm run workspace:preflight -- \
  --workspace-root=/home/claude/invest-agent-data/workspaces \
  --template-root=/home/claude/invest-agent/templates/workspace \
  --user=111
```

需要机器可读结果时增加 `--json`。

状态说明：

- `ready`：Workspace 的运行结构可用；允许存在 `template_updates`。
- `migration_required`：用户数据可读，但存在缺失或旧版系统受管资产。
- `blocked`：缺少 `AGENTS.md`，或核心用户配置缺失/无法解析。

`AVAILABLE` 表示标准模板存在不同版本，不影响 `ready`。旧 `AGENTS.md` 缺少新契约标记也只作为 warning，因为它可能包含真实用户定制。

## 系统兼容迁移

`workspace:migrate` 只处理未来可能出现的不可定制系统元数据，当前不会替换任何 Skill：

```bash
npm run workspace:migrate -- \
  --workspace-root=/home/claude/invest-agent-data/workspaces \
  --template-root=/home/claude/invest-agent/templates/workspace \
  --user=111 \
  --backup-root=/home/claude/invest-agent-data/workspace-compatibility-backups \
  --confirm=apply-managed-workspace-assets-v1
```

安全约束：

- `--backup-root` 必须是 Workspace 外部的绝对路径。
- 确认短语必须精确匹配当前兼容版本。
- 每个被替换的旧文件先按原相对路径备份。
- 备份目录包含 `manifest.json`，Workspace 内只写入 `.invest-agent/workspace-compatibility.json` 迁移记录。
- 重复执行不会重复写入或创建无意义备份。
- 不要省略 `--user` 直接批量迁移生产 Workspace；应逐个真实用户审阅和执行。

迁移后重新运行预检，目标状态应为 `ready`。

## 模板采用入口

当前没有允许采用的旧 Workspace 提示词资产；`workspace:adopt-template` 对 `AGENTS.md`、`.codex/skills` 和其他路径都会拒绝。生产用户旧文件只能在独立迁移方案中逐文件备份、重写和验收，不能通过兼容模板覆盖。

## 隔离单点验收

`scripts/workspace-compatibility-acceptance.mjs` 只允许在路径包含 `compatibility-evals` 的隔离环境运行，并强制要求关闭微信、Portal connector 和 scheduler。它会核对 Workspace 持仓读取、指定用户/实例的盘中快照作用域，以及 ACP 是否通过受限 MCP 工具得到同一事实；最终只输出计数、窗口和耗时，不输出用户持仓内容。

```bash
WORKSPACE_COMPATIBILITY_EVAL=true \
WEIXIN_AUTO_START=false \
PORTAL_CONNECTOR_AUTO_START=false \
SCHEDULER_ENABLED=false \
WORKSPACE_BACKEND=workspace \
WORKSPACE_ROOT=/absolute/path/compatibility-evals/<run>/migrated \
WORKSPACE_TEMPLATE_PATH=/absolute/path/invest-agent/templates/workspace \
DB_PATH=/absolute/path/compatibility-evals/<run>/runtime-data/<user>.db \
RUNTIME_DATA_ROOT=/absolute/path/compatibility-evals/<run>/runtime-data/<user> \
REVIEWS_ROOT=/absolute/path/compatibility-evals/<run>/reviews/<user> \
INVEST_AGENT_WEIXIN_STATE_DIR=/absolute/path/compatibility-evals/<run>/state/<user> \
npm run smoke:workspace-compatibility -- <user> <instance>
```

定时日复盘发布可在同一组隔离环境变量下运行 `smoke:scheduled-review-publication`。该探针只开放 `reviews.save`，不会创建 push job 或连接微信。

## 生产迁移历史基线（2026-07-23）

- `9a253e7` 是首次 Workspace 兼容收敛发布；当前生产版本从 `feat/mastra-migration` 的已审阅提交通过普通代码发布路径部署；服务器 `.env`、SQLite、reviews、`.state`、根 `.codex` 和真实 Workspace 均受同步排除规则保护。
- 发布前在线安全快照位于 `/home/claude/invest-agent-data/compatibility-backups/20260723-013655`，SQLite 副本 `quick_check=ok`，目录权限为 `700`。
- `111`、`dyk`、`mg` 的隔离迁移副本均通过持仓、`market_watch.snapshot` 和只开放 `reviews.save` 的日复盘发布单点验收；探针没有创建 push job、连接微信或输出持仓内容。
- 所列迁移发生在兼容模型 v1，当时部分标准 Skill 仍被视为受管资产。兼容模型 v2 已取消 Skill 自动替换；这些备份继续保留用于历史审计和回滚：
  - `/home/claude/invest-agent-data/workspace-compatibility-backups/production-20260723-015253/111`
  - `/home/claude/invest-agent-data/workspace-compatibility-backups/production-20260723-015730-dyk/dyk`
  - `/home/claude/invest-agent-data/workspace-compatibility-backups/production-20260723-015757-mg/mg`
- 生产 `invest-agent-service-tools` smoke 通过，共 37 个工具；三个用户均通过对应 user/instance 的持仓与盘中快照服务回读。`111` 另外通过生产主进程 `/api/chat` 的只读 ACP 单点验收，持仓计数与服务层权威数据一致。
- 发布中发现 PM2 遗留 `CODEX_ACP_COMMAND` 和模型变量会覆盖服务器 `.env`。旧 PM2 条目已删除并从干净 shell 按 `ecosystem.config.js` 重建；最终进程不再携带这些覆盖值，重启后的日志窗口内没有新 `ERROR` 或 ACP `ENOENT`。
- 最终复检确认 runtime 与 Portal 健康、PM2 `online`、活动 push job 为 0，三个生产实例的微信 listener 均自动恢复。验收没有向真实用户发送测试消息，也没有写入投资数据。
- 发布窗口记录的三个实例均为 `pushReady=false`：连接与监听可用，但主动推送要等对应真实用户下一次入站消息恢复有效 conversation。不得为了改变此状态擅自发送测试消息。

## 火山云发布顺序

1. 从干净、已审核的发布分支或 tag 构建并完成本地测试。
2. 对生产真实用户逐个记录只读预检结果。
3. 只读记录每个 Workspace 的 `template_updates`；差异本身不阻塞发布，也不触发修改。
4. 选择没有定时任务命中的维护窗口，使用 `scripts/deploy-volcano.sh` 进行普通代码发布；该脚本保留服务器根 `.codex` 运行态，但必须同步 `templates/workspace/.codex`。
5. 只有已经明确批准采用的具体模板文件才逐用户执行 `workspace:adopt-template`，然后用新 ACP 会话做对应单点验收。
6. 没有批准模板采用时，保持真实 Workspace 原样，仅验收服务/MCP 变更。

代码回滚不自动回滚已经明确采用的 Workspace 文件。需要回退时，根据该用户备份目录中的 `manifest.json` 恢复原文件，并保留采用记录和审计证据。
