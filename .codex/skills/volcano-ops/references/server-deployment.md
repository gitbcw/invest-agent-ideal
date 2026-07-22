# 服务器部署说明

本文档用于把当前单客户 Experimental MVP 部署到服务器，并通过浏览器访问统一看板完成微信连接与巡检/复盘运维。

## 0. 当前生产拓扑（硬约束）

当前保留两套闭环，不能把 portal、relay、connector 互相串错：

```text
本机开发/测试闭环
  浏览器 -> 阿里云 portal :8088
  本机 invest-agent connector -> 阿里云 relay :18088
  本机 invest-agent runtime -> http://127.0.0.1:22655

火山云生产闭环
  浏览器 -> 火山云 portal :22649
  火山云 invest-agent connector -> 火山云本机 relay :22650
  火山云 invest-agent runtime -> http://127.0.0.1:22655
```

关键端口和目录：

- 阿里云 portal：`admin@47.107.151.70:/home/admin/invest-agent-portal`，网页 `http://47.107.151.70:8088`，relay `ws://47.107.151.70:18088/`。
- 火山云 portal：`claude@118.145.115.197:/home/claude/invest-agent-portal`，网页 `http://118.145.115.197:22649`，relay `ws://127.0.0.1:22650/`。
- 火山云 runtime：`claude@118.145.115.197:/home/claude/invest-agent`，内部监听 `127.0.0.1:22655`。
- 本机 runtime：`http://127.0.0.1:22655`。

`22655` 是 invest-agent 平台服务内部端口，负责 Dashboard、WeChat、本地 API、scheduler、SQLite、workspace ACP 和 portal connector。本机和火山云都可以使用这个内部端口，但生产 Platform 不裸露公网。火山云 Platform 通过 SSH tunnel 访问：

```bash
ssh -L 22648:127.0.0.1:22655 claude@118.145.115.197
```

然后打开 `http://127.0.0.1:22648/platform`。

本机服务不需要为了生产迁移而停止；它可以继续作为开发/测试 runtime。生产助手 `111` / `dyk` 当前由火山云 runtime 接管，本机必须通过 `PORTAL_CONNECTOR_EXCLUDE_ASSISTANTS=invest-agent-111,invest-agent-dyk` 避免抢占。

## 0.1 部署一致性契约

部署脚本和文档必须维持这些一致性，不靠人工临场记忆：

- 代码同步脚本只同步代码，不覆盖服务器 `.env`、`data/`、`reviews/`、`.state/`、workspace 和 `.codex` 运行态。
- 运行时数据迁移只通过 `scripts/package-volcano-runtime.sh` 和 `scripts/apply-volcano-runtime.sh`；迁移后脚本会把 workspace 内 `.codex/config.toml`、`mcp.json` 统一指向服务器 `/home/claude/.codex`。
- **普通版本发布只能使用代码同步路径**（`scripts/deploy-volcano.sh`），且必须从已审核的生产分支、标签或干净发布目录执行。提示词、Skill、Workspace 模板、服务代码和编译产物的更新都不应触碰生产数据库、Workspace、复盘、`.env` 或微信状态。
- **禁止把运行时迁移当作普通部署**。只有用户明确要求迁移、恢复或替换数据库/Workspace 时，才允许使用 `package-volcano-runtime.sh` / `apply-volcano-runtime.sh`；该路径会替换生产资产，必须先停止写入、备份、校验 SHA，并记录回滚位置。
- 如果需求同时能用代码发布或运行时迁移完成，默认选择代码发布，不得推断用户授权替换生产数据。
- 火山云 portal env 默认指向火山云 portal/relay：`PORTAL_PUBLIC_URL=http://118.145.115.197:22649`、`PORTAL_RELAY_URL=ws://127.0.0.1:22650/`。连接阿里云 relay 必须显式覆盖变量。
- Codex ACP shell 沙箱可能无网络，不能假设 workspace 内 `curl 127.0.0.1:22655` 一定可用。长期正解是给 Codex ACP 会话挂载 `invest-agent-service-tools` stdio MCP，只暴露具名服务层工具，让 Codex 自己决定何时读取或在用户确认后写入持仓、自选、预案、复盘、方法候选和规则巡检配置。
- 不再把 `marketSnapshot` 等行情事实预注入 prompt。行情、持仓、预案和规则事实必须由 Codex 通过 MCP 工具按需读取；HTTP sandbox API 只作为 MCP 不可用时的兜底。
- 发布后必须跑 `npm run smoke:mcp-service-tools`，并至少跑一次 `userId=111` 的 `/api/chat` 持仓查询 smoke，确认输出包含服务层行情事实，而不是“本地行情服务不可用”。

