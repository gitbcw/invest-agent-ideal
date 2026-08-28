# 火山云生产操作手册

> 当前基线：2026-08-20。本文是火山云日常发布、健康检查和回滚的当前操作手册。首次迁移阶段、旧端口方案和历史接管记录见 `volcano-runtime-migration-plan.md`，不得用历史步骤替代本手册。

## 1. 当前拓扑

```text
真实用户微信
  -> 火山云 invest-agent runtime
  -> workspace-scoped Codex ACP
  -> invest-agent-service-tools MCP
  -> SQLite / Workspace / scheduler / push

用户浏览器
  -> 火山云 mastra-portal :23657
  -> 火山云 relay :23658
  -> 火山云 invest-agent connector

管理员（密码验证直连）
  -> http://118.145.115.197:23655/platform
```

固定位置：

- 主机：`claude@118.145.115.197`
- runtime：`/home/claude/invest-agent-mastra`
- runtime data：`/home/claude/invest-agent-mastra/data`
- Workspace：由生产 `.env` 指定，属于服务器运行资产
- Portal：`/home/claude/invest-agent-mastra/apps/portal`（旧 `/home/claude/invest-agent-portal` 的 PM2 进程已停止，目录仅留存）
- PM2 进程：`invest-agent-mastra`（旧 `invest-agent` 已停止）
- runtime 端口：`0.0.0.0:23655`（公网可达；平台自身有密码验证。SSH 隧道方案已弃用——不稳定且繁琐，2026-08-21 owner 确认直连为正式访问方式）
- Portal：由 `mastra-portal` 提供（内部 `23657/23658`，以 PM2/env 的当前绑定为准）
- 生产 Portal 必须支持固定公网 IP + HTTP。当前火山云未配置域名备案，不能把 HTTPS 作为运行前提；Portal 前端不得依赖 secure-context-only API（例如 `crypto.subtle`），HTTP 下的预览、下载和附件校验必须可用。
- Relay：由 `mastra-portal` 提供，内部端口 `23658`
- 平台管理端：直接公网访问 `http://118.145.115.197:23655/platform`，凭平台密码登录

### （已弃用）macOS 持久 tunnel

隧道访问方案已弃用（autossh 在网络切换/睡眠后频繁掉线，维护成本高；2026-08-21 owner 确认直连 + 密码验证为正式方式）。以下仅为历史参考；本机如仍有 `~/Library/LaunchAgents/com.invest-agent.volcano-platform-tunnel.plist` 登录项属于遗留，确认直连正常后可移除：

```text
autossh -M 0 -N \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:23648:127.0.0.1:23655 \
  claude@118.145.115.197
```

历史检查方式（已不需要）：`launchctl kickstart -k gui/$(id -u)/com.invest-agent.volcano-platform-tunnel` 后访问 `http://127.0.0.1:23648/health`。

## 1.5 服务器资源基线（2026-08-15 死机加固）

- 规格：4 vCPU / 7.5G 内存 / 40G 盘（使用约 62%）。**此前无 swap**。
- 2026-08-15 事故：无 swap 内存耗尽活锁（kswapd 占满 4 核 sys 态、load ~220、PSI memfull 98%、sshd 无法完成握手），只能硬重启。atop 取证：`/var/log/atop/atop_20260815_until14:02:21`。
- 加固：`/swapfile` 4G 已启用并写入 fstab；`vm.swappiness=10` 持久化于 `/etc/sysctl.d/99-swap.conf`。
- openclaw-gateway（claw 用户 systemd user 服务，端口 18789）已按用户裁决完全卸载：进程/端口清零、npm 全局包移除（714 依赖）、user 单元删除、数据目录归档至 `/home/claw/openclaw-data-backup-20260815.tar.gz` 后删除。claw 用户的 `message-relay`（18790）亦已按用户裁决卸载（单元删除、目录归档至 `/home/claw/message-relay-backup-20260815.tar.gz`），并已 `loginctl disable-linger claw`——claw 用户服务不再随开机自启，整套 OpenClaw 残留清零。
- 服务器还承载 11 个 PM2 应用（invest-agent 全家桶 + market-data-tool/qsse/cockpit 等）+ MariaDB；发布新服务前先核对 `free -m` 可用内存（当前基线：已用 ~1.8G，可用 ~5.9G + 4G swap）。

## 2. 版本基线

  - `feat/mastra-migration` 是当前维护与生产发布基线；旧 `main` runtime 已停止。
