# 服务器部署说明

本文档用于把当前单客户 Experimental MVP 部署到服务器，并通过浏览器访问统一看板完成微信连接与巡检/复盘运维。

## 1. 部署目标

部署完成后，服务器上应提供：

- `http://<server>:22655/health`
- `http://<server>:22655/dashboard`
- `http://<server>:22655/api/weixin/status`

当前默认端口统一为 `22655`。`22648` / `22652` 不再作为本项目默认端口使用。

用户通过浏览器打开 `/dashboard`，在“微信连接”区域点击“连接微信”，扫码绑定微信，然后由服务端自动启动消息监听。

## 2. 当前部署形态

当前服务是一个单进程 Node.js 服务，包含：

- 投资 Agent 核心逻辑
- HTTP 管理接口
- 微信连接后台 UI
- 微信轻量桥接管理器
- SQLite 本地数据库

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
```

可选：

```env
WEIXIN_AUTO_START=true
INVEST_AGENT_WEIXIN_STATE_DIR=./.state
```

默认就是自动启动已绑定账号的微信监听。
如仍保留旧配置 `DEEPSEEK_MODEL=deepseek-chat`，程序会自动按兼容逻辑切换到新的 V4 模型，但建议显式配置 Flash 与 Pro 两档模型。

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

## 7. 首次绑定微信

1. 打开 `/dashboard`
2. 点击“连接微信”
3. 页面显示二维码
4. 用客户微信扫码并确认
5. 页面状态进入 `connected`
6. 若未自动监听，点击“启动监听”

绑定成功后，微信状态会保存在服务器本地，后续服务重启后会自动恢复监听。当前调度器会继续按 workspace `config/schedules.yaml` 和 `config/watch.yaml` 扫描自动巡检与复盘。

## 8. 数据与状态目录

### SQLite 数据库

默认：

```text
./data/invest-agent.db
```

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

- 当前统一使用 Hermes stdio ACP 作为工作空间推理后端。
- 盘中巡检与日/周/月复盘都由服务侧 scheduler 触发，再进入当前用户的 workspace。
- 自动复盘去重已按 `userId + instanceId + period` 生效；同一实例下若用户已手动生成同周期报告，自动任务默认不重复生成。

## 12. 当前已知限制

- 单客户版本，只支持一个微信账号绑定。
- 微信状态保存在本机目录，不是数据库多租户方案。
- 暂未接入完整信息源和主力控盘直接数据。
- 多模态仍是后续阶段。

## 12. 部署前建议

上线前先在本地确认：

```bash
npm run smoke
```

并确认本地 `/dashboard` 能显示二维码、能绑定微信、能收到消息。

### 12.1 复合指标系统 5 套 smoke(2026-06-22 落地)

复合指标系统拆 5 个独立 smoke,任意一项回归失败都说明 L1-L3b / 告知协议链路被破坏。完整 RFC 见 `docs/composite-indicator-system.md`。

```bash
npm run smoke:indicators                # L1 算子(MA/EMA/MACD/KDJ/BOLL/RSI/WR/OBV + 筹码)
npm run smoke:script-indicator          # L3b 沙箱引擎(isolated-vm + esbuild + 熔断)
npm run smoke:composite-indicator       # L3a 规则树引擎(YAML + 表达式 + 4 模式 combine)
npm run smoke:indicator-acknowledgement # 告知协议门禁(experimental/data_source_notes/via 白名单)
npm run smoke:main-force-control        # 主力控盘 L3b 脚本端到端(客户公式)
```

### 12.2 复合指标缓存清理

L3b 沙箱脚本编译产物落 `workspace/cache/build/<base>.<hash>.js`,30 天未访问自动超期。默认 dry-run,加 `--apply` 实际删除:

```bash
npm run cache:clear-indicator                  # 默认 dry-run,30 天阈值
npm run cache:clear-indicator -- --apply       # 实际删除
npm run cache:clear-indicator -- --days 7 --apply
```
