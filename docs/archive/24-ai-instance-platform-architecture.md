# 多 AI 项目运行平台架构共识

## 背景

Hermes 后端链路最初是为了验证投资助手的新运行链路；当前阶段 Codex ACP 是主智能后端，Hermes 是可选 backend adapter 和回归验证对象。长期目标不是“投资助手支持多用户”，也不只是“投资助手有多个实例”。

更准确的方向是：本系统要逐步演化为一个 **微信入口的多 AI 项目运行平台**。

投资助手只是第一个 AI 项目。未来同一平台还可以承载饮食管理、会议纪要、个人知识库、客服、健康管理等不同 AI 项目。这些项目彼此隔离，各自有自己的 skills、工具权限、上下文配置、会话、审计、推送和沙箱边界。

因此，当前架构讨论里的核心隔离单位应从“用户”上移到 **AI 项目**。现有 `instance_id` 是当前代码中承载隔离的工程字段，但产品和长期架构上更重要的是 `project_id`。

## 核心结论

1. AI 项目是产品层面的运行单元，也是长期最重要的隔离单位。
2. AI 项目不直接拥有独立数据库；它拥有 skills、工具调用能力、配置和沙箱策略。
3. 数据由平台服务或项目工具服务托管，但所有可变数据必须按 `project_id` 进行 scope。
4. Skills 属于 AI 项目，定义项目的思考方式、工作流和输出纪律。
5. Tools 属于平台或项目服务，是确定性 API 能力，由沙箱权限决定是否可调用。
6. 投资助手 Dashboard 是项目看板，不是最终平台后台。
7. 最终平台后台应该总览所有 AI 项目、连接状态、后端状态、推送队列、审计和异常。

## 命名约定

为了避免“project / instance / type”混用，先采用以下约定。

### AI Project

AI Project 是一个具体可运行的 AI 工作空间。

例子：

- `daiyk-invest-main`
- `user-a-diet-main`
- `family-health-assistant`
- `customer-support-demo`
- `meeting-notes-workspace`

AI Project 绑定：

- 一个 `project_id`。
- 一个 owner 或主要用户。
- 一个 project type。
- 一组 skills 或 skill bundle。
- 一组允许调用的 tools。
- 一套沙箱权限策略。
- 一个或多个 channel identity。
- 一个 agent backend routing 策略。
- 一组可被工具读写的 project-scoped resources。

产品表达上可以直接称它为“AI 项目”。

### Project Type / Template

Project Type 是项目模板或能力类型，不是隔离单位。

例子：

- `invest-agent`
- `diet-agent`
- `meeting-agent`
- `knowledge-agent`
- `support-agent`

Project Type 定义：

- 默认 skill bundle。
- 可用工具列表。
- 推荐权限矩阵。
- 默认 prompt / workflow。
- 输出规范。
- 风险边界。
- 需要的 project resource 类型。

同一个 project type 可以创建多个 AI Project。例如多个用户都可以有自己的投资助手项目。

### AI Instance

`AI Instance` 这个词在当前代码中已经出现，短期可以继续保留，但它应被理解为 **AI Project 的工程运行记录或兼容层**，不是产品层最终主语。

当前代码里：

- `ai_projects` 更接近 project type 或项目模板。
- `ai_instances` 更接近实际 AI Project。
- `instance_id` 当前承担了实际隔离主键。

长期可以逐步改名或重新解释为：

- `project_types`
- `ai_projects`
- `project_id`

短期不急于重命名代码字段，避免破坏当前 Codex ACP 主链路、Hermes 可选后端验证和投资闭环；但文档和后续设计应以 `project_id` 作为主隔离语义。

## 目标架构

```text
External User
  -> Channel Connector (WeChat / Web / Feishu / ...)
  -> Platform Service
  -> AI Project Router (project_id)
  -> Sandbox Context (project_id, user_id, channel, permissions)
  -> Agent Backend (Hermes / Codex ACP / ...)
  -> Project Skill Bundle
  -> Allowed Tools
  -> Platform / Project Tool APIs
  -> Project-scoped Resources
  -> Reply / Push Queue
  -> Channel Connector
```

## Platform Service

Platform Service 负责所有项目共享的基础设施。

职责：

- Channel 连接管理，例如微信扫码、会话身份、推送目标。
- Agent backend 路由，例如 Hermes / Codex ACP。
- AI Project registry。
- Sandbox token 签发和校验。
- Tool registry 和权限矩阵。
- Push queue。
- Audit logs。
- Execution traces。
- Pending confirmation。
- 平台 Dashboard。

Platform Service 不应该理解具体业务判断。例如它不应该知道某只股票是否值得加入自选，也不应该知道饮食管理的营养策略。

## AI Project

AI Project 负责自己的智能行为定义。

它拥有：

- skills。
- project config。
- prompt / workflow 配置。
- tool permissions。
- sandbox policy。
- channel bindings。
- runtime state。

它不直接拥有：

