# 火山云生产运行时迁移计划

> 历史状态说明（2026-07-23）：首次生产迁移和切主已经完成，当前真实 Workspace 为 `111`、`dyk`、`mg`。本文保留迁移阶段、拓扑形成过程和数据替换回滚背景；日常代码发布、健康检查和当前生产基线一律使用 `server-deployment.md`。不得因为本文保留了 `package/apply` 示例，就把数据替换路径用于普通版本发布。

## 背景与意图

迁移前，`invest-agent-ideal` 曾同时承担本地开发、测试和实际运行职责：Platform/Dashboard、SQLite、workspace、Codex ACP、微信监听、scheduler、复盘、巡检、portal connector 都在本机进程内。该阶段目标是把实际生产运行环境迁到火山云服务器，把本机恢复为开发/测试环境，降低本地断网/断电对微信推送、定时复盘和 portal 在线状态的影响。

第一阶段不是重做用户门户，也不是多租户平台化，而是把当前这套 invest-agent 服务作为“生产运行时”部署到火山云，先服务现有用户助手。本机不必停止服务；它可以继续作为开发/测试 runtime。

当前拓扑已经收敛为两套闭环：本机 platform/runtime 连接阿里云 portal/relay；火山云 platform/runtime 连接火山云 portal/relay。不要再把火山云生产 runtime 默认接回阿里云 relay；如果临时需要这么做，必须显式覆盖 `PORTAL_PUBLIC_URL` / `PORTAL_RELAY_URL` 并在操作记录中说明原因。

## 火山云当前资源信息

已知目标服务器：

- SSH：`claude@118.145.115.197`，端口 `22`。
- 应用端口段：`22640-22650`，用于部署 HTTP 服务，不是 SSH。
- 当前 PM2 进程：
  - `ai-project-cockpit`：`22642`，团队 Cockpit Next.js。
  - `ai-project-cockpit-mcp`：`22643`，团队 Cockpit MCP。
- 当前 systemd 自定义服务：
  - `nginx`：`80`。
  - `mariadb`：`3306`。
  - `nbr-api-22645`：`22645`。
  - `filebox`：`18884`。
  - `php-fpm`、`proxima` 等另行对账。
- 其他已监听但归属待对账端口：`18789-18792`、`18881`、`18885-18887`、`3000`、`35729`、`8001`。
- 已释放可复用端口：`18880`、`18883`、`22640`、`22641`、`22646`、`22647`、`22648`。

端口结论：

- 火山云第一阶段使用 `22648` 作为管理员本机 SSH tunnel 端口，不作为服务器侧 invest-agent 监听端口。
- 服务进程内部仍建议监听 `127.0.0.1:22655`，因为当前 workspace 模板、mobile prompt 和 sandbox 工具说明仍大量使用 `http://127.0.0.1:22655`。直接把服务端口改成 `22648` 会导致 Codex ACP 在 workspace 内调用本地 sandbox API 时找不到服务，除非同步改模板和所有硬编码提示。
- 因此推荐入口形态是：`22648` 外部/SSH tunnel/Nginx 入口 -> `127.0.0.1:22655` 内部服务。

注：用户记录中提到 `22550` 基本空闲，疑似应为 `22650`；执行前需要用 `ss -lntp` 对账。

## 目标

- 在火山云上常驻运行 `invest-agent` 服务，内部端口仍为 `22655`，服务器管理入口优先使用已释放的 `22648`。
- 服务器运行时拥有独立的 SQLite、workspace、reviews、runtime data、微信登录态和 Codex ACP 配置。
- 本机保留开发/测试环境；它可以继续运行服务，但不应以生产助手身份连接阿里云 relay，也不应处理生产微信监听、生产 portal connector 和生产 scheduler。
- Platform 可以远程访问，但必须经过白名单、SSH tunnel 或等价访问控制，不裸露给公网。
- 迁移后定时复盘、盘中简报、规则巡检、微信主动推送、portal connector 在线状态可以在服务器重启后自动恢复。

## 非目标

- 不把 `/platform` 改造成普通用户门户。
- 不在云端另起一套业务逻辑或第二套 workspace 读写协议。
- 不在第一阶段做完整多用户租户权限系统。
- 不迁移历史实验环境、旧 Hermes 后端或归档文档中的旧端口方案。
- 不让同一个用户助手同时由本机和火山云两个 connector 处理 portal 消息。