- `codex/volcano-snapshot-*`、冻结标签和历史 reconciliation 分支只用于审计、比较和回滚，不继续修复、不整体 merge 回 `main`。
- 普通发布从 `/Users/combo/MyFile/projects/invest-agent-ideal-mastra` 的已审阅、已提交 `feat/mastra-migration` 执行，且 `HEAD` 必须解析为已提交的 Git 对象。
- 火山云运行代码始终以最近一次从该分支已提交 worktree 完成的发布为准；`111`、`dyk`、`mg` 的历史 Workspace 备份与迁移证据见 `docs/workspace-compatibility.md`。兼容模型 v2 起，`ready` 允许存在尚未采用的 `template_updates`。
- GitHub push、PR、生产部署是三个独立授权动作。生产快照不要求提交已进入 `origin/main`；脚本仅尽力刷新远端，并把本地相对 `origin/main` 的 `equal`、`ahead`、`behind`、`diverged` 或 `unavailable` 关系记录为非阻塞审计证据。

## 3. 两种发布模式

### 3.0 发布快照与标准入口

正式发布不再直接从调用者当前目录运行底层部署脚本。先从已提交的 `feat/mastra-migration` 创建代码发布快照，再从快照的临时干净目录发布：

```bash
npm run release:snapshot -- create
npm run release:deploy -- <release-id>
```

快照 manifest 以 `committed-local-feat/mastra-migration` 记录发布基线，同时记录远端刷新结果和关系。GitHub 不可达、本地领先、落后或分叉不会阻塞发布；规范仓库路径、干净工作树、目标分支、已提交 `HEAD` 和完整验证仍是硬门禁。

完成本手册第 8 节验收并保存证据后，才允许把版本标为 known-good：

```bash
npm run release:snapshot -- accept <release-id> --confirm=mark-known-good-v1
```

底层 `scripts/deploy-volcano.sh` 继续负责代码同步、构建、PM2 和健康检查，但正式发布与代码回退应由上述包装器调用。包装器会校验不可变 manifest、Git bundle、源归档和 Workspace 内容摘要；生产 `.deploy/release.json` 只记录 release ID、commit、操作类型和时间，不包含秘密。

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

模板工作区下的 `.codex` 模板目录已随 legacy workspace skills 裁撤（7b71ba2，2026-08-23）移出发布代码，不再同步；真实 Workspace 内的既有 `.codex` 副本属用户资产，由 workspaces 排除保护。禁止给 rsync 增加 `--delete-excluded`。

发布同步必须排除 `apps/portal/.next`，不能让源码 rsync 删除正在服务的 Portal 构建。远端安装阶段必须显式安装 Portal 依赖并执行 `apps/portal` 的 `next build`；构建前停止 `mastra-portal` 并把旧 `.next` 移到 `.deploy/portal-previous-*`。只有 `BUILD_ID`、服务端清单、路由清单和 `_error.js` 齐全后才能启动新进程；构建或验收失败时必须恢复旧 `.next` 并重新拉起旧版本。

### 3.2 运行时数据迁移或恢复

`volcano:package-runtime` / `volcano:apply-runtime` 会替换数据库、Workspace 或其他运行资产，不属于普通发布。只有用户明确要求数据迁移、快照恢复、生产数据替换或灾难恢复时才允许使用，并且必须：

1. 停止或冻结写入。
2. 创建并验证回滚备份。
3. 核对包 SHA256 和目标目录。
4. 使用脚本要求的精确确认短语。
5. 应用后执行 SQLite `quick_check`、Workspace 预检和真实链路单点验收。

如果一项变更既能走代码发布也能走数据替换，选择代码发布。

## 4. 发布前检查

1. 在规范仓库记录目标 `feat/mastra-migration` 提交，确认发布 worktree 干净；尽力刷新远端并记录关系，不以远端状态阻塞发布。
2. 本地运行：

```bash
npm run verify
```

3. 确认发布脚本仍保护所有生产运行资产。
4. 若 Workspace 模板有变化，对每个真实用户执行只读预检，记录 `template_updates`；这些更新不阻塞代码发布，也不授权替换用户文件：

```bash
npm run workspace:preflight -- \
  --workspace-root=/home/claude/invest-agent-mastra/data/workspaces \
  --template-root=/home/claude/invest-agent-mastra/templates/workspace \
  --user=<user>
```

5. 选择没有 scheduler 任务命中的维护窗口，确认没有活动 `pending` / `retry` / `processing` push job。
6. 不打印、不复制生产 token、密码、二维码或 `.env` 内容。

## 5. 生产环境门禁

生产 `.env` 至少必须显式提供：