## 1. 部署目标

部署完成后，服务器上应提供：

- `http://127.0.0.1:22655/health`
- `http://127.0.0.1:22655/dashboard`
- `http://127.0.0.1:22655/api/weixin/status`

当前 runtime 内部端口统一为 `22655`。`22648` 只作为管理员 SSH tunnel 本地端口使用，不是服务进程监听端口。

用户通过浏览器打开 `/dashboard`，在“微信连接”区域点击“连接微信”，扫码绑定微信，然后由服务端自动启动消息监听。

## 2. 当前部署形态

当前服务是一个单进程 Node.js 服务，包含：

- 投资 Agent 核心逻辑
- HTTP 管理接口
- 微信连接后台 UI
- 微信轻量桥接管理器
- SQLite 本地数据库
- 用户门户本地 connector 和 canonical conversation log API

不依赖 OpenClaw 服务本体。

## 3. 服务器要求

- Linux 服务器
- Node.js 22+
- npm
- PM2（推荐）
- 可写磁盘目录
- 可开放 22655 端口，或通过 Nginx/Caddy 反向代理

## 4. 必备文件

部署时至少需要：

- 项目代码
- `.env`
- `package.json`
- `package-lock.json`

运行时会生成：

- `dist/`
- `data/*.db`
- `logs/*`
- 微信状态目录（当前 PM2 配置为项目内 `./.state/openclaw-weixin`）

## 5. 部署步骤

### 5.1 上传项目

推荐使用部署脚本自动同步到服务器项目目录：

```bash
./scripts/deploy-volcano.sh
```

默认同步到：

```text
/home/claude/invest-agent
```

也可以手动使用 `rsync`，但要保留 `.env` 和数据目录。

### 5.2 安装依赖

```bash
cd /srv/invest-agent
npm install
```

### 5.3 检查环境变量

至少确认：

```env
PORT=22655
NODE_ENV=production
DB_PATH=./data/invest-agent.db
DEEPSEEK_API_KEY=...
DEEPSEEK_FLASH_MODEL=deepseek-v4-flash
DEEPSEEK_PRO_MODEL=deepseek-v4-pro
ACP_AGENT_ID=invest-agent
ACP_AGENT_NAME=投资选股助手
ACP_BACKEND=codex
CODEX_COMPLEX_MODEL=gpt-5.6-terra
ACP_SIMPLE_MODEL_ENABLED=false
INVEST_AGENT_SANDBOX_SECRET=<stable-random-secret>
```

可选：

```env
WEIXIN_AUTO_START=true
INVEST_AGENT_WEIXIN_STATE_DIR=./.state
PORTAL_RELAY_URL=ws://<portal-host>:3199
PORTAL_CONNECTOR_TOKEN=...
PORTAL_USER_ID=primary
PORTAL_INSTANCE_ID=invest-agent-primary
PORTAL_CONNECTOR_ID_PREFIX=volcano-prod
PORTAL_CONNECTOR_RUNTIME_LABEL=火山云生产
```

默认就是自动启动已绑定账号的微信监听。
如仍保留旧配置 `DEEPSEEK_MODEL=deepseek-chat`，程序会自动按兼容逻辑切换到新的 V4 模型，但建议显式配置 Flash 与 Pro 两档模型。