## 当前调研结论

### 代码与配置现状

- 服务入口：`src/index.ts` 启动 HTTP、ACP、scheduler、portal connector。
- HTTP 监听：`src/server.ts` 当前固定 `host: "0.0.0.0"`，因此如果服务器安全组开放 `22655`，Platform 会被公网访问到。
- PM2 配置：`ecosystem.config.js` 已存在，但 env 只覆盖了 `PORT`、`WEIXIN_AUTO_START`、`INVEST_AGENT_WEIXIN_STATE_DIR`。
- 火山云脚本：`scripts/deploy-volcano.sh` 已存在，默认 `claude@118.145.115.197:~/invest-agent`，会 rsync 代码、`npm install`、`npm run build`、`npm run smoke`、PM2 restart/start。
- 当前本机默认运行时路径：
  - `DB_PATH=./data/invest-agent.db`
  - `RUNTIME_DATA_ROOT=./data`
  - `WORKSPACE_ROOT=/Users/combo/MyFile/my-data/projects/invest-agent-ideal/workspaces`
  - `INVEST_AGENT_WEIXIN_STATE_DIR=./.state`
  - `CODEX_ACP_COMMAND=/Users/combo/.local/bin/codex-acp`
  - `CODEX_SOURCE_HOME=/Users/combo/.codex`

### Codex CLI / ACP 现状

- 本机 `codex` 来自 `@openai/codex`，当前版本显示为 `codex-cli 0.128.0`。
- 本机 `codex-acp` 是旧 shell shim：

```bash
exec npx -y @zed-industries/codex-acp "$@"
```

- 2026-07-07 火山云预检发现旧包会提示 deprecated，替代包为 `@agentclientprotocol/codex-acp`；服务器 shim 已改用新包。
- OpenAI 官方 Codex CLI 文档说明：Linux/macOS 可用 standalone installer，也可用 `npm install -g @openai/codex`；首次运行 `codex` 需要登录 ChatGPT 账号或 API key。参考：
  - https://developers.openai.com/codex/cli
  - https://developers.openai.com/codex/quickstart
- 生产服务器上需要把 CLI 登录态、`CODEX_SOURCE_HOME`、`codex-acp` 命令入口和 PM2 运行用户对齐。不要把本机 `/Users/combo/...` 路径带到服务器。

### 2026-07-07 只读预检结果

火山云服务器只读探测：

- SSH 可用：`claude@118.145.115.197`。
- Node.js：`v22.22.0`。
- npm：`10.9.4`。
- PM2：`6.0.14`。
- PM2 当前仅有 `ai-project-cockpit`、`ai-project-cockpit-mcp` 两个在线进程。
- `22648` 未监听；`22642`、`22643`、`22645` 已占用。
- 预检前 `codex`、`codex-acp` 未安装或不在 `PATH`；随后已安装 `@openai/codex`，版本 `codex-cli 0.142.5`，并创建 `~/.local/bin/codex-acp`。
- `/home/claude/.local/bin` 存在；`~/invest-agent`、`~/invest-agent-data`、`~/.codex` 当前不存在或未初始化。
- `codex doctor` 显示当前没有 Codex credentials。
- 服务器可访问 npm registry，但 `api.openai.com:443` 与 `chatgpt.com:443` 均连接超时；`codex doctor` 也提示 WebSocket 超时、ChatGPT reachability 失败。
- 采用 API key 认证后，火山云 Codex 已配置为与本机同类的 `codex-ai` provider：`base_url = "http://47.107.151.70:3000/v1"`，`wire_api = "responses"`，`requires_openai_auth = true`。
- `~/.codex/auth.json` 已写入独立生产 API key，权限 `600`；服务 `.env` 不重复保存该 key。
- `codex doctor` 已通过：`17 ok · 0 warn · 0 fail`。
- `codex exec --skip-git-repo-check "Reply with exactly: codex-ready"` 已返回 `codex-ready`。
- 空跑部署已完成：`invest-agent` 通过 PM2 online，内部监听 `127.0.0.1:22655`，公网 `22655` 不可访问。
- `/api/chat` smoke 已通过：服务器创建测试 workspace `server-smoke`，Codex complex `gpt-5.6-terra` 返回 `volcano-ready`；测试 workspace 已删除。

