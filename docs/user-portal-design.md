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

## 仓库边界与开发顺序

推荐把云端门户做成独立项目，例如 `invest-agent-portal`。本项目继续作为本地 invest-agent 运行时。

```text
invest-agent-ideal
  - 本地 connector
  - canonical conversation log
  - portal protocol definition
  - mock connector / fixtures
  - workspace ACP runtime

invest-agent-portal
  - Next.js 用户门户
  - 账号密码登录 / 改密 / 管理员重置密码
  - 左侧会话历史 + 右侧 Chatbot UI
  - 云端 conversation mirror
  - Relay endpoint
```

开发顺序建议：

1. 先在本项目沉淀协议和测试夹具。
2. 新门户项目基于协议和 mock connector 独立开发 UI、登录、会话镜像和 Relay。
3. 本项目实现真实 local connector 和 canonical conversation log。
4. 用同一套协议测试把门户项目从 mock connector 切到真实 connector。
5. 最后做端到端验收：网页登录 -> 发消息 -> 云端 Relay -> 本地 connector -> workspace ACP -> 回复 -> 双层历史落库。

这意味着门户项目不需要等本地 connector 完全写好才能开工。它可以先用 mock connector 完成大部分产品验收；本项目随后补齐真实 connector，并用同一套测试用例完成联调。

本项目应提前准备：

- `docs/user-portal-design.md` 和 `docs/user-portal-goal-and-acceptance.md` 作为新项目输入。
- portal protocol 文档或 schema，定义 register / heartbeat / chat / history sync / error 格式。
- mock connector fixtures，允许门户项目模拟在线、离线、慢回复、失败回复、历史分页等状态。
- 本地 connector 测试模式，能连到本地或云端 Relay。
- 端到端验收脚本或 runbook，说明如何从 mock 切到真实 connector。

新门户项目不应直接依赖本项目内部源码。两边只通过协议、fixtures 和运行时连接协作。

## 推荐部署形态

```text
本地机器
  invest-agent service :22655
    - dashboard / platform
    - workspace runtime
    - portal connector
    - SQLite

服务器
  user portal web app(建议 Next.js)
    - login
    - conversation UI
    - user dashboard shell

  portal relay service(可与 Next.js 同仓库/同进程起步)
    - WebSocket endpoint for local connectors
    - HTTP/SSE endpoint for browser
    - auth and routing
    - conversation mirror/cache
```

第一版技术建议：

- 优先采用 Next.js 实现用户门户。原因是它适合做登录页、会话列表、Chatbot 页面、服务端 API route 和后续 SSR/边缘优化；生态成熟，后续也容易做成接近 ChatGPT 的交互形态。
- 部署到自有服务器，用 PM2 管理 Node 进程。前面可以挂 Nginx/Caddy 做 HTTPS、静态资源和反向代理。
- Relay 第一版可以和门户放在同一个 Next.js/Node 服务里，先减少部署复杂度；如果后续连接数、稳定性或安全隔离要求上来，再拆成独立 relay service。
- 不以“复刻 ChatGPT 技术栈”为目标。ChatGPT 的内部实现不是本项目的依赖；本项目只吸收成熟聊天产品的交互模式：左侧历史、右侧对话、账号菜单、等待态和可恢复状态。

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

多 connector 语义：

- 云端 Relay 可以同时接入多个本地 connector，例如本机、测试机、未来服务器运行时。
- 当前产品仍是一用户一助手；多 connector 不代表一用户多助手。
- 同一个用户助手同一时间只允许一个 active connector。若同一助手出现多个 connector，第一版建议标记冲突并拒绝新的会话请求，或采用“最新连接优先”策略但必须记录审计日志。
- 不允许同一条用户消息广播给多个 connector 执行，避免重复 ACP 调用、重复落库和重复推送。

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

### 产品形态

第一阶段用户门户是一个极简聊天门户，不是完整投资工作台。用户进入网页后只经历两个主界面：

