# 用户门户与本地运行时设计

## 背景

当前 `invest-agent-ideal` 服务跑在本地，承担了投资助手的完整运行时职责：SQLite、workspace、Codex ACP、微信连接、scheduler、行情、推送、Dashboard/Platform API 和审计。

下一阶段需要一个额外的网页入口，让用户可以登录、查看自己的对话历史，并在网页端和自己的 workspace 投资助手对话。这个入口需要部署到服务器上，但它不应该替代本地 invest-agent 服务，也不应该把 `/platform` 管理能力直接开放给普通用户。

因此，本工作不定义为 Dashboard 重构，而定义为新增一个“云端用户门户 + Relay”，与本地 invest-agent 运行时配合。

## 设计目标

- 给普通用户提供一个服务器上的网页入口：登录、查看对话历史、发起网页对话。
- 保持本地 invest-agent 服务作为真实运行时：workspace、ACP、调度器、微信、数据源和确定性 API 仍在本地。
- 本地服务主动连接云端，避免把本机服务直接暴露到公网。
- 让微信端和网页端共享同一个用户助手和 workspace，但保留不同 channel 标识。
- 为后续多用户、远程运维和云端部署迁移留下清晰边界。

## 非目标

- 不把现有 `/platform` 改造成公网用户产品。
- 不在云端重新实现投资助手运行时。
- 不让云端服务直接读写本地 workspace 文件系统。
- 不在第一阶段实现完整投资工作台、复杂报表、策略编辑器或所有 Dashboard CRUD。
- 不改变当前微信直达 workspace ACP 的主链路。

## 核心判断

云端用户门户是“入口”和“中转”，本地 invest-agent 是“运行时”和“状态源”。

当前产品语义按“一用户一助手”收敛：一个用户默认只有一个用户助手，这个助手对应一个 workspace。代码和数据库里仍可能保留 `instanceId` 作为历史兼容和内部技术键，但产品设计、用户门户和用户可见文案都不应暗示“一个用户下面可选择多个实例”。

```text
用户浏览器
  -> 云端用户门户: 登录 / 页面 / 会话入口
  -> 云端 Relay: 鉴权 / 路由 / 请求转发 / 轻量缓存
  <-> 本地 invest-agent Connector: 长连接 / 命令执行 / 流式返回
  -> 本地 workspace-scoped ACP backend
  -> 用户 workspace
```

这个方向的关键点是：服务器不主动访问用户本机，改为本地服务启动后主动连接服务器。

## 角色与边界

### 本地 invest-agent 服务

保留职责：

- workspace 创建、读取和写入。
- Codex ACP session 管理。
- SQLite 本地数据库。
- 微信监听、主动推送和登录状态。
- scheduler、复盘、盯盘、规则巡检。
- 行情、资金流、数据源质量。
- Platform 运维页。
- 用户态命令执行和审计。

新增职责：

- 启动一个 `portal connector`，主动连接云端 Relay。
- 接收云端转发的用户态命令。
- 将网页端用户消息写入统一对话日志。
- 调用当前用户 workspace ACP，返回结果或流式片段。

### 云端用户门户

职责：

- 用户登录和会话管理。
- 登录后直接进入该用户自己的投资助手。
- 展示对话历史列表和消息详情。
- 提供网页聊天入口。
- 将用户请求转发给对应本地 connector。
- 保存必要的门户状态和轻量缓存。

不负责：

- 不直接运行 Codex ACP。
- 不直接读取 workspace 文件。
- 不直接管理微信登录态。
- 不提供 `/platform` 级别的运维能力。

### Platform 与用户门户的关系

- `/platform` 是管理员和开发者使用的本地运维面。
- 用户门户是普通用户使用的远程产品入口。
- 两者可以复用部分只读展示能力，但权限模型和信息架构必须分开。

## 推荐部署形态

```text
本地机器
  invest-agent service :22655
    - dashboard / platform
    - workspace runtime
    - portal connector
    - SQLite

服务器
  user portal web app
    - login
    - conversation UI
    - user dashboard shell

  portal relay service
    - WebSocket endpoint for local connectors
    - HTTP/SSE endpoint for browser
    - auth and routing
    - lightweight conversation index/cache
```