由此确认 Phase 1 已完成；当前服务器是空跑 runtime，可进入 Phase 2 数据迁移预备。

## 推荐目标拓扑

```text
本机 Mac
  - 开发 / 测试 runtime
  - 本地 DB/workspace 可保留为测试数据
  - 不启动生产微信监听
  - 不启动生产 portal connector

火山云服务器
  invest-agent service :22655 (bind 127.0.0.1 only)
    - Platform / Dashboard
    - SQLite: /home/claude/invest-agent/data/invest-agent.db
    - Workspace: /home/claude/invest-agent-data/workspaces
    - Runtime data: /home/claude/invest-agent/data
    - Weixin state: /home/claude/invest-agent/.state
    - Codex source home: /home/claude/.codex
    - Codex ACP child process
    - scheduler / review / watch rules
    - portal connector

访问控制
  方案 A: 22655 只监听 127.0.0.1，通过 SSH tunnel 把本机 22648 映射到服务器 22655
  方案 B: Nginx/Caddy 监听 22648/HTTPS，反代到 127.0.0.1:22655，只允许白名单 IP 或 Basic Auth + 白名单
```

## 访问控制方案评估

### 方案 A：SSH tunnel 管理 Platform（推荐第一阶段）

服务只在服务器本地监听，管理员本机执行：

```bash
ssh -L 22648:127.0.0.1:22655 claude@118.145.115.197
```

然后本机浏览器打开：

```text
http://127.0.0.1:22648/platform
```

优点：

- Platform 不直接暴露公网，风险最低。
- 不依赖公网 IP 白名单是否变化。
- 与当前“本电脑可 SSH 到火山云”的条件匹配。

需要代码/配置支持：

- 当前 `src/server.ts` 固定监听 `0.0.0.0`。严格 SSH-only 需要新增 `HOST` / `BIND_HOST` 环境变量，并在生产设为 `127.0.0.1`。
- 如果暂不改代码，也可以靠云安全组关闭 `22655` 入站，但进程本身仍监听公网网卡；不如显式 bind 到 `127.0.0.1` 干净。

### 方案 B：公网反代 + 白名单

Nginx/Caddy 监听 `22648` 或 HTTPS，把 `/platform`、`/dashboard` 反代到 `127.0.0.1:22655`，并做 IP allowlist 或 Basic Auth。

优点：

- 不需要每次 SSH tunnel。
- 手机或其他管理设备可以访问。

风险：

- Platform 是运维面，包含微信连接、实例管理、审计等能力。白名单配置错误会直接暴露高权限管理面。
- 家宽/移动网络 IP 变化会造成维护成本。

建议：

- 第一阶段用 SSH tunnel。
- 需要公网管理时再加反代，且至少满足：HTTPS、IP allowlist、Basic Auth、禁止普通用户访问 `/platform` 和 `/api/platform/*`。

## 前置准备清单

### 火山云服务器

- Linux x86_64 或 arm64，Node.js 22+。
- `git`、`rsync`、`npm`、`pm2`、`curl`、`jq`。
- `sqlite3` 建议安装；如未安装，迁移脚本会回退到项目依赖 `better-sqlite3` 做表清单和 `quick_check`。
- 系统时间与时区确认，建议 Asia/Shanghai。
- 防火墙/安全组策略：
  - SSH 端口仅允许管理员来源。
  - 第一阶段不开放 `22655` 入站，使用 SSH tunnel。
  - 如需要固定管理入口，开放 `22648` 前必须先配置 Nginx/Caddy 白名单或 Basic Auth。
  - 如果开放 HTTP/HTTPS，必须走 Nginx/Caddy 访问控制。

### Codex CLI 与 ACP

在服务器 PM2 用户下安装和登录：

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex
```

或使用 npm 方式：

```bash
npm install -g @openai/codex
codex
```

然后创建 `codex-acp` shim：

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/codex-acp <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec npx -y @agentclientprotocol/codex-acp "$@"
EOF
chmod +x ~/.local/bin/codex-acp
```

验证：

```bash
which codex
codex --version
which codex-acp
codex-acp --help
```

注意：

- `codex` 登录态应属于运行 `pm2` 的同一 Linux 用户。
- 如果用 API key，必须放在服务器环境变量或 Codex 官方支持的认证路径里，不提交到仓库。
- `CODEX_SOURCE_HOME` 设为该用户的 `~/.codex`。

