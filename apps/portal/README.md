# invest-agent-portal

用户门户。云端 Web 入口通过 Relay 与本地 `invest-agent-ideal` connector 协作。

当前协议见 [user-portal-protocol.md](./user-portal-protocol.md)，交互验收见 [MANUAL_TESTING.md](./MANUAL_TESTING.md)。初始设计与第一阶段验收契约已经归档到 `docs/archive/initial-spec/`。

## 仓库定位

- 本仓库 = 云端门户(Next.js)+ Relay + Mock Connector + 协议。
- 不依赖 invest-agent-ideal 内部源码,只通过协议与运行时连接协作。
- Mock connector 用于本地 UI/协议验收，真实 connector 由 `invest-agent-ideal` 实现并作为生产链路。
- 工作空间目录是只读入口，只展示 Markdown、HTML 和图片；网页端不编辑、移动、重命名或删除文件。
- 图片和 SVG 直接进入大图预览，Markdown/HTML 在可调宽右侧栏中以去重标签打开。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 拷贝环境配置
cp .env.example .env
# 生成更安全的 JWT secret:openssl rand -hex 32

# 3. 初始化默认账号
npm run seed

# 4. 启动 Portal 合并进程
npm run dev            # Next.js 门户(:3100) + WebSocket Relay(:3199)

# 5. 另开一个终端启动 Mock Connector(默认场景 online)
npm run dev:mock
```

打开 http://127.0.0.1:3100 即可登录,默认测试账号:

- `primary` / `User@2026`（测试账号，绑定默认测试投资助手）
- `admin` / `Admin@2026`

## Mock 场景

通过 `PORTAL_MOCK_SCENARIO` 切换:

```bash
npm run mock:online   # 在线 + 正常回复
npm run mock:slow     # 在线 + 慢回复(12s)
npm run mock:failed   # 在线 + chat 返回 ACP_FAILED
npm run mock:empty    # 在线 + 空历史
npm run mock:paged    # 在线 + 25 条会话(分页)
npm run mock:offline  # 不连接,模拟 connector 不可用
```

切换场景时,先停掉旧的 mock,再用对应 npm script 启动。

## 项目结构

```
src/
  app/                    # Next.js App Router
    api/
      auth/               # login / logout / password / me
      admin/              # reset-password (管理员)
      conversations/      # 列表 / 详情 / 消息
      assistant/          # status
      workspace/          # 当前用户 workspace 的只读 list/get
    chat/page.tsx         # 聊天主页
    login/page.tsx
    change-password/page.tsx
  components/
    auth/
    chat/                 # ChatShell / Sidebar / MessageBubble ...
  lib/
    config.ts             # env + .env 加载
    http.ts               # API 响应工具
    auth/                 # 密码哈希、JWT session
    db/                   # schema、users、conversations(SQLite 镜像)
    mock/                 # mock connector + fixtures
    protocol/             # 协议(envelope / types)
    relay/                # WebSocket Relay server + connector registry
scripts/
  seed.ts                 # 默认账号初始化
  start-relay.ts          # 仅用于低层协议调试；正常部署不要单独启动
  start-mock-connector.ts # 启动 mock connector
```

## 部署进程模型

Portal 的 HTTP API 需要读取 Relay 的 connector registry,所以生产环境必须使用本仓库的自定义 `server.ts` 合并进程:

```bash
npm ci
npm run build
NODE_ENV=production npm run start
```

`npm run start` 会同时监听:

- `PORTAL_PORT`：Next.js 门户和 HTTP API,默认 `3100`
- `PORTAL_RELAY_PORT`：WebSocket Relay,默认 `3199`

不要在生产环境把 `npm run start` 和 `npm run dev:relay` / `scripts/start-relay.ts` 拆成两个进程。拆开后 HTTP API 和 Relay 不共享 connector registry,页面会把已连接的助手误判为离线。

推荐用 PM2 管理:

```bash
pm2 start npm --name invest-agent-portal -- run start
pm2 save
```

生产环境必须显式设置并妥善保存:

```bash
NODE_ENV=production
PORTAL_JWT_SECRET=<openssl rand -hex 32>
PORTAL_CONNECTOR_TOKEN=<openssl rand -hex 32>
PORTAL_DISTRIBUTION_TOKEN=<different openssl rand -hex 32>
PORTAL_DB_PATH=/var/lib/invest-agent-portal/portal.db
```

`PORTAL_DISTRIBUTION_TOKEN` 必须不同于 `PORTAL_CONNECTOR_TOKEN`。火山云生产使用固定公网 IP + HTTP，并通过同机 `ws://` Relay 连接；没有备案域名，HTTPS 不能作为功能前提。其他具备域名和证书的部署可以选择 HTTPS/WSS 反向代理。