## 连接模型

### 本地服务注册

本地 invest-agent 启动后，用配置中的 `PORTAL_RELAY_URL` 和 `PORTAL_CONNECTOR_TOKEN` 主动连接云端：

```text
local connector -> cloud relay WebSocket
```

注册信息：

- `connectorId`
- `projectId`
- `assistantIds`
- `capabilities`
- `version`
- `startedAt`
- `heartbeat`

云端只把请求路由给已在线、已授权的 connector。

### 请求转发

云端向本地发送结构化命令，而不是裸 HTTP 代理：

```json
{
  "requestId": "req_...",
  "userId": "primary",
  "assistantId": "invest-agent-primary",
  "instanceId": "invest-agent-primary",
  "channel": "web",
  "type": "chat",
  "payload": {
    "conversationId": "web_...",
    "text": "今天帮我看一下持仓风险"
  }
}
```

本地返回：

```json
{
  "requestId": "req_...",
  "ok": true,
  "data": {
    "messageId": "msg_...",
    "text": "..."
  }
}
```

流式回复可以用多条 event：

```json
{ "requestId": "req_...", "event": "chunk", "text": "..." }
{ "requestId": "req_...", "event": "done", "messageId": "msg_..." }
```

## 第一阶段功能范围

### 用户登录

最小版本只需要支持受控用户登录，不需要复杂组织权限。

建议能力：

- 用户名/密码或邮箱验证码登录。
- 云端用户和本地用户助手的绑定表。
- 当前阶段一个云端用户只绑定一个用户助手。
- 用户登录后直接进入自己的助手，不展示实例选择器。

### 对话历史

需要新增统一的对话历史模型。当前 `chat_history` 偏历史兼容，`codex_acp_traces` 偏审计，不适合作为用户可见对话源。

建议本地新增 canonical conversation log：

- `conversation_sessions`
- `conversation_messages`

核心字段：

```text
conversation_sessions
  id
  user_id
  instance_id
  channel          -- weixin / web
  title
  status
  created_at
  updated_at

conversation_messages
  id
  session_id
  user_id
  instance_id
  channel
  role             -- user / assistant / system
  content
  status
  trace_id
  metadata_json
  created_at
```

微信端和网页端都写入这套日志，但可以保留不同 `channel` 和 `conversationId`。

云端第一阶段可以只缓存：

- 会话索引。
- 最近 N 条消息。
- connector 在线状态。

完整历史仍以本地为准。

### 网页端对话

MVP 流程：

```text
browser -> cloud /api/conversations/:id/messages
cloud -> local connector chat command
local -> workspace-scoped ACP
local -> append local conversation log
local -> cloud relay response
cloud -> browser response
```

第一阶段可以先做非流式完整回复；如果体验需要，再升级 SSE/WebSocket 流式输出。

### 用户态只读概览

门户首页可以先做很轻的只读状态：

- 最近对话。
- 最近复盘。
- 最近提醒。
- connector 在线状态。

不建议第一阶段搬运完整 Dashboard。

## 权限与安全原则

1. 用户身份由云端登录态决定。
2. 用户助手访问由云端绑定表决定，用户不能通过 URL 参数访问其他用户助手。
3. 云端发给本地的命令必须包含云端签名或 connector 会话上下文。
4. 本地仍需校验该 `userId` 对应的用户助手是否存在且允许通过 portal 调用；`instanceId` 只作为内部兼容键使用。
5. 本地 connector 只暴露用户态命令，不暴露 Platform 管理命令。
6. 删除、重置、微信连接管理、全局配置修改不进入用户门户第一阶段范围。
7. 对话内容属于用户敏感数据；云端缓存策略需要可配置，默认少存。

## 命令类型建议

第一阶段只开放以下命令：

```text
portal.ping
portal.get_assistant
conversation.list
conversation.get
conversation.chat
dashboard.snapshot
review.list_recent
```

明确不开放：

```text
platform.reset_instance
platform.delete_instance
weixin.connect
weixin.stop
settings.global_update
scheduler.trigger
debug.trace_raw
```

## 与现有系统的关系

### 与微信链路

微信链路保持不变：