### 生产 `.env`

建议服务器 `.env` 显式配置，不依赖本机默认路径：

```env
PORT=22655
HOST=127.0.0.1
NODE_ENV=production

DB_PATH=./data/invest-agent.db
RUNTIME_DATA_ROOT=./data
WORKSPACE_ROOT=/home/claude/invest-agent-data/workspaces
WORKSPACE_TEMPLATE_PATH=./templates/workspace

INVEST_AGENT_WEIXIN_STATE_DIR=./.state
INVEST_AGENT_SANDBOX_SECRET=<stable-random-secret>
WEIXIN_AUTO_START=true

ACP_BACKEND=codex
CODEX_ACP_COMMAND=/home/claude/.local/bin/codex-acp
CODEX_ACP_CWD=/home/claude/invest-agent
CODEX_SOURCE_HOME=/home/claude/.codex
CODEX_ACP_TIMEOUT_MS=1800000
CODEX_SIMPLE_MODEL=gpt-5.4-mini
CODEX_COMPLEX_MODEL=gpt-5.5
ACP_SIMPLE_MODEL_ENABLED=false

PORTAL_CONNECTOR_AUTO_START=true
PORTAL_RELAY_URL=<current-relay-ws-url>
PORTAL_CONNECTOR_TOKEN=<production-token>
```

当前代码已支持 `HOST` / `BIND_HOST`，服务器 `.env` 已设置 `HOST=127.0.0.1`，并验证公网不能直接访问 `22655`。

当前 Codex ACP shell 工具沙箱实际可能是 `network_access=false`，workspace 内 `curl http://127.0.0.1:22655` 会因为 `--unshare-net` 失败。长期处理方式不是打开 `agent-full-access`，而是在 Codex ACP `session/new` 时挂载项目自带的 `invest-agent-service-tools` stdio MCP server。

这个 MCP server 在服务进程外以子进程方式启动，但直接复用本项目的服务层模块和 workspace backend，不依赖 shell 网络。读取工具包括 `market.snapshot`、`market.quote`、`market.health`、`portfolio.read`、`watchlist.read`、`plans.read`。除 scheduled `reviews.save` 外，写入前必须先用 `confirmations.request` 登记精确草案，用户下一轮确认后再携带一次性 `confirmationId` 和 `confirmedByUser: true` 写入。服务层不再把 `marketSnapshot` 预注入 prompt，避免污染上下文；行情、持仓、预案和规则事实都由 Codex 通过 MCP 按需读取。

如果后续决定让服务进程本身监听 `22648`，必须同步完成一轮端口参数化改造：

- `templates/workspace/AGENTS.md`
- `templates/workspace/skills/market-watch/*.md`
- `templates/workspace/skills/wechat-onboarding/prompt.md`
- `src/acp/mobile-prompt.ts`
- 所有写死 `127.0.0.1:22655` 的 sandbox API 调用说明

第一阶段不建议这样做，保持内部 `22655` 更稳。

## 数据迁移策略

### 推荐：生产从“可控迁移快照”启动

迁移内容：

- SQLite：`data/invest-agent.db`、同目录 `*.db-wal`、`*.db-shm`。
- Workspace：当前生产用户的 `WORKSPACE_ROOT`，本机是 `/Users/combo/MyFile/my-data/projects/invest-agent-ideal/workspaces`。
- 复盘文件：`reviews/`。
- Runtime data：`data/source-telemetry/`、`data/source-quality/` 等。
- 可选：`.state` 微信登录态不建议迁移，第一阶段推荐服务器重新扫码。

迁移步骤：

1. 停止本机生产服务，避免 SQLite 和 workspace 在复制时继续写入。
2. 生成本机迁移包：

```bash
CONFIRM_PRODUCTION_STOPPED=true npm run volcano:package-runtime
```

默认包会写到 `.tmp/volcano-migration/invest-agent-runtime-<timestamp>.tgz`，内容包括：

- `invest-agent.db`，以及存在时的 `invest-agent.db-wal` / `invest-agent.db-shm`。
- `reviews/`。
- `source-quality/`、`source-telemetry/`。
- workspace 根目录 `/Users/combo/MyFile/my-data/projects/invest-agent-ideal/workspaces`。

