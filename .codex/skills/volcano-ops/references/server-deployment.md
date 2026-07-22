# 火山云生产操作手册

> 当前基线：2026-07-23。本文是火山云日常发布、健康检查和回滚的当前操作手册。首次迁移阶段、旧端口方案和历史接管记录见 `volcano-runtime-migration-plan.md`，不得用历史步骤替代本手册。

## 1. 当前拓扑

```text
真实用户微信
  -> 火山云 invest-agent runtime
  -> workspace-scoped Codex ACP
  -> invest-agent-service-tools MCP
  -> SQLite / Workspace / scheduler / push

用户浏览器
  -> 火山云 portal :22649
  -> 火山云 relay :22650
  -> 火山云 invest-agent connector

管理员
  -> SSH tunnel 本机 :22648
  -> 火山云 runtime 127.0.0.1:22655/platform
```

固定位置：

- 主机：`claude@118.145.115.197`
- runtime：`/home/claude/invest-agent`
- runtime data：`/home/claude/invest-agent-data`
- Workspace：`/home/claude/invest-agent-data/workspaces`
- Portal：`/home/claude/invest-agent-portal`
- PM2 进程：`invest-agent`
- runtime 内部端口：`127.0.0.1:22655`
- Portal：`http://118.145.115.197:22649`
- Relay：`ws://127.0.0.1:22650/`
- Platform tunnel：

```bash
ssh -L 22648:127.0.0.1:22655 claude@118.145.115.197
```

浏览器随后访问 `http://127.0.0.1:22648/platform`。不要把 `22655` 直接开放公网。

## 2. 版本基线

- `main` 是唯一维护与生产发布基线。
- `codex/volcano-snapshot-*`、冻结标签和历史 reconciliation 分支只用于审计、比较和回滚，不继续修复、不整体 merge 回 `main`。
- 普通发布从已审核 `main` 提交的干净 worktree 执行；不要从带有未提交文件、`tmp/` 或其他用户改动的工作树打包发布。
- 截至 2026-07-23，火山云运行代码基线为 `9a253e7`；`111`、`dyk`、`mg` 的 Workspace 均为 `ready`。详细备份与迁移证据见 `docs/workspace-compatibility.md`。
- GitHub push、PR、生产部署是三个独立动作。部署授权不自动授权 push 或 PR。

## 3. 两种发布模式

### 3.1 普通代码发布

适用于服务代码、提示词、Workspace 模板、Skill、测试和编译运行时变化。只能使用：

```bash
./scripts/deploy-volcano.sh
```

代码同步会删除版本库中已经退役的源码，但必须保护：

- `.env`
- `data/` 和所有 SQLite/WAL/SHM
- `reviews/`
- `.state/`
- 真实 `workspaces/`
- 项目根 `.codex` 生产运行态
- 日志和其他运行资产

`templates/workspace/.codex` 属于发布代码，必须同步。禁止给 rsync 增加 `--delete-excluded`。

### 3.2 运行时数据迁移或恢复

`volcano:package-runtime` / `volcano:apply-runtime` 会替换数据库、Workspace 或其他运行资产，不属于普通发布。只有用户明确要求数据迁移、快照恢复、生产数据替换或灾难恢复时才允许使用，并且必须：

1. 停止或冻结写入。
2. 创建并验证回滚备份。
3. 核对包 SHA256 和目标目录。
4. 使用脚本要求的精确确认短语。
5. 应用后执行 SQLite `quick_check`、Workspace 预检和真实链路单点验收。

如果一项变更既能走代码发布也能走数据替换，选择代码发布。

## 4. 发布前检查

1. 记录目标 `main` 提交，确认发布 worktree 干净。
2. 本地运行：

```bash
npm run verify
```

3. 确认发布脚本仍保护所有生产运行资产。
4. 若模板中的系统受管 Skill 有变化，对每个真实用户先执行只读预检：

```bash
npm run workspace:preflight -- \
  --workspace-root=/home/claude/invest-agent-data/workspaces \
  --template-root=/home/claude/invest-agent/templates/workspace \
  --user=<user>
```

5. 选择没有 scheduler 任务命中的维护窗口，确认没有活动 `pending` / `retry` / `processing` push job。
6. 不打印、不复制生产 token、密码、二维码或 `.env` 内容。

## 5. 生产环境门禁

生产 `.env` 至少必须显式提供：

- `NODE_ENV=production`
- `HOST=127.0.0.1`
- `DB_PATH`
- `RUNTIME_DATA_ROOT`
- `WORKSPACE_ROOT`
- `WORKSPACE_TEMPLATE_PATH`
- `INVEST_AGENT_WEIXIN_STATE_DIR`
- `INVEST_AGENT_API_TOKEN`
- `PLATFORM_ANONYMIZATION_SECRET`
- `PLATFORM_BOOTSTRAP_PASSWORD_FILE`
- `INVEST_AGENT_SANDBOX_SECRET`
- `CODEX_ACP_COMMAND=/home/claude/.local/bin/codex-acp`
- `CODEX_SOURCE_HOME=/home/claude/.codex`
- `CODEX_COMPLEX_MODEL`
- `ACP_SIMPLE_MODEL_ENABLED=false`
- 火山云 Portal/Relay connector 配置