1. 登录页。
2. 登录后的聊天页。

聊天页采用常见 Chatbot 布局：

```text
┌──────────────────────────────────────────────────────────────┐
│ 左侧会话栏                       │ 右侧聊天区                 │
│ - 新建对话                       │ - 当前对话消息流           │
│ - 对话历史列表                   │ - 等待/流式响应状态        │
│ - 可折叠                         │ - 底部输入框               │
│                                  │                            │
│ 左下角用户头像                   │                            │
│ - 修改密码                       │                            │
│ - 退出登录                       │                            │
└──────────────────────────────────────────────────────────────┘
```

左侧会话栏承担“历史和导航”，右侧聊天区承担“当前任务”。第一阶段不引入复杂首页、仪表盘卡片或多助手选择。

### 登录与账户

最小版本只支持我们预先提供给用户的账号和密码，不开放自助注册。

登录页要求：

- 输入账号。
- 输入密码。
- 登录失败时给出明确错误，但不暴露账号是否存在。
- 登录成功后直接进入该用户自己的投资助手。
- 已登录用户再次访问门户时自动进入聊天页。

用户菜单：

- 入口位于左下角用户头像。
- 点击后只展示两个动作：`修改密码`、`退出登录`。
- 暂不提供个人资料、主题设置、通知配置、绑定管理等扩展项。

修改密码：

- 需要输入当前密码、新密码、确认新密码。
- 修改成功后保持登录或要求重新登录均可，第一版建议保持登录并提示成功。
- 修改失败时明确说明原因，例如当前密码错误、新密码不符合规则、两次输入不一致。

密码规则：

- 第一版采用中等强度即可。
- 建议至少 8 位。
- 至少包含字母和数字。
- 不允许与账号相同。
- 不要求复杂到必须包含大小写、特殊字符和定期轮换，避免给少量客户带来不必要摩擦。

管理员重置密码：

- 管理员必须具备重置用户密码的能力，用于用户遗忘密码或首次发放账号。
- 重置后可生成临时密码，要求用户首次登录后修改。
- 管理员重置行为必须写审计日志。

退出登录：

- 清除云端登录态。
- 回到登录页。
- 不影响本地 invest-agent connector、微信监听和 scheduler。

账号模型：

- 云端用户和本地用户助手的绑定表。
- 当前阶段一个云端用户只绑定一个用户助手。
- 用户登录后直接进入自己的助手，不展示实例选择器。

### 页面布局

#### 左侧会话栏

会话栏内容：

- 新建对话按钮。
- 对话历史列表，按更新时间倒序。
- 每个会话展示标题和最近更新时间。
- 当前会话有明确选中态。
- 支持折叠；折叠后主聊天区扩展。
- 左下角固定用户头像和菜单。

会话标题：

- 优先用第一条用户消息自动生成短标题。
- 没有标题时显示“新的对话”。
- 第一阶段可以不做重命名和删除；如实现删除，需要二次确认。

会话空态：

- 没有历史时显示简洁空态，并保留新建对话入口。
- 本地 connector 离线时，会话列表可以显示缓存历史，但不能假装可继续发送。

#### 右侧聊天区

聊天区内容：

- 当前会话消息流。
- 用户消息靠右或有明确用户身份样式。
- 助手消息靠左或有明确助手身份样式。
- 底部固定输入框。
- 输入框支持多行输入。
- `Enter` 发送，`Shift+Enter` 换行。
- 发送中禁用重复发送同一条消息，但允许用户继续编辑下一条草稿。

空对话状态：

- 展示一句克制的引导语，例如“你可以直接问持仓、复盘、选股或提醒相关问题。”
- 不展示大段功能说明、营销文案或复杂快捷入口。

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

第一阶段不要求真实后端流式。优先采用“完整回复返回后，前端快速打字机式呈现”的体验方案：后端仍按一次请求/一次完整回复处理，前端收到完整文本后用接近流式的方式逐步渲染，减少后台接口改动。