3. 上传到服务器：

```bash
scp .tmp/volcano-migration/invest-agent-runtime-<timestamp>.tgz \
  claude@118.145.115.197:/home/claude/
```

4. 在服务器停掉空跑进程并解包：

```bash
ssh claude@118.145.115.197
pm2 stop invest-agent
cd /home/claude/invest-agent
PACKAGE=/home/claude/invest-agent-runtime-<timestamp>.tgz
EXPECTED_PACKAGE_SHA256="$(sha256sum "$PACKAGE" | awk '{print $1}')" \
EXPECTED_REMOTE_APP_DIR=/home/claude/invest-agent \
CONFIRM_RUNTIME_APPLY=replace-runtime-and-data \
bash scripts/apply-volcano-runtime.sh "$PACKAGE"
pm2 restart invest-agent --update-env
```

5. 服务器启动前/启动后跑只读核对：

```bash
sqlite3 data/invest-agent.db '.tables' # 可选；无 sqlite3 时使用迁移脚本内置校验
find /home/claude/invest-agent-data/workspaces -maxdepth 2 -name AGENTS.md -print
curl -fsS http://127.0.0.1:22655/health
```

说明：

- `scripts/package-volcano-runtime.sh` 会要求 `CONFIRM_PRODUCTION_STOPPED=true`，防止误打热快照。
- `scripts/apply-volcano-runtime.sh` 要求目标目录、包 SHA256 和明确确认短语全部匹配；随后先备份服务器现有 `data/invest-agent.db`、`reviews/` 和 `workspaces/` 到 `/home/claude/invest-agent-data/migration-backups/<timestamp>`，并验证包内及备份数据库完整性后才覆盖。
- `scripts/apply-volcano-runtime.sh` 会在解包后统一修正 workspace 内 `.codex/config.toml` / `mcp.json`，指向服务器 `/home/claude/.codex`，避免把本机 `/Users/combo/.codex/...` 断链带到生产。
- 不迁移 `.state` 微信登录态，正式切主时服务器重新扫码。

### 替代：服务器从空数据启动

适合只想先验证运行时，不承接现有生产用户历史。需要重新 onboarding、重新配置持仓/自选/规则，不适合作为正式切主。

## 分阶段执行计划

### Phase 0：补齐迁移前代码/配置

交付：

- [x] `src/lib/config.ts` 增加 `host`，从 `HOST` / `BIND_HOST` 读取，默认仍为 `0.0.0.0`。
- [x] `src/server.ts` 使用配置监听，而不是硬编码 `0.0.0.0`。
- [x] `.env.example` 增加服务器相关变量示例：`HOST`、`WORKSPACE_ROOT`、`RUNTIME_DATA_ROOT`、`WORKSPACE_TEMPLATE_PATH`。
- [x] `ecosystem.config.js` 生产默认 `HOST=127.0.0.1`。
- [x] `scripts/deploy-volcano.sh` 默认只 build，不默认跑全量 `npm run smoke`；可用 `RUN_SMOKE=true` 显式开启；部署完成提示 SSH tunnel 到本机 `22648`。
- [x] 新增 `scripts/package-volcano-runtime.sh` 和 `scripts/apply-volcano-runtime.sh`，用于 Phase 2 可重复打包/解包生产运行时数据。

验收：

- 本地 `npm run build` 通过。
- 本地不设置 `HOST` 时仍可照常访问。
- 设置 `HOST=127.0.0.1` 时服务只监听本地。

### Phase 1：服务器安装与空跑

当前状态：

- [x] Node.js / npm / PM2 已满足。
- [x] Codex CLI 已安装：`codex-cli 0.142.5`。
- [x] `~/.local/bin/codex-acp` 已创建，使用 `@agentclientprotocol/codex-acp`。
- [x] Codex API key 认证已完成。
- [x] Codex 使用 `codex-ai` provider，经 `http://47.107.151.70:3000/v1` 访问；不依赖服务器直连 `api.openai.com`。
- [x] `codex doctor` 与 `codex exec` smoke 已通过。
- [x] 服务器 `.env` 已创建，空跑阶段 `WEIXIN_AUTO_START=false`、`PORTAL_CONNECTOR_AUTO_START=false`。
- [x] `invest-agent` 已通过 PM2 启动并保存；内部监听 `127.0.0.1:22655`。
- [x] `/health` 正常。
- [x] `/api/chat` 端到端 Codex smoke 正常。