当前 ACP 默认走 `complex` model tier。`simple` tier 仍保留为未来稳定性调试后的 opt-in 能力；生产默认保持 `ACP_SIMPLE_MODEL_ENABLED=false`。`INVEST_AGENT_SANDBOX_SECRET` 是 sandbox token HMAC secret，生产环境必须显式配置稳定值；本地开发未配置时会生成/复用 `data/.sandbox-secret`，但不要依赖这个文件做服务器长期密钥。

### 5.4 构建

```bash
npm run build
```

### 5.5 启动

建议使用 PM2：

```bash
pm2 start ecosystem.config.js
pm2 save
```

也可以临时直接启动：

```bash
npm start
```

## 6. 启动后检查

### 6.1 健康检查

```bash
curl http://127.0.0.1:22655/health
```

### 6.2 管理后台

浏览器访问：

```text
http://<server>:22655/dashboard
```

### 6.3 微信状态

```bash
curl http://127.0.0.1:22655/api/weixin/status
```

### 6.4 用户门户本地接口

```bash
curl http://127.0.0.1:22655/api/portal/health
npm run smoke:portal-conversation-log
```

如需连接云端 Relay:

```bash
PORTAL_RELAY_URL=ws://47.107.151.70:18088/ PORTAL_CONNECTOR_TOKEN=<token> npm run portal:connector
```

### 6.5 Connector 环境分层

本地开发联调推荐连接本机 portal relay：

```env
PORTAL_PUBLIC_URL=http://localhost:3100
PORTAL_RELAY_URL=ws://localhost:3199
PORTAL_CONNECTOR_TOKEN=dev-connector-token
PORTAL_CONNECTOR_ID_PREFIX=local-dev
PORTAL_CONNECTOR_RUNTIME_LABEL=本机开发
```

火山云生产 runtime 连接火山云生产 relay：

```env
PORTAL_PUBLIC_URL=http://118.145.115.197:22649
PORTAL_DISTRIBUTION_URL=http://127.0.0.1:22649/api/internal/distribution/provision
PORTAL_RELAY_URL=ws://127.0.0.1:22650/
PORTAL_CONNECTOR_TOKEN=<same as volcano portal PORTAL_CONNECTOR_TOKEN>
PORTAL_DISTRIBUTION_TOKEN=<same as volcano portal PORTAL_DISTRIBUTION_TOKEN>
PORTAL_CONNECTOR_ID_PREFIX=volcano-prod
PORTAL_CONNECTOR_RUNTIME_LABEL=火山云生产
PORTAL_CONNECTOR_AUTO_START=true
# 留空，以便 connector manager 自动为所有 active 实例注册连接器。
PORTAL_CONNECTOR_INCLUDE_ASSISTANTS=
# 排除历史默认测试实例；新增正式用户不需要修改此项。
PORTAL_CONNECTOR_EXCLUDE_ASSISTANTS=invest-agent-primary
```

约束：

- 同一个 `assistantId` 同一时间只允许一个 active connector。生产 active 实例应只由火山云生产 connector 注册。
- 本机开发若连接阿里云 relay，应显式排除所有火山云已接管的正式助手，或使用测试助手，避免抢占连接器。
- connector token 与 distribution token 不要写入仓库，只放服务器 `.env` / `.env.production`。

## 7. 首次绑定微信

1. 打开 `/dashboard`
2. 点击“连接微信”
3. 页面显示二维码
4. 用客户微信扫码并确认
5. 页面状态进入 `connected`
6. 让客户微信向助手发送任意一条消息，形成真实入站会话
7. 若未自动监听，点击“启动监听”

绑定成功后，微信状态会保存在服务器本地，后续服务重启后会自动恢复监听。当前调度器会继续按 workspace `config/schedules.yaml` 和 `config/watch.yaml` 扫描自动巡检与复盘。

扫码只表示 bot/account 登录成功；主动推送必须等真实入站消息写入 `channel_identities.last_conversation_id` 后才算就绪。不要用扫码响应里的 `ilink_user_id` 判断可推送：实测出现过发送接口返回 200 但微信端未实际收到的情况。