完整生产部署、反向代理、备份恢复和回滚步骤见 [docs/production-runbook.md](./docs/production-runbook.md)。

## 环境与部署 Profile

本地开发:

```bash
cp .env.development.example .env
npm install
npm run seed
npm run dev
```

历史阿里云部署:

```bash
# 只在服务器上创建,不要提交
cp .env.production.example .env.production

# 本机执行部署
npm run deploy:aliyun
```

生产入口保持:

- Web: `http://47.107.151.70:8088`
- Relay: `ws://47.107.151.70:18088/`

`invest-agent` 的生产 connector 可以跑在火山云，只要它使用同一套 `PORTAL_CONNECTOR_TOKEN` 连接上述 Relay。Portal 不直接连接火山云 `22655`，双方仍通过 WebSocket Relay 互联。

火山云生产:

```bash
npm run deploy:volcano
```

当前火山云入口约定:

- 用户门户公网地址: `http://118.145.115.197:22649/login`
- Relay: `ws://127.0.0.1:22650/`，供同机火山云 `invest-agent` connector 使用
- Platform 不是门户的一部分；管理员从本机用 `ssh -L 22648:127.0.0.1:22655 claude@118.145.115.197` 访问 `http://127.0.0.1:22648/platform`
- 本机 `22649` 不用于 Platform tunnel，避免和火山云公网门户端口混淆

## 验收路径(Mock)

按 [MANUAL_TESTING.md](./MANUAL_TESTING.md) 执行当前聊天、workspace、图片和右侧栏验收。基础聊天检查包括:

1. 未登录访问 `/chat` → 自动跳转 `/login`。
2. `primary / User@2026` 测试账号登录成功,进入聊天页。
3. 错误密码登录失败,提示"账号或密码错误"。
4. 左侧出现 mock 历史会话(`web_001/002/003`)。
5. 新建对话 → 输入消息 → 看到用户气泡 + 助手等待状态。
6. 助手回复以打字机式呈现。
7. 刷新页面,会话与消息仍可读(已写入云端镜像)。
8. 切换 mock 到 `failed` → 发送消息,显示失败气泡 + 重试入口。
9. 切换 mock 到 `slow` → 等待提示按 0-2s / 2-10s / 10s+ 阶段切换。
10. 切换 mock 到 `offline` → 离线横幅出现,发送按钮禁用。
11. 头像菜单 → 修改密码 → 用新密码重新登录。
12. 用 `admin` 登录 → 调用 `POST /api/admin/reset-password`(或将来提供的管理页面) → 拿到临时密码 → `primary` 测试账号必须改密后才能进入聊天。

## 切换到真实 local connector

真实生产链路要求协议与运行时 connector 同时在线。

invest-agent-ideal 实现的 connector 需要:

1. WebSocket 连接到 `ws://<portal-host>:<relay-port>/?token=<PORTAL_CONNECTOR_TOKEN>`。
2. 发送 `connector.register`(mode=`real`),capabilities 至少包含 `conversation.chat / conversation.list / conversation.get`；workspace 浏览还需要 `workspace.file.list / workspace.file.get`。
3. 维护心跳,处理 Relay 转发的 `conversation.list / conversation.get / conversation.chat` 命令。
4. 写入本地 canonical conversation log(`conversation_sessions / conversation_messages`),并通过 `conversation.sync` 事件把会话/消息推给 Relay。
5. `assistantId` 默认使用 `invest-agent-primary`(与门户默认测试账号绑定一致)。

参考协议:[user-portal-protocol.md](./user-portal-protocol.md)。

## 端到端验收(真实 connector)

1. 启动 portal 合并进程:`npm run dev`。
2. 启动 invest-agent-ideal 本地 connector(参考其 runbook)。
3. 登录网页,看到助手在线。
4. 发送消息,确认本地 canonical log 与云端镜像同时落库。
5. 刷新页面,历史仍可读。
