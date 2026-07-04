# 用户门户目标与验收契约

## 文件目的

本文档是用户门户第一阶段的目标与验收契约。它不替代 [user-portal-design.md](./user-portal-design.md)，而是把设计意图转成可执行、可验证、可回环的目标文件。

设计文档回答“要做成什么样、为什么这样设计”。本文档回答：

- 第一阶段到底做到什么才算完成。
- 执行 Agent 每轮实现后必须验证什么。
- 审查 Agent 应该按什么标准判定通过或打回。
- 哪些成果不能被误判为完成。
- 失败后如何回到实现循环继续修正。

## North Star Goal

用户可以用我们提供的账号和密码登录云端用户门户，查看自己的完整对话历史，并在网页端向自己的唯一投资助手发送消息。消息经云端 Relay 转发到本地 invest-agent connector，最终进入该用户 workspace-scoped Codex ACP；回复回到网页端展示，并被可靠保存到本地权威对话日志与云端对话镜像。

当前产品语义保持不变：一用户一助手一 workspace。`instanceId` 仅作为内部兼容与隔离键，用户门户不提供多实例选择。

## Source Of Truth

- 产品与架构设计：[user-portal-design.md](./user-portal-design.md)
- 当前运行时边界：[../CLAUDE.md](../CLAUDE.md)
- SQLite 与 workspace 边界：[table-ownership.md](./table-ownership.md)
- 沙箱与权限边界：[23-multi-user-sandbox-design.md](./23-multi-user-sandbox-design.md)

如果本文档和设计文档冲突，优先以本文档的验收项判断“第一阶段是否完成”，再回到设计文档修正不一致处。

## Done Definition

第一阶段完成必须同时满足以下条件：

1. 用户能打开云端门户登录页。
2. 用户能用预置账号密码登录。
3. 用户登录后直接进入自己的唯一投资助手聊天页。
4. 左侧有可折叠对话历史栏。
5. 右侧有 Chatbot 对话区和底部输入框。
6. 左下角用户头像菜单只包含修改密码和退出登录。
7. 用户能新建对话、发送消息，并获得来自本地 workspace ACP 的回复。
8. 回复第一版不要求真实后端流式，但完整回复返回后必须有打字机式或分段呈现效果。
9. 用户完整对话记录必须可靠保存：本地 canonical conversation log 是权威源，云端保存完整镜像用于门户体验。
10. connector 离线时，用户能看到明确离线提示；可查看缓存历史，但不能发送消息。
11. 普通用户不能访问其他用户助手，也不能访问 Platform 管理能力。
12. 微信直达 workspace ACP 主链路无回归。

缺少以上任一项，都不能宣称第一阶段完成。

## Non-Goals

第一阶段明确不做：

- 不开放自助注册。
- 不做自助找回密码。
- 不开放 `/platform` 管理能力。
- 不把云端实现成第二套 invest-agent 运行时。
- 不让云端直接读写本地 workspace 文件系统。
- 不做真实后端 token-by-token 流式输出。
- 不做完整投资工作台、复杂报表、策略编辑器或所有 Dashboard CRUD。
- 不提供多助手/多实例选择。
- 不改变微信消息进入本地 workspace ACP 的主链路。

## Product Acceptance

### 登录

- 访问未登录页面时显示登录页。
- 登录页包含账号输入框、密码输入框和登录按钮。
- 登录失败时提示“账号或密码错误”一类的通用错误，不暴露账号是否存在。
- 登录成功后进入聊天页。
- 已登录用户刷新页面后仍保持登录态，除非 session 过期或主动退出。

### 修改密码

- 用户从左下角头像菜单进入修改密码。
- 修改密码需要输入当前密码、新密码、确认新密码。
- 密码规则第一版采用中等强度：
  - 至少 8 位。
  - 至少包含字母和数字。
  - 不允许与账号相同。
- 当前密码错误、新密码不符合规则、两次输入不一致时必须给出清晰错误。
- 修改成功后旧密码不能再登录，新密码可以登录。

### 管理员重置密码

- 管理员具备重置用户密码能力。
- 重置后可生成临时密码。
- 用户使用临时密码首次登录后，应被要求修改密码，或至少明确提示尽快修改。
- 重置动作必须写审计日志。

### 退出登录

- 用户从左下角头像菜单点击退出登录。
- 退出后回到登录页。
- 退出后不能继续读取会话或发送消息。
- 退出不影响本地 connector、微信监听和 scheduler。

### 页面布局