步骤：

1. SSH 登录火山云。
2. 安装 Node.js 22+、npm、pm2、jq；`sqlite3` 建议安装但不是硬依赖。
3. 安装并登录 Codex CLI。
4. 创建 `codex-acp` shim。
5. rsync 代码到 `/home/claude/invest-agent`。
6. 配置服务器 `.env`。
7. `npm install && npm run build`。
8. `pm2 start ecosystem.config.js --update-env`。
9. `curl http://127.0.0.1:22655/health`。

验收：

- `codex doctor` 至少不再报 auth 缺失和 OpenAI/ChatGPT reachability 失败。
- `codex exec --skip-git-repo-check "Reply with exactly: codex-ready"` 能返回 `codex-ready`。
- `pm2 list` 中 `invest-agent` online。
- `pm2 logs invest-agent` 无启动错误。
- `/api/acp-backends` 显示 Codex backend ready 或可懒启动。当前 `/health` 的 backend ready 字段仍显示 `false`，但真实 `/api/chat` 端到端 Codex smoke 已通过，判断是状态接口未反映懒启动/模型域实例，不阻塞 Phase 1。
- `/api/portal/health` 正常。
- 不开放公网 `22655` 时，从外网无法直接访问。

当前待生产化处理：

- 空跑 `.env` 中 `INVEST_AGENT_SANDBOX_SECRET` 仍是占位值，正式切主前必须替换为稳定随机密钥。
- 空跑阶段微信和 portal connector 均关闭，正式切主前再开启。
- 服务器当前是空 SQLite/空 workspace，尚未迁移真实用户数据。
- 2026-07-07 曾从阿里云 `/home/admin/invest-agent-portal/.env.production` 读取现有 portal token，用于第一轮 relay 接管实验；该段是历史过渡状态，不再是当前默认生产拓扑。历史配置为：
  - `PORTAL_PUBLIC_URL=http://47.107.151.70:8088`
  - `PORTAL_RELAY_URL=ws://47.107.151.70:18088/`
  - `PORTAL_DISTRIBUTION_URL=http://47.107.151.70:8088/api/internal/distribution/provision`
  - `PORTAL_CONNECTOR_ID_PREFIX=volcano-prod`
  - `PORTAL_CONNECTOR_RUNTIME_LABEL=火山云生产`
  - `PORTAL_CONNECTOR_AUTO_START=false`
- 阿里云 relay 日志显示当前仍有本机 `local-invest-agent-dyk` connector 服务 `invest-agent-dyk`；火山云生产 connector 启用前必须先确认不会抢同一助手。
- 2026-07-07 已完成 `111` / `dyk` 两个用户的火山云接管：
  - 本机快照包：`.tmp/volcano-handover-111-dyk/invest-agent-runtime-20260707-193613.tgz`。
  - 火山云应用包：`/home/claude/invest-agent-runtime-20260707-193613.tgz`。
  - 火山云迁移备份：`/home/claude/invest-agent-data/migration-backups/20260707-193703`。
  - 火山云 `.env` 已设置 `PORTAL_CONNECTOR_AUTO_START=true`。
  - 火山云 `.env` 已设置 `PORTAL_CONNECTOR_INCLUDE_ASSISTANTS=invest-agent-111,invest-agent-dyk`，因此只注册这两个助手。
  - 阿里云 relay 已部署接管策略：`volcano-prod-*` connector 可接管旧的低优先级本机 connector。
  - 阿里云 relay 日志确认 `volcano-prod-invest-agent-dyk` 接管 `local-invest-agent-dyk`，`volcano-prod-invest-agent-111` 接管 `local-invest-agent-111`。
  - 本机 `.env` 已追加 `PORTAL_CONNECTOR_EXCLUDE_ASSISTANTS=invest-agent-111,invest-agent-dyk`，下次本机服务重启后不再注册这两个助手。