## 8. 数据与状态目录

### SQLite 数据库

默认：

```text
./data/invest-agent.db
```

### Sandbox token secret

生产环境使用：

```env
INVEST_AGENT_SANDBOX_SECRET=<stable-random-secret>
```

本地开发若未设置该变量，服务会使用 `./data/.sandbox-secret` 作为持久 secret，避免本地服务进程和评测进程签名不一致。该文件位于已忽略的 `data/` 目录内，不应提交。

### 微信登录状态

默认：

```text
./.state/openclaw-weixin/
```

服务默认将微信状态放到项目目录，避免和全局 Claude Code 微信桥接共用 `~/.openclaw`。如需自定义目录，可以在 PM2 或 shell 里设置：

```env
INVEST_AGENT_WEIXIN_STATE_DIR=./.state
```

`OPENCLAW_STATE_DIR` 和 `CLAWDBOT_STATE_DIR` 仍作为兼容旧配置的后备变量，但本项目推荐使用 `INVEST_AGENT_WEIXIN_STATE_DIR`。

## 9. 端口与反向代理

如果服务器不直接暴露 22655，可用 Nginx 或 Caddy 反代，例如：

```text
https://agent.example.com/dashboard
```

建议生产环境最终走 HTTPS。

## 10. 运维命令

### 查看日志

```bash
pm2 logs invest-agent
```

### 重启

```bash
pm2 restart invest-agent
```

### 停止

```bash
pm2 stop invest-agent
```

### 查看微信状态

```bash
curl http://127.0.0.1:22655/api/weixin/status
```

## 11. 当前运行说明

- 当前默认使用 Codex ACP 作为 workspace 推理后端；Hermes 仅保留为兼容/实验 backend。
- 盘中巡检与日/周/月复盘都由服务侧 scheduler 触发，再进入当前用户的 workspace。
- 自动复盘去重已按用户助手 scope 生效；内部仍使用 `userId + instanceId + period` 作为兼容隔离键。若用户已手动生成同周期报告，自动任务默认不重复生成。
- 用户门户不是本地 `/platform` 的公网化。本地 SQLite 的 `conversation_sessions` / `conversation_messages` 是 web/微信用户可见历史的权威源；云端门户只做镜像与 Relay。

## 12. 当前已知限制

- 单客户版本，只支持一个微信账号绑定。
- 微信状态保存在本机目录，不是数据库多租户方案。
- 暂未接入完整信息源和主力控盘直接数据。
- 多模态仍是后续阶段。

## 13. 部署前建议

上线前先在本地确认：

```bash
npm run smoke
```

并确认本地 `/dashboard` 能显示二维码、能绑定微信、能收到消息。

### 13.1 复合指标系统 5 套 smoke(2026-06-22 落地)

复合指标系统拆 5 个独立 smoke,任意一项回归失败都说明 L1-L3b / 告知协议链路被破坏。完整 RFC 见 `docs/composite-indicator-system.md`。

```bash
npm run smoke:indicators                # L1 算子(MA/EMA/MACD/KDJ/BOLL/RSI/WR/OBV + 筹码)
npm run smoke:script-indicator          # L3b 沙箱引擎(isolated-vm + esbuild + 熔断)
npm run smoke:composite-indicator       # L3a 规则树引擎(YAML + 表达式 + 4 模式 combine)
npm run smoke:indicator-acknowledgement # 告知协议门禁(experimental/data_source_notes/via 白名单)
npm run smoke:main-force-control        # 主力控盘 L3b 脚本端到端(客户公式)
```

### 13.2 复合指标缓存清理

L3b 沙箱脚本编译产物落 `workspace/cache/build/<base>.<hash>.js`,30 天未访问自动超期。默认 dry-run,加 `--apply` 实际删除:

```bash
npm run cache:clear-indicator                  # 默认 dry-run,30 天阈值
npm run cache:clear-indicator -- --apply       # 实际删除
npm run cache:clear-indicator -- --days 7 --apply
```