秘密只在服务器本地生成和保存，文件权限应为 `600`；检查时只验证存在性、长度或权限，不输出值。

## 6. PM2 环境纪律

应用内部通过 dotenv 读取服务器 `.env`。`ecosystem.config.js` 只固定 `NODE_ENV`、`PORT` 和 `HOST`；不要把 ACP 命令、模型或秘密写进 PM2 ecosystem env。

PM2 会保留历史进程环境。仅执行 `restart --update-env` 不保证删除旧变量，因此发布后必须检查 PM2 进程环境中是否仍定义以下覆盖值：

- `CODEX_ACP_COMMAND`
- `CODEX_COMPLEX_MODEL`
- `CODEX_SIMPLE_MODEL`
- 其他已经迁入 `.env` 的 ACP 配置

如果发现旧值，使用干净 shell 重建进程：

```bash
cd /home/claude/invest-agent
pm2 delete invest-agent
pm2 start ecosystem.config.js
pm2 save
```

重建后再次确认 PM2 环境没有 ACP 覆盖值，并通过主进程执行一次只读 ACP 单点验收。不要在检查输出中打印 `.env`。

## 7. Workspace 显式升级

普通代码发布不会覆盖现有真实 Workspace。预检为 `migration_required` 且 `blockers=0` 时，按用户逐个执行：

```bash
npm run workspace:migrate -- \
  --workspace-root=/home/claude/invest-agent-data/workspaces \
  --template-root=/home/claude/invest-agent/templates/workspace \
  --user=<user> \
  --backup-root=/home/claude/invest-agent-data/workspace-compatibility-backups \
  --confirm=apply-managed-workspace-assets-v1
```

每个用户迁移后立即重跑预检，必须得到 `ready`。不得省略 `--user` 批量修改所有生产 Workspace。迁移只更新系统受管资产，不覆盖用户 `AGENTS.md`、配置、报告、记忆或自建 Skill。

## 8. 发布后最小验收

依次验证：

1. `curl http://127.0.0.1:22655/health` 返回正常。
2. `pm2 list` 中 `invest-agent` 为 `online`。
3. `/api/portal/health` 正常，生产 connector/relay 没有冲突。
4. `npm run smoke:mcp-service-tools` 通过。
5. 每个迁移用户的 Workspace 预检为 `ready`。
6. 微信实例仍为 `connected`，listener 已恢复。
7. 活动 push job 为 0，或每个活动 job 都有明确来源和处置计划。
8. 从本次 PM2 uptime 开始的日志没有新 `ERROR`、ACP `ENOENT` 或 scope 回退。
9. 选择一个已授权测试账号做只读主进程 ACP 单点验收：必须实际调用受限 MCP 读取事实，并与服务层同一 user/instance 的结果匹配；不要输出持仓明细。

验收应按变更点单点执行。除非用户明确授权，不给真实用户发送测试微信，不创建规则，不触发主动推送，不运行完整交易日流程。

## 9. 微信 `pushReady`

扫码连接与 listener 运行不等于主动推送就绪。`pushReady=false` 表示缺少当前可用的真实入站 conversation；真实用户下一次发消息后会恢复。不要为把状态改成 true 而擅自发送测试消息。

## 10. 回滚

### 代码回滚

1. 选择前一个已知正常的 `main` 提交或发布 worktree。
2. 通过普通代码发布脚本重新部署该提交。
3. 不回滚或覆盖数据库、Workspace、reviews、`.state` 和 `.env`。
4. 重新执行健康、MCP、微信 listener 和只读 ACP 单点验收。

### Workspace 回滚

代码回滚不会自动回滚已迁移的 Workspace。根据对应备份目录 `manifest.json` 恢复该用户的受管文件，保留迁移记录和审计证据，再重跑预检。

### 数据恢复

只有数据库或完整运行资产损坏时才走运行时恢复流程。恢复前先备份当前状态，即使当前状态已异常。

## 11. 当前已知限制

- `pushReady` 依赖真实用户入站会话，发布验收不能无副作用地强制恢复。
- 真实盘中提醒仍应按具体规则和采样窗口单点观察；规则巡检只判断 scheduler tick 可取得的当前/最新事实，不代表盘中曾触达或收盘确认。
- Platform 是内部管理面，不是公网用户门户。
- 当前生产模型和 ACP 路径由服务器 `.env` 决定；不得从本地 `.env.example` 推断生产值。