- 2026-07-07 进一步纠正为“两套闭环”：
  - 本机 platform/runtime 继续连接阿里云 portal/relay：`http://47.107.151.70:8088` / `ws://47.107.151.70:18088/`。
  - 火山云 platform/runtime 连接火山云 portal/relay：公网用户入口 `http://118.145.115.197:22649`，服务器内网 Relay `ws://127.0.0.1:22650/`。
  - 火山云 portal 部署目录：`/home/claude/invest-agent-portal`，PM2 进程名 `invest-agent-portal`。
  - 火山云 portal 使用独立 token 和 cookie name `portal_session_volcano`，数据库由阿里云 portal 快照初始化。
  - 火山云 invest-agent `.env` 已切换 `PORTAL_PUBLIC_URL=http://118.145.115.197:22649`、`PORTAL_RELAY_URL=ws://127.0.0.1:22650/`、`PORTAL_DISTRIBUTION_URL=http://127.0.0.1:22649/api/internal/distribution/provision`。
  - 火山云 portal relay 日志确认 `volcano-prod-invest-agent-111` / `volcano-prod-invest-agent-dyk` 已注册。
  - 本机 invest-agent 已重启并应用 exclude；阿里云 relay 日志确认 `local-invest-agent-111` / `local-invest-agent-dyk` 已断开，仅 `local-invest-agent-primary` 重新注册。
  - 本机访问火山云 platform：`ssh -L 22648:127.0.0.1:22655 claude@118.145.115.197` 后打开 `http://127.0.0.1:22648/platform`。
  - 用户公网访问火山云 portal：`http://118.145.115.197:22649/login` 或 `http://118.145.115.197:22649/chat`。
  - 管理员也可用 tunnel 访问火山云 portal：`ssh -L 22651:127.0.0.1:22649 claude@118.145.115.197` 后打开 `http://127.0.0.1:22651/login`。
  - `scripts/configure-volcano-portal-env.sh` 默认值已更新为火山云 portal/relay；如果要指向阿里云，必须显式传入阿里云 URL。

### Phase 2：数据迁移与只读核对

步骤：

1. 不必停止本机开发服务；但如果要迁移真实生产快照，必须先冻结生产写入，确保本机不再以生产身份接收微信、scheduler 或 portal connector 写入。
2. 打包 SQLite、workspace、reviews、runtime data。
3. 上传并解压到服务器。
4. 检查 workspace 数量、用户助手、持仓/自选/规则配置。
5. 启动服务器服务，但暂不扫码微信。
6. 通过 SSH tunnel 打开 `/platform` 核对实例列表、trace、配置。

验收：

- 服务器 `/platform#instances` 能看到预期用户助手。
- `buildDailyReviewContext({ userId })` 或 `/api/sandbox/reviews/context` 能读到生产持仓/自选。
- 不出现本机绝对路径 `/Users/combo/...` 作为运行时路径。
- 数据迁移脚本的 `sqlite quick_check` 返回 `ok`。

### Phase 3：微信与 portal 灰度

步骤：

1. 将火山云 `.env` 的 portal 配置切到火山云生产 relay：

```bash
PORTAL_CONNECTOR_TOKEN=<portal production connector token> \
PORTAL_DISTRIBUTION_TOKEN=<portal production distribution token> \
npm run volcano:configure-portal
```

2. 初次配置时保持 `PORTAL_CONNECTOR_AUTO_START=false`，先重启验证服务健康。
3. 对测试助手开启 connector 或单独运行 `npm run portal:connector`，检查火山云 portal 显示该助手在线。
4. 在服务器 Platform 中对测试助手扫码微信。
5. 让该微信主动发一条消息，形成真实 conversation。
6. 测试主动推送 `/weixin/push/test`。
7. 启动/确认项目级微信监听。
8. 正式启用生产 connector：`PORTAL_CONNECTOR_AUTO_START=true`，并确认本机没有以同一 `assistantId` 注册任一生产 relay。

验收：

- 入站微信消息能进入服务器日志和 conversation log。
- 主动推送成功收到。
- portal connector heartbeat 正常，断线可重连。
- 本机可继续运行开发服务，但不得以同一生产 `assistantId` 连接阿里云 relay。

### Phase 4：正式切主

步骤：

1. 确认火山云 portal/relay 为 `http://118.145.115.197:22649` / `ws://127.0.0.1:22650/`。
2. 确认火山云生产 runtime 已迁入正式数据，并以 `volcano-prod-*` connector identity 注册火山云 relay。
3. 确认本机 connector 未抢同一正式助手；本机服务可继续作为 dev/test 运行。
4. 服务器对正式助手扫码或恢复服务器微信登录态。
5. 正式用户发送一条微信消息，建立 conversation。
6. 开启 scheduler 和自动复盘/盯盘配置。
7. 观察一个完整交易日。

