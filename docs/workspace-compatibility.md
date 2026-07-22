# Workspace 兼容预检与受控升级

## 目的

真实用户 Workspace 是长期资产，不随普通代码发布整体覆盖。新版本需要升级服务协议型核心 Skill 时，必须先做只读预检，再通过显式确认、外部备份和迁移记录完成最小升级。

这套流程不替换 SQLite、Workspace 目录、复盘、微信状态或用户配置，也不属于 `volcano:package-runtime` / `volcano:apply-runtime` 数据迁移路径。

## 所有权边界

系统受管资产由 `src/lib/workspace-compatibility.ts` 的 `WORKSPACE_MANAGED_ASSETS` 定义，当前只包含：

- 服务能力、会话恢复和能力扩展协议。
- Onboarding、盘中简报和日复盘的核心运行 Skill。
- 能力扩展协议知识文件。

以下资产始终由用户或实例拥有，兼容迁移不得覆盖：

- `AGENTS.md`。
- `config/` 下的持仓、策略、时间、通知、规则和用户偏好。
- `reports/`、`memory/`、`financials/`、预案和历史产物。
- 用户新增的 `.codex/skills/`、投资方法和其他自定义文件。

现有 Workspace 在普通运行时不会补齐或覆盖系统受管资产。缺失文件和已有系统资产的版本升级都只能走本文件的显式迁移流程；新建 Workspace 仍从完整的当前模板初始化。

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

- `ready`：系统受管资产已经与当前模板一致。
- `migration_required`：用户数据可读，但存在缺失或旧版系统受管资产。
- `blocked`：缺少 `AGENTS.md`、核心用户配置缺失/无法解析，或发布模板本身不完整；不得迁移。

旧 `AGENTS.md` 缺少新契约标记只作为 warning，因为它可能包含真实用户定制，工具不会自动覆盖。核心服务契约由受管 Skills 补齐。

## 显式迁移

先逐个真实用户运行预检并审阅变更列表。只有没有 blocker 时，才允许迁移：

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

## 火山云发布顺序

1. 从干净、已审核的发布分支或 tag 构建并完成本地测试。
2. 对生产真实用户逐个记录只读预检结果。
3. 先在隔离的生产 Workspace 副本上执行迁移和真实链路单点验收，不连接微信、Portal 或 scheduler。
4. 选择没有定时任务命中的维护窗口，使用 `scripts/deploy-volcano.sh` 进行普通代码发布；该脚本保留服务器根 `.codex` 运行态，但必须同步 `templates/workspace/.codex`。
5. 在维护窗口内立即逐个用户显式执行受管资产迁移；迁移后重新启动运行时，确保新 ACP 会话加载新 Skill，再结束维护窗口。
6. 每个用户迁移后复验普通问答、持仓读取、日复盘发布和盘中快照读取，再恢复正常自动任务。

代码回滚不自动回滚已经迁移的 Workspace 文件。需要回退时，根据该用户备份目录中的 `manifest.json` 恢复受管文件，并保留当前版本的迁移记录和审计证据。