协议和 UI 状态仍应预留 `chunk` / `done` / `error` 三类事件，方便后续升级为真实 SSE/WebSocket 流式。

第一版对话体验要求：

- 用户发送后立即把用户消息插入消息流。
- 助手侧立即出现“正在思考”状态，避免空等。
- 完整回复返回后，助手消息以较快的逐字/分段方式出现，形成“流式加载效果”。
- 结束后落定为普通助手消息。
- 失败时在助手消息位置显示可理解错误，并提供重试入口。

等待状态需要降低焦虑：

- 0-2 秒：显示“正在发送...”或轻量 loading。
- 2-10 秒：显示“正在分析你的问题...”
- 超过 10 秒：显示“任务还在执行，可能涉及工作空间或行情数据查询。”
- 超过 30 秒：允许用户继续等待，或提示稍后回来看；不要让页面像卡死。

发送按钮状态：

- 空输入禁用。
- 正在发送时显示进行中状态。
- connector 离线时禁用发送，并提示“助手暂时离线，本地服务恢复后可继续。”

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

用户完整对话记录必须被可靠保存。建议采用“双层存储”：

- 本地 canonical conversation log 是权威源，保证微信端和网页端进入同一套长期历史。
- 云端保存完整对话镜像，用于用户门户快速加载左侧历史和消息详情。
- 云端镜像通过 connector 写入/同步，允许短暂延迟，但要能通过 `messageId` / `requestId` 幂等对账。
- 如果云端镜像缺失或过期，门户应能向本地 connector 拉取并补齐。

左侧历史加载策略：

- 默认分页加载，按更新时间倒序。
- 首屏只加载必要字段：会话 id、标题、最近更新时间、最后一条消息摘要。
- 点开会话后再加载消息正文。
- 对长会话做分页或虚拟滚动，避免一次性加载过多消息。
- 云端可以用完整镜像优化体验，但不得让云端镜像成为唯一历史来源。

完整历史以本地 canonical log 为最终依据，云端镜像用于用户体验和远程访问。

### 门户状态

第一阶段至少需要处理这些状态：

| 状态 | 用户看到什么 | 系统行为 |
| --- | --- | --- |
| 未登录 | 登录页 | 不加载任何用户数据 |
| 已登录且 connector 在线 | 聊天页 | 可读取历史、发送消息 |
| 已登录但 connector 离线 | 聊天页 + 离线提示 | 可看缓存历史，禁止发送 |
| 会话为空 | 空态引导 | 可新建并发送第一条消息 |
| 消息发送中 | 用户消息已出现，助手 loading | 禁止重复提交同一条 |
| 流式回复中 | 助手消息逐步出现 | 持续接收 chunk |
| 回复失败 | 错误消息 + 重试 | 保留用户原消息和失败状态 |
| 登录过期 | 回到登录页 | 清理前端会话态 |

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
- 云端技术栈默认采用 Next.js，部署到自有服务器并用 PM2 管理。
- 明确账号密码登录方案、密码存储方案、改密规则和管理员重置密码能力。
- 明确完整对话历史采用本地 canonical log + 云端完整镜像的双层存储。

验收：

- 能回答“用户门户不是 Dashboard 重构，也不是 Platform 外网化”。
- 能画出云端与本地的通信边界。
- 能画出登录页、左侧会话栏、右侧聊天区、左下角用户菜单的页面结构。

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
- 左侧展示可折叠的对话历史。
- 左下角用户头像菜单只包含修改密码和退出登录。
- 能新建网页会话并发送消息。
- 本地 workspace ACP 返回回复。
- 对话记录落本地 canonical log。
- 页面能处理发送中、完整回复后的打字机式呈现、失败重试和 connector 离线状态。

验收：