- 登录后页面分为左侧会话栏和右侧聊天区。
- 左侧会话栏可折叠。
- 折叠后右侧聊天区扩展。
- 左下角固定显示用户头像入口。
- 用户头像菜单只包含修改密码和退出登录。

### 对话历史

- 左侧历史按更新时间倒序展示。
- 每条历史展示标题、最近更新时间和可选摘要。
- 首屏历史分页加载，不一次性拉取所有长会话正文。
- 点开会话后再加载消息正文。
- 当前会话有明确选中态。
- 没有历史时显示简洁空态，并保留新建对话入口。

### 网页对话

- 用户可以新建对话。
- 用户可以在底部输入框输入多行消息。
- `Enter` 发送，`Shift+Enter` 换行。
- 空输入时发送按钮禁用。
- 发送后立即显示用户消息。
- 助手区域立即显示等待状态。
- 完整回复返回后，用打字机式或分段方式展示助手消息。
- 回复失败时在消息流中显示可理解错误，并提供重试入口。

### 等待状态

- 0-2 秒：显示轻量发送状态。
- 2-10 秒：显示“正在分析你的问题...”一类提示。
- 超过 10 秒：说明任务可能涉及工作空间或行情数据查询。
- 超过 30 秒：允许用户继续等待或稍后回来，不让页面表现得像卡死。

### 离线状态

- connector 离线时，聊天页必须显示离线提示。
- 离线时允许查看云端缓存历史。
- 离线时发送入口禁用。
- connector 恢复后，页面能恢复发送能力，或刷新后恢复。

## Technical Acceptance

### 推荐技术栈与部署

- 云端门户默认采用 Next.js。
- 部署到自有服务器，用 PM2 管理 Node 进程。
- 前置 Nginx 或 Caddy 提供 HTTPS 和反向代理。
- Relay 第一版可以与门户同仓库/同进程，后续再拆分。

### 本地 canonical conversation log

必须新增或明确实现用户可见对话历史的权威来源，不允许直接把 `codex_acp_traces` 当用户历史。

最低数据要求：

- `conversation_sessions`
- `conversation_messages`
- 支持 `userId + instanceId + channel` 查询。
- 支持按会话查询消息。
- 支持 `messageId` 或等价幂等键。
- 支持记录 `traceId` 或等价审计关联。

### 云端完整镜像

- 云端保存完整对话镜像，用于门户体验。
- 本地 canonical log 仍是权威源。
- 云端镜像缺失或过期时，应能向本地 connector 拉取并补齐。
- 云端镜像写入需要幂等，避免重试导致重复消息。
- 左侧历史加载优先用云端镜像的会话索引和摘要。

### Portal connector

- 本地服务主动连接云端 Relay。
- 云端不主动访问用户本机。
- connector 注册信息至少包含 connector id、用户助手 id、能力、版本、启动时间和心跳。
- connector 断线后能重连。
- 云端能显示该用户助手在线或离线。

### 多 connector 约束

- Relay 可以支持多个 connector 同时在线，服务不同用户助手或不同环境。
- 同一用户助手同一时间只允许一个 active connector。
- 同一条用户消息不得广播给多个 connector。
- 同一用户助手出现重复 connector 时，必须拒绝、标记冲突，或明确接管并记录审计。

### Chat command

云端发给本地的是结构化命令，不是裸 HTTP 代理。

最低字段：

- `requestId`
- `userId`
- `assistantId`
- `instanceId`
- `channel=web`
- `type=chat`
- `conversationId`
- `text`

返回最低字段：

- `requestId`
- `ok`
- `messageId`
- `text` 或 `error`

### 第一版非真实流式

- 后端可以一次性返回完整回复。
- 前端必须做打字机式或分段呈现。
- 协议和 UI 状态预留 `chunk` / `done` / `error`，方便后续真实流式升级。

## Security Acceptance

- 密码不得明文存储。
- session/cookie 必须有过期机制。
- 普通用户不能通过 URL、query、body 或 local storage 修改 `userId` / `instanceId` 来访问其他用户助手。
- 用户门户不能调用 Platform reset/delete/weixin connect/global settings/scheduler trigger/debug trace raw 等管理命令。
- 管理员重置密码必须审计。
- 云端完整对话镜像必须限制访问，加密传输和存储，并保留访问审计。
- 本地 connector token 不得暴露给浏览器。

## Loop Validation Protocol

每一轮执行都必须经历下面的回环：