- 独立数据库进程。
- 不受限制的全局表访问能力。
- 修改其他项目数据的能力。
- 修改平台连接、后端、全局设置的能力。

## Skills 与 Tools 的边界

### Skills

Skills 是 AI 项目的思考和执行手册。

它定义：

- 如何理解用户意图。
- 如何组织工作流。
- 什么时候调用哪些工具。
- 输出结构和语言纪律。
- 证据要求。
- 风险表述。
- 用户偏好和方法论。

投资助手的 skills 包括复盘、选股、风险评估、技术位置、行业分析等。

饮食管理项目的 skills 可能包括饮食记录解析、营养建议、禁忌约束、长期计划调整等。

### Tools

Tools 是确定性能力，由平台或项目工具服务提供。

例子：

- `stock.quote.read`
- `invest.watchlist.add`
- `invest.plan.set`
- `review.save`
- `diet.meal.log`
- `nutrition.calculate`
- `calendar.event.create`
- `push.weixin.send`

Tools 必须通过 sandbox context 执行。AI 不能靠 prompt 自己决定 `project_id`，服务端必须从 token 或路由上下文确定 project scope。

## 数据模型原则

AI 项目不直接拥有数据库，但项目工具可以拥有 project-scoped resources。

推荐数据 scope：

```text
project_id -> resource_type -> resource_id
```

如果资源需要绑定用户，可再加：

```text
project_id -> user_id -> resource_type -> resource_id
```

当前投资助手表已经在向下面这个过渡形态迁移：

```text
user_id + instance_id -> investment rows
```

短期这可以接受，因为 `instance_id` 当前等价承担了具体 AI Project 的隔离作用。长期应收敛到：

```text
project_id -> investment rows
```

或者：

```text
project_id -> owner_user_id -> investment rows
```

## 沙箱原则

沙箱目标不是只防止 A 用户改 B 用户的数据，而是防止：

1. 一个 AI 项目误读或误写另一个 AI 项目的数据。
2. 一个项目调用了不属于自己的工具。
3. AI 幻觉出错误的 `project_id`、`user_id` 或 `instance_id`。
4. 普通项目调用平台管理接口。
5. 同一用户的多个 AI 项目互相污染记忆、skills、工具状态和推送目标。

Sandbox token 应绑定：

```ts
{
  projectId,
  projectType,
  userId,
  channel,
  backend,
  conversationId,
  permissions,
  skillBundleId,
  expiresAt
}
```

当前代码里仍会带 `instanceId`，因为它是现阶段的工程隔离字段：

```ts
{
  projectId,
  instanceId,
  userId,
  channel,
  backend,
  conversationId,
  permissions,
  expiresAt
}
```

服务端必须从 token / channel binding / router 解析项目上下文，不能信任 AI 在请求体中传入身份字段。

## Dashboard 分层

### Platform Dashboard

未来平台后台应该展示：

- 所有 AI 项目。
- 每个项目的 project type。
- 绑定的 channel identity。
- 使用的 agent backend。
- 当前连接状态。
- 最近对话状态。
- push queue 状态。
- sandbox audit。
- pending confirmations。
- 错误和健康状态。

这是平台管理台。

### Project Dashboard

项目看板展示具体项目业务数据。

例子：

- 投资助手：持仓、自选、预案、提醒、复盘。
- 饮食助手：餐食记录、营养摄入、目标、禁忌、建议。
- 会议助手：会议列表、纪要、待办、跟进状态。

当前 `/dashboard` 是投资助手 Project Dashboard，不是最终 Platform Dashboard。

## 当前系统对应关系

| 当前对象 | 新架构定位 | 说明 |
| --- | --- | --- |
| Hermes 项目微信连接 | Agent backend route + channel route | 不是投资助手本身，只是一条运行链路 |
| `users` | human owner / user | 用户不是最终隔离单位，但仍用于 owner 和 channel identity |
| `ai_projects` | 当前更像 project type | 后续可改为 project template/type |
| `ai_instances` | 当前实际 AI Project | 当前 `instance_id` 是主要隔离字段 |
| `channel_identities` | 外部身份映射 | 应路由到默认 AI Project |
| `channel_identity_instances` | channel 到 AI Project 的路由映射 | 当前名字偏 instance，语义上是 project binding |
| sandbox token | project-scoped capability token | 当前包含 `instanceId`，未来应以 `projectId` 为主 |
| sandbox audit | 平台级审计 | 必须记录 project scope |
| push_jobs | 平台级可靠投递 | 必须记录 project / channel / backend |
| 投资业务表 | invest-agent project tools 的 resource tables | 当前已按 `instance_id` 隔离，长期按 `project_id` 收敛 |
| `.codex/skills/invest-agent-*` | invest-agent project skill bundle | 未来每个 project type 有自己的 skill bundle |
| 当前 Dashboard | 投资助手项目看板 | 不是最终平台管理台 |

## 投资助手在新架构中的位置

投资助手是第一个 project type。

它的组成：