- 普通用户不能访问其他用户助手。
- 网页消息以 `channel=web` 记录。
- 左侧会话栏可折叠，折叠后聊天区扩展。
- 修改密码成功后新密码可登录，旧密码不可登录。
- 退出登录后不能继续读取会话或发送消息。
- 用户发送消息后立即看到自己的消息和助手等待状态。
- 第一版无需真实后端流式；完整回复返回后，助手消息以打字机式或分段方式快速呈现。UI 仍有明确等待状态和超时提示。
- connector 离线时可看缓存历史，但发送入口禁用。
- 微信链路不受影响。

### Phase 4: 轻量用户首页或投资概览

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
| 云端保存完整正文 | 隐私与合规风险 | 用户门户需要完整历史体验；本地 canonical log 仍为权威源，云端镜像应限制访问、加密传输和存储、保留审计 |
| 长连接不稳定 | 对话失败 | connector 心跳、重连、请求超时、幂等 requestId |
| 长任务让用户焦虑 | 用户以为页面卡死或重复提交 | 立即展示等待状态、分阶段提示、失败重试和可恢复状态 |
| 密码能力做得过重 | 第一阶段复杂度失控 | 只做预置账号、登录、修改密码、退出登录、管理员重置密码；不做注册和找回密码 |
| 同一助手多个 connector 在线 | 重复处理消息、重复落库 | 同一用户助手只允许一个 active connector；重复连接要拒绝或明确接管并记录审计 |

## 已定决策与保留评估

1. **技术栈与部署**:默认采用 Next.js；部署到自有服务器，用 PM2 管理 Node 进程，前置 Nginx/Caddy 提供 HTTPS 和反向代理。Relay 第一版可与门户同进程，后续再拆。
2. **对话历史存储**:完整对话记录必须保存。本地 canonical conversation log 是权威源；云端保存完整镜像以保障门户体验，左侧历史分页/摘要加载，点开后再加载正文。
3. **第一版回复体验**:不做真实后端流式；后端返回完整回复后，前端用快速打字机式/分段渲染制造接近流式的体验。协议预留真实流式升级。
4. **密码规则**:第一版采用中等强度密码规则，建议至少 8 位且包含字母和数字；用户可修改密码，管理员必须具备重置密码能力。不做自助注册和找回密码。
5. **多 connector**:Relay 可支持多个 connector 同时在线服务不同用户助手；同一用户助手只允许一个 active connector。这个能力主要服务未来多机器/测试/迁移，不改变一用户一助手模型。

## 执行交接提示

Executor prompt:

```text
请基于 docs/user-portal-design.md 推进用户门户第一阶段。不要改造 /platform 为公网用户产品，不要把云端实现成第二套 invest-agent 运行时。默认采用 Next.js + PM2 部署。第一阶段用户门户必须包含账号密码登录、管理员重置密码、左侧可折叠对话历史、右侧 Chatbot 对话区、左下角用户头像菜单(仅修改密码/退出登录)、发送等待状态、完整回复后的打字机式呈现、失败重试和 connector 离线提示。优先实现本地 canonical conversation log 的数据模型和查询 API，然后实现 portal connector 与云端 relay，再实现网页聊天体验。完整对话历史必须保存：本地为权威源，云端保存完整镜像用于门户体验。所有变更必须保持微信直达 workspace ACP 主链路不变。
```

Reviewer prompt:

```text
请按 docs/user-portal-design.md 审查实现结果。重点检查：云端是否只承担 portal/relay 职责；本地 workspace/ACP/SQLite 是否仍是运行时源头；用户门户是否无法访问 Platform 管理命令；对话历史是否有 canonical log，而不是直接复用 codex_acp_traces；云端是否保存完整对话镜像且能与本地权威历史对账；登录、改密、管理员重置密码、退出登录、左侧会话栏折叠、发送等待状态、完整回复后的打字机式呈现、失败重试、connector 离线提示是否符合验收；同一用户助手是否只允许一个 active connector；微信链路是否无回归。
```