1. **Plan**: 说明本轮要完成哪些验收项。
2. **Implement**: 只改与本轮验收项相关的代码和文档。
3. **Verify**: 运行自动化检查和必要的手动验收。
4. **Observe**: 对照本文档列出通过、失败、未知项。
5. **Repair**: 对失败项继续修正，不扩大范围。
6. **Record**: 在最终回复或交接记录里写清楚完成项、未完成项和证据。

执行 Agent 不能只说“实现完成”。必须提供验证证据。

## Required Verification

### 本地代码检查

每轮涉及代码时至少运行：

```bash
npm run build
```

如果改动触及现有服务主链路，还需要按影响范围运行相关 smoke 或脚本。

### 用户门户验收

第一阶段完成前必须人工或自动验证：

- 未登录访问会进入登录页。
- 账号密码登录成功。
- 错误密码登录失败。
- 登录后进入聊天页。
- 左侧会话栏可折叠。
- 用户头像菜单只有修改密码和退出登录。
- 修改密码成功。
- 管理员重置密码成功。
- 新建对话成功。
- 发送消息后用户消息立即出现。
- 等待状态出现。
- 完整回复返回后以打字机式或分段方式展示。
- 对话刷新后仍存在。
- 云端镜像可加载历史。
- 本地 canonical log 可查到同一会话。
- connector 离线时禁用发送。
- 退出登录后不能继续访问会话 API。

### 安全验收

- 尝试修改请求中的 `userId` / `instanceId` 访问他人助手，必须失败。
- 普通用户调用 Platform 管理命令，必须失败。
- 管理员重置密码有审计记录。
- 浏览器端拿不到 connector token。

### 回归验收

- 微信消息仍能进入本地 workspace ACP。
- 本地 `/platform` 仍可用于管理员运维。
- scheduler、微信监听、复盘和巡检不因用户门户改动而停止。

## Exit Criteria

只有同时满足以下条件，第一阶段才可以退出：

- Done Definition 全部通过。
- Product Acceptance 全部通过或有明确延期项且不影响主流程。
- Technical Acceptance 中 canonical log、云端镜像、connector、chat command 全部通过。
- Security Acceptance 中用户隔离、密码、管理命令隔离全部通过。
- Required Verification 有证据。
- 微信主链路无回归。
- 审查 Agent 没有 P0/P1 阻塞问题。

## Not Done Signals

出现以下任一情况，不能算完成：

- 只能登录但不能真正和 workspace ACP 对话。
- 只能聊天但没有完整对话历史。
- 只保存云端历史，没有本地权威日志。
- 直接复用 `codex_acp_traces` 当用户历史。
- 普通用户能通过参数访问其他助手。
- 用户门户暴露 Platform 管理命令。
- connector 离线时页面仍允许发送。
- 回复慢时页面没有明确等待状态。
- 修改密码或管理员重置密码没有落地。
- 微信链路出现回归。

## Executor Prompt

```text
请基于 docs/user-portal-design.md 和 docs/user-portal-goal-and-acceptance.md 实现用户门户第一阶段。以 goal-and-acceptance 文档作为完成判定标准。每轮只处理明确验收项，完成后按 Loop Validation Protocol 报告通过、失败、未知项。不要把云端实现成第二套 invest-agent 运行时，不要开放 Platform 管理能力，不要改变微信直达 workspace ACP 主链路。
```

## Reviewer Prompt

```text
请按 docs/user-portal-goal-and-acceptance.md 审查实现结果。先列出 P0/P1 阻塞问题，再逐项标注 Done Definition、Product Acceptance、Technical Acceptance、Security Acceptance 和 Required Verification 的通过/失败/未知状态。不要重新设计，除非当前设计无法安全验收。
```

## References

- [Addy Osmani, Loop Engineering](https://addyosmani.com/blog/loop-engineering/): loop 的重点是把目标、执行、观察、修正设计成可重复系统。
- [Microsoft Developer, A Spec-First Approach to AI-Native Engineering](https://developer.microsoft.com/blog/spec-driven-development-ai-native-engineering): spec 应先定义 guardrails、requirements、constraints、acceptance criteria 和 edge cases。
- [Martin Fowler, Understanding Spec-Driven-Development](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html): 面向 AI coding agents 的 spec 应成为人和 AI 共用的 source of truth。
- [Addy Osmani, How to write a good spec for AI agents](https://addyosmani.com/blog/good-spec/): spec 应聚焦用户、需求和成功标准，并成为工具链中的可执行上下文。