- Project type：`invest-agent`
- Skills：投资复盘、选股问答、风险评估、技术位置、行业分析等。
- Tools：行情、资金流、自选、持仓、预案、提醒、复盘保存、推送。
- Resources：投资相关数据表。
- Dashboard：投资项目看板。

不同投资助手 AI 项目可以共用同一套 project type，但拥有不同：

- owner。
- skill bundle 版本。
- 方法论配置。
- watchlist / portfolio / plans / alerts。
- 推送目标。
- backend routing。

## 推荐演进路径

### Phase 1：保留现有服务，校准语义

目标：不拆仓库、不推翻投资助手闭环，先把平台语义写清楚。

任务：

1. 文档统一使用“AI 项目”作为产品隔离单位。
2. 说明当前 `instance_id` 是工程兼容字段。
3. sandbox token、audit、trace、push queue 继续携带 `projectId + instanceId`。
4. 投资助手继续作为第一个 project type 运行。

### Phase 2：项目级隔离闭环

目标：让当前 Codex ACP 主链路和 Hermes 可选后端链路都真正按 AI 项目隔离。

任务：

1. 现有投资业务表继续保持 `instance_id` 隔离。
2. 新增或改造 registry，使具体 AI 项目的主键语义更接近 `project_id`。
3. channel identity 默认绑定到具体 AI 项目。
4. sandbox API 全部从 token 解析项目 scope。
5. 传统 handler 也全部支持 project / instance scope。

### Phase 3：Project Type / Skill Bundle

目标：投资助手成为可复用模板，而不是平台唯一业务。

任务：

1. 定义 project type manifest。
2. manifest 描述 skills、tools、权限、默认 prompt、resource schema。
3. AI Project 可选择或覆盖 skill bundle。
4. Tool registry 按 project type 暴露工具。

### Phase 4：平台后台

目标：把当前投资 Dashboard 和平台 Dashboard 分离。

任务：

1. Platform Dashboard 展示所有 AI 项目。
2. Project Dashboard 只展示单个项目业务数据。
3. 平台后台可查看连接、backend、push queue、audit、确认请求、健康状态。
4. 平台后台不直接混入投资业务细节。

### Phase 5：多项目运行

目标：同一平台可运行多个不同类型 AI 项目。

任务：

1. 支持创建饮食管理、会议纪要等非投资项目。
2. 每个项目绑定自己的 skill bundle。
3. 每个项目只获得允许的 tools。
4. 微信入口能路由到不同 AI 项目。
5. 不同项目的数据、审计、推送和运行状态互不干扰。

## 当前不要做的事

1. 不要马上拆成多个仓库。
2. 不要马上把投资助手抽成完整插件系统。
3. 不要因为平台化而破坏当前投资助手闭环。
4. 不要让 AI 通过 prompt 自己选择项目 scope。
5. 不要把 `user_id` 当成长期隔离单位。
6. 不要让具体 AI 项目直接拥有无限制数据库访问。

## 已完成工作的重新解释

- Codex ACP 主链路：当前复杂推理和 skill 执行主路径。
- Hermes 后端链路：平台 Agent backend adapter 的早期验证与可选回归路径。
- 微信扫码页：channel connector 管理能力的验证。
- 多用户隔离：项目隔离的前置阶段。
- `instance_id`：当前具体 AI 项目的工程隔离字段。
- sandbox token：project-scoped capability token 的雏形。
- push_jobs：平台级可靠投递队列。
- sandbox audit：平台级操作审计。
- 投资 Dashboard：invest-agent project dashboard。

## 当前代码与目标语义的偏差

1. `ai_projects` 当前更像 project type，不是具体 AI Project。
2. `ai_instances` 当前更像具体 AI Project。
3. `instance_id` 当前承担了实际隔离主键。
4. 投资业务表尚未显式携带 `project_id`。
5. Dashboard 仍是投资项目看板，不是平台管理台。
6. Tool registry 和 project type manifest 尚未抽象。

这些偏差短期可以接受。当前重点是不要继续在文档和设计上把“多用户投资助手”当成最终目标。

## 下一步建议

下一步不急于继续改业务功能，先按 [25-ai-project-registry-and-manifest.md](./25-ai-project-registry-and-manifest.md) 做两个设计补齐：

1. 定义 AI Project registry 的目标字段。
2. 定义 Project Type manifest 的最小结构。

建议目标字段：

```text
ai_projects
- id                具体 AI 项目 ID，长期主隔离键
- type              project type，例如 invest-agent
- owner_user_id
- name
- status
- backend
- skill_bundle_id
- config
- created_at
- updated_at
```

建议 project type manifest：

```text
project_type
- id
- display_name
- default_skill_bundle_id
- allowed_tools
- default_permissions
- resource_types
- default_prompt_profile
- default_strategy_skill_id
- dashboard_type
```

当前代码可以先继续用 `ai_instances.id` 承担 `ai_projects.id` 的语义，等 Codex ACP 主链路、Hermes 可选后端和平台沙箱稳定后再做命名和表结构收敛。