验收：

- 微信普通问答正常。
- 日复盘能生成、保存、推送。
- 盘中简报/规则巡检按配置执行。
- portal 在线，网页消息能进入同一 workspace ACP。
- 本机开发环境不会以生产助手身份收到或处理 portal 消息。

## 回滚方案

触发条件：

- Codex ACP 在服务器无法稳定响应。
- 微信监听无法恢复或主动推送失败。
- SQLite/workspace 数据迁移异常。
- Platform 暴露或访问控制配置有误。

回滚步骤：

1. `pm2 stop invest-agent` 停止服务器 runtime。
2. 关闭服务器 portal connector 或从 relay 下线该 connector。
3. 本机恢复生产 `.env` 和数据快照。
4. 本机启动服务，扫码/恢复微信监听。
5. 让用户微信发送一条消息确认 conversation 和主动推送。

要求：

- 切主前必须保留本机完整数据快照。
- 正式切主当天不要同时在两边修改 workspace 配置。

## 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Platform 裸露公网 | 高权限管理面被访问 | 第一阶段 SSH tunnel；如公网必须 Nginx allowlist + Basic Auth |
| Codex auth 不属于 PM2 用户 | ACP 子进程不可用 | 在运行 PM2 的同一用户下安装/登录 Codex |
| 本机和服务器同时在线 | 同一助手 portal 消息冲突或重复处理 | 本机可以运行 dev/test；生产助手只允许火山云 connector 注册，使用 `PORTAL_CONNECTOR_ID_PREFIX=volcano-prod` 区分身份 |
| SQLite 热复制损坏 | 数据异常或启动失败 | 停服务后复制；保留 WAL/SHM；迁移后用迁移脚本 quick_check 检查 |
| 微信扫码不等于可推送 | 定时推送失败 | 必须让用户主动发一条消息形成 conversation |
| 服务器路径仍用本机默认值 | workspace 或 Codex 找不到 | 生产 `.env` 显式设置所有路径 |
| 部署脚本覆盖数据 | 生产数据丢失 | rsync exclude `data`、`reviews`、`.state` 保留；数据迁移单独脚本 |
| workspace 运行态从本机带到服务器 | Codex config/auth 断链或错用本机路径 | apply 脚本统一修正 `.codex` 链接；服务启动时也会幂等修正 config symlink |
| Codex 工具沙箱无网络 | workspace 内 curl 本地服务 API 失败 | Codex ACP 会话挂载 `invest-agent-service-tools` stdio MCP 作为读写主路径；不做行情事实 prompt 预注入；不要把 shell 网络失败解释为行情源不可用 |

## 需要先确认的问题

1. 火山云生产目标是否仍是 `claude@118.145.115.197:~/invest-agent`，还是需要换新目录/新用户？
2. 第一阶段是否接受 SSH tunnel 管理 Platform？如果接受，建议先不做公网反代。
3. 服务器 Codex 使用 ChatGPT 登录还是 API key？如果是 ChatGPT 登录，需要人工在服务器终端完成一次 `codex` 登录。
4. 是否迁移现有 111/112 等生产数据，还是先用测试用户空跑？
5. 当前云端 portal relay 是否仍使用火山云 `ws://127.0.0.1:22650/`？如需临时接阿里云 relay，必须显式说明。

## 执行者提示词

按本 skill 的 `references/volcano-runtime-migration-plan.md` 执行 Phase 0 到 Phase 1。先实现 `HOST`/`BIND_HOST` 配置和部署脚本/env 文档调整，不要直接迁移生产数据或操作微信切主。完成后报告本地 build、服务器健康检查、Codex CLI/ACP 验证和访问控制验证结果。遇到 Codex 登录、服务器权限或生产数据迁移问题时停下来确认。

## 验收者提示词

按本文档验收迁移准备结果。重点检查：服务是否可绑定 `127.0.0.1`；Platform 是否没有裸露公网；服务器 Codex CLI 和 `codex-acp` 是否在 PM2 用户下可用；`.env` 是否没有本机绝对路径；本机开发环境和服务器生产环境是否分离；是否没有两个 active connector 同时服务同一助手。