```text
微信 -> 本地 weixin bridge -> workspace ACP -> 微信回复
```

新增网页链路：

```text
网页 -> 云端 portal -> 本地 connector -> workspace ACP -> 网页回复
```

两条链路最终进入同一个 workspace-scoped ACP backend，但 channel 不同。

### 与 Dashboard

现有 `/dashboard` 仍是本地统一看板，适合管理员或本机使用。

云端用户门户不直接照搬 `/dashboard`，而是从对话历史和轻量概览开始。后续再逐步把适合用户自助查看的能力迁过去。

### 与 Platform

`/platform` 保持本地运维定位。默认测试实例重置、用户助手删除、微信监听管理、日志审计等都不进入用户门户。

## 推荐实施阶段

### Phase 0: 设计确认

产出：

- 本文档确认。
- 明确云端技术栈和部署位置。
- 明确登录方式。
- 明确云端是否保存完整消息正文。

验收：

- 能回答“用户门户不是 Dashboard 重构，也不是 Platform 外网化”。
- 能画出云端与本地的通信边界。

### Phase 1: 本地对话日志

目标：

- 新增 canonical conversation log。
- 微信和网页入口未来都能写入同一种消息记录。

验收：

- 本地能按 `userId + instanceId + channel` 查询会话列表。
- 能查询单个会话消息。
- 不依赖 `codex_acp_traces` 作为用户可见历史。

### Phase 2: 云端 Relay 与本地 Connector

目标：

- 本地服务主动连接云端。
- 云端能看到 connector 在线。
- 云端能向本地发 `ping` 和只读查询。

验收：

- 本地不开放公网端口。
- 云端可显示该用户助手在线/离线。
- connector 断线后能重连。

### Phase 3: 网页端对话 MVP

目标：

- 用户登录后直接进入自己的用户助手。
- 能新建网页会话并发送消息。
- 本地 workspace ACP 返回回复。
- 对话记录落本地 canonical log。

验收：

- 普通用户不能访问其他用户助手。
- 网页消息以 `channel=web` 记录。
- 微信链路不受影响。

### Phase 4: 轻量用户首页

目标：

- 用户能看到最近对话、最近复盘、最近提醒和服务在线状态。

验收：

- 首页不暴露 Platform 运维数据。
- 页面能明确区分“可查看状态”和“可执行操作”。

## 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 云端变成第二套运行时 | 逻辑重复、状态分裂 | 云端只做 portal/relay，不直接读写 workspace |
| 用户门户误暴露 Platform 能力 | 可能删除或重置数据 | 命令白名单；第一阶段不开放管理命令 |
| 对话历史来源混乱 | 用户看到审计日志或缺失消息 | 新增 canonical conversation log |
| 本地服务离线 | 用户网页不可用 | 云端展示离线状态；不假装可执行 |
| 云端保存敏感正文过多 | 隐私风险 | 默认只缓存索引和最近消息；完整历史以本地为准 |
| 长连接不稳定 | 对话失败 | connector 心跳、重连、请求超时、幂等 requestId |

## 开放问题

1. 云端门户使用什么技术栈和部署方式？
2. 登录方式第一版选用户名密码、邮箱验证码，还是第三方登录？
3. 云端是否保存完整对话正文，还是只保存索引和最近 N 条？
4. 网页聊天第一版是否需要流式输出？
5. 是否需要支持多个本地 connector 同时在线，并按用户助手路由？

## 执行交接提示

Executor prompt:

```text
请基于 docs/user-portal-design.md 推进用户门户第一阶段。不要改造 /platform 为公网用户产品，不要把云端实现成第二套 invest-agent 运行时。优先实现本地 canonical conversation log 的数据模型和查询 API，然后再设计 portal connector 与云端 relay。所有变更必须保持微信直达 workspace ACP 主链路不变。
```

Reviewer prompt:

```text
请按 docs/user-portal-design.md 审查实现结果。重点检查：云端是否只承担 portal/relay 职责；本地 workspace/ACP/SQLite 是否仍是运行时源头；用户门户是否无法访问 Platform 管理命令；对话历史是否有 canonical log，而不是直接复用 codex_acp_traces；微信链路是否无回归。
```