- `NODE_ENV=production`
- `HOST=0.0.0.0`（平台公网直连 + 密码验证，隧道方案已弃用）
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
cd /home/claude/invest-agent-mastra
pm2 delete invest-agent
pm2 start ecosystem.config.js
pm2 save
```

重建后再次确认 PM2 环境没有 ACP 覆盖值，并通过主进程执行一次只读 ACP 单点验收。不要在检查输出中打印 `.env`。

## 7. Workspace 模板采用

普通代码发布不会覆盖现有真实 Workspace。预检中的 `template_updates` 只是可选更新；没有用户或负责人对具体文件的明确决定时，不执行任何 Workspace 修改。

明确决定采用某个标准模板文件后，按用户和精确相对路径执行：

```bash
npm run workspace:adopt-template -- \
  --workspace-root=/home/claude/invest-agent-mastra/data/workspaces \
  --template-root=/home/claude/invest-agent-mastra/templates/workspace \
  --user=<user> \
  --assets=<exact-relative-path> \
  --backup-root=/home/claude/invest-agent-data/workspace-compatibility-backups \
  --confirm=adopt-template-assets-v1
```

不得省略 `--user`，不得使用目录或通配符批量覆盖。操作前审阅差异，操作后核对外部备份并重新预检。硬契约变更应通过服务代码、MCP schema、权限、确认或调度门禁发布，不通过强制同步 Skill 实现。

## 8. 发布后最小验收

依次验证：

1. `curl http://127.0.0.1:23655/health` 返回正常。
2. `pm2 list` 中 `invest-agent` 为 `online`。
3. Portal `/api/health`、`/login` 和至少一个由登录页引用的 `/_next/static` 哈希资源均正常，生产 connector/relay 没有冲突。仅凭 `/api/health` 或 PM2 `online` 不足以判定 Portal 构建健康。
4. `npm run smoke:mcp-service-tools` 通过。
5. 每个 Workspace 预检没有 blocker；`template_updates` 可以继续存在。
6. 微信实例仍为 `connected`，listener 已恢复。
7. 活动 push job 为 0，或每个活动 job 都有明确来源和处置计划。
8. 从本次 PM2 uptime 开始的日志没有新 `ERROR`、ACP `ENOENT` 或 scope 回退。
9. 选择一个已授权测试账号做只读主进程 ACP 单点验收：必须实际调用受限 MCP 读取事实，并与服务层同一 user/instance 的结果匹配；不要输出持仓明细。

验收应按变更点单点执行。除非用户明确授权，不给真实用户发送测试微信，不创建规则，不触发主动推送，不运行完整交易日流程。

## 9. 微信 `pushReady`

扫码连接与 listener 运行不等于主动推送就绪。`pushReady=false` 表示缺少当前可用的真实入站 conversation；真实用户下一次发消息后会恢复。不要为把状态改成 true 而擅自发送测试消息。

## 10. 回滚

### 代码回滚

1. 选择前一个已验收的 known-good 发布快照。
2. 使用精确确认短语触发代码回退。脚本先只读备份当前三个真实 Workspace，再从目标快照的临时干净目录走普通代码发布：

```bash
npm run release:rollback -- <release-id> --confirm=rollback-code-v1
```

3. 不回滚或覆盖数据库、Workspace、reviews、`.state` 和 `.env`。
4. 重新执行健康、MCP、微信 listener 和只读 ACP 单点验收。

### Workspace 回滚

代码回滚不会自动回滚用户文件。需要处理 Workspace 时，先生成当前状态与目标发布快照的只读差异库存，由 Codex 在两个脱敏快照上生成逐文件 `proposal.json` 和候选文件：

```bash
npm run release:workspace-rollback -- plan <release-id>
npm run release:workspace-rollback -- validate <run-id>
```

人工审阅并逐项批准后，才允许执行生产应用：

```bash
npm run release:workspace-rollback -- apply <run-id> \
  --approval=<absolute-approval-json> \
  --confirm=apply-approved-workspace-files-v1 \
  --target=production
```

应用器会重新核对生产输入 hash，在 Workspace 外保存原文件，逐文件原子替换并重新运行预检。未批准、发生漂移、hash 不匹配、符号链接或越权路径都会拒绝。执行后仍需做针对性的只读 ACP 单点验收。完整审计契约见 `docs/version-snapshot-and-assisted-rollback-plan.md`。

### 数据恢复

只有数据库或完整运行资产损坏时才走运行时恢复流程。恢复前先备份当前状态，即使当前状态已异常。

## 11. 当前已知限制

- `pushReady` 依赖真实用户入站会话，发布验收不能无副作用地强制恢复。
- 真实盘中提醒仍应按具体规则和采样窗口单点观察；规则巡检只判断 scheduler tick 可取得的当前/最新事实，不代表盘中曾触达或收盘确认。
- Platform 是内部管理面，不是公网用户门户。
- 当前生产模型和 ACP 路径由服务器 `.env` 决定；不得从本地 `.env.example` 推断生产值。
