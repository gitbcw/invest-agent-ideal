# Platform 合伙人后台改造设计初稿

> 状态：产品与架构初稿 + Phase 0 盘点稿。角色、Partner 数据边界、登录方式和火山云入口已按当前决策收敛；本阶段不改代码、不部署火山云。
> 范围：Invest Agent Platform 管理后台，不包含普通用户 Portal 重做。

## 1. 背景与判断

当前 Platform 是面向开发者和运维人员的本地管理面，已经能够查看用户助手、成本、对话/推送审计、规则巡检和数据源质量，也能执行实例创建、删除、微信连接、测试推送和测试实例重置等高权限操作。

它目前不适合直接开放给合伙人，原因不是单纯“页面不够漂亮”，而是产品边界尚未成立：

- 当前认证本质上是共享服务令牌或本机临时 session，没有独立后台账号。
- 没有角色、数据范围和操作权限区分。
- 经营信息、客户运营信息、质量信息和工程运维信息混在同一导航中。
- 删除实例、重置数据、微信连接等高风险动作与只读统计在同一权限面。
- 页面从运行时数据出发组织，而不是从合伙人的管理任务出发组织。
- 统计偏成本和日志，缺少客户活跃、Onboarding、服务质量、推送效果和异常趋势；其中成本不属于合伙人首版可见范围。

因此本次改造应被定义为：**把本地运维 Platform 升级为邀请制、多角色、可审计的内部管理后台。**

## 2. 产品定位

Platform 是公司内部管理后台，用于：

1. 了解产品经营和客户使用情况。
2. 发现未完成配置、消息未触达、复盘失败、数据源异常等问题。
3. 在授权范围内处理客户运营和运行时问题。
4. 审计模型输出、工具调用、推送和后台人员操作。
5. 管理后台成员、角色和数据访问范围。

Platform 不是：

- 普通投资用户的产品入口。
- 绕过用户对话直接修改投资数据的工具。
- 暴露服务器、Workspace 文件或内部凭据的工程控制台。
- 用主观结果计算“策略胜率”或“投资收益率”的绩效系统。

## 3. 设计原则

### 3.1 权限由两部分组成

第一版每次访问按角色执行：

```text
Owner：可管理系统
Partner：可看全部客户的经营数据，但字段和操作严格受限
```

当前所有 Partner 都可看全局经营数据，因此第一版不建设客户分配系统。未来如果出现分区域或分团队管理，再在角色权限之外增加数据范围。

### 3.2 默认最小权限

- 新成员默认只读。
- 原始对话、持仓摘要和联系方式属于敏感信息，需要单独权限。
- 删除、重置、解绑、测试推送和凭据生成必须是独立高风险权限。
- 前端隐藏按钮不算权限控制，所有 API 必须服务端鉴权。

### 3.3 经营、运营、质量、运维分层

- 经营层回答“用户、配置、触达和服务质量是否健康”。
- 运营层回答“哪些客户状态需要关注”。
- 质量层回答“助手哪里表现不好”。
- 运维层回答“哪个运行链路故障”。

### 3.4 不制造不存在的统计

当前系统没有可靠的真实成交和收益数据，因此第一版不提供策略胜率、客户收益率或推荐准确率。可以统计服务行为、规则触发、复盘覆盖和用户确认，但不能把它们包装成投资绩效。

## 4. 建议角色模型

第一版不做任意权限编排器，只提供两个预设角色。

| 角色 | 主要用户 | 默认能力 |
| --- | --- | --- |
| Owner | 创始人/系统负责人 | 全部权限、成员管理、角色管理、高风险操作 |
| Partner | 合伙人 | 全部客户的经营聚合、运营指标和服务质量；只读，不看原始对话、持仓明细、成本、资金、策略正文、规则条件、微信身份或系统凭据 |

### 4.1 权限域

建议不要把权限命名为页面名称，而是按资源和动作定义：

- `overview.read`
- `customers.read`
- `customers.sensitive.read`
- `conversations.read`
- `conversations.raw.read`
- `quality.read`
- `cost.read`
- `operations.read`
- `instances.create`
- `instances.archive`
- `instances.reset_test`
- `weixin.connect`
- `weixin.disconnect`
- `weixin.test_push`
- `portal.credential.issue`
- `access.manage`
- `admin_audit.read`

### 4.2 数据范围

Partner 的数据范围固定为全部客户，但只能读取经营聚合和脱敏客户状态。它不能读取原始客户数据，也不拥有任何写权限。第一版不增加客户分配表或自定义 scope。

## 5. 登录与安全设计

### 5.1 第一版登录方式

根据当前决策，第一版采用服务器固定公网 IP 作为访问入口，并使用账号密码登录：

1. Platform 通过火山云服务器固定公网 IP 的独立管理入口访问，端口固定为 `22646`，不直接暴露 runtime 的 `22655`。
2. Owner 创建后台成员和初始密码。
3. 首次登录强制修改初始密码。
4. 密码使用强哈希保存，错误次数限流，账号可禁用。
5. 会话使用 `HttpOnly + SameSite=Lax` Cookie；由于入口是 HTTP，不能设置 `Secure`，这也是已知安全残余。
6. Partner 账号只获得只读经营权限，不显示管理操作入口。

暂不接入 TOTP、SSO、短信找回或复杂的企业身份系统。当前明确不使用 HTTPS 和域名，访问入口为火山云服务器公网 IP 的 `22646` 端口，即 `http://<火山云服务器公网IP>:22646/platform`。由于 HTTP 登录凭据可能被网络窃听，这属于已知安全残余，必须通过强随机密码、短会话、登录限流、失败锁定和云防火墙规则降低风险；不能把固定 IP 或非标准端口当作加密替代品。

### 5.2 网络入口

当前 `/platform` 依赖本机/SSH tunnel，不应直接把 `22655` 暴露公网。

建议两阶段：

- 近期：在火山云服务器上通过 `22646` 提供独立 Platform 入口，访问地址为 `http://<火山云服务器公网IP>:22646/platform`；只暴露 `/platform` 和 `/api/platform/*`，不暴露 runtime 的 `22655`，并叠加登录、限流、失败锁定和云防火墙规则。
- 中期：如果出现多台 runtime，将 Platform 控制面独立部署；各 runtime 通过受认证的管理通道上报状态，不让浏览器直连运行时。

### 5.3 后台操作审计

所有后台写操作记录：

- 操作者账号、角色和数据范围。
- 操作类型、目标客户/实例。
- 请求时间、来源 IP、User-Agent。
- 操作前后摘要，不记录密码、令牌和二维码内容。
- 成功/失败、失败原因和关联 request ID。

高风险操作不得只写普通应用日志，应写入独立、只追加的管理员审计表。

## 6. 信息架构

建议将当前五个工程型导航重组为任务型入口；Partner 默认只看到经营、客户、异常、质量、触达五类入口，Owner 额外看到成本与权限。

### 6.1 经营总览

第一屏回答“今天产品和客户是否正常”：

- 客户总数、已激活数、近 7 日和近 30 日活跃客户数。
- Onboarding 完成率、进行中数量、配置异常数量。
- 今日对话量、成功回复率、P50/P95 响应时间。
- 今日/本周复盘生成率和定时任务成功率。
- 推送送达率、重试率、失败率和当前待处理数量。
- 产品质量异常数、重复确认/超时/失败回复数量和受影响客户数。
- 当前服务异常数、数据源异常数和受影响客户数。
- 近 30 日活跃趋势与客户留存趋势。

不使用大量装饰卡片。顶部保留 6-8 个核心数字，下面用趋势图和“需要处理”列表承接。

### 6.2 客户与助手

Partner 看到的是经营状态列表，不是投资资料列表。字段建议：

- 客户显示名/脱敏用户标识、助手状态。
- Onboarding 状态和缺失步骤。
- 微信是否绑定、是否可主动推送。
- 最近活跃时间、近 7 日对话数。
- 最近复盘时间、最近推送状态。
- 当前通知偏好、启用规则数（只显示数量，不显示规则内容）。
- 健康状态：正常、需关注、阻塞。

支持按活跃度、Onboarding、微信状态、推送状态和健康状态筛选。

Partner 的客户详情只保留经营相关页面：

1. 概览：助手状态、Onboarding 状态和服务健康。
2. 使用情况：对话量、复盘生成、推送结果和活跃趋势，只显示数量和状态。
3. 配置状态：方法是否完成、通知偏好和规则数量，不展示配置正文。
4. 质量与运行：响应延迟、失败次数、任务和推送状态。

Partner 不显示原始对话、持仓明细、股票代码、成本、资金、策略正文、规则条件、微信身份和任何管理按钮。

### 6.3 经营异常

这是只读的经营风险列表，不引入客户负责人和待办流转：

- Onboarding 超过一定时间未完成。
- 配置状态完成但正式文件缺失或不一致。
- 连续多日无复盘或复盘失败。
- 微信已绑定但不可主动推送。
- 推送连续失败或等待用户重新发消息。
- 多次重复确认、单轮超时、用户明确纠正助手。
- 近 7/30 日不活跃客户。

每条事项包含类别、数量、趋势、影响范围和最近更新时间。Partner 只查看，不处理、不分配、不修改客户投资数据。

### 6.4 产品质量

将当前“日志审计”升级为问题导向视图：

- 对话成功率、失败率、超时率。
- P50/P95 回应时间及趋势。
- 工具调用错误排行。
- Onboarding 各步骤耗时、确认轮次和流失位置。
- 重复确认、错误成功表述、配置不一致等确定性质量事件。
- 日/周/月复盘覆盖率和生成失败。
- 用户纠正、负反馈和人工标记的问题。

原始 trace 作为详情证据，不再作为页面的第一层结构。

### 6.5 运行与触达

合并现有推送审计、规则巡检和运行任务：

- Scheduler 任务成功率与延迟。
- 各类复盘、盘中简报和规则巡检运行情况。
- Push queue 状态、送达率、失败原因和重试趋势。
- 微信连接、最近入站和主动推送就绪状态。
- 规则触发与去重结果。

### 6.6 成本与用量（Owner-only）

保留当前 Codex 用量能力并增强，但只对 Owner 可见。合伙人首版不看模型成本、客户成本、单用户成本或异常高成本会话。

- 总成本与按日趋势。
- 按客户、场景、模型和通道拆分。
- 活跃客户人均成本、每次成功对话成本、每份复盘成本。
- 高成本异常会话和环比变化。
- 数据口径和覆盖率说明，避免把缺日志误认为零成本。

### 6.7 系统与权限

仅 Owner 可见：

- 后台成员、角色、数据范围、账号状态。
- 登录记录和管理员操作审计。
- 数据源健康和运行环境状态。
- 版本、部署时间和数据库迁移状态。
- 安全配置状态，不展示真实密钥。

## 7. 视觉与交互方向

### 7.1 视觉气质

定位为安静、可信、密度适中的运营工作台：

- 浅色中性背景，深灰正文；状态色只用于正常、关注、阻塞和危险。
- 8px 以内圆角，不使用大面积渐变、装饰性卡片或营销式 Hero。
- 表格承担比较，趋势图承担变化，侧边抽屉承担快速详情。
- 页面标题保持紧凑；核心数据不使用夸张大字号。
- 图标按钮用于刷新、筛选、导出和更多操作，并提供 tooltip。

### 7.2 页面结构

```text
左侧导航
  品牌/环境标识
  经营总览
  客户与助手
  经营异常
  产品质量
  运行与触达
  成本与用量（Owner-only）
  系统与权限（按权限显示）

顶部栏
  当前环境 + 日期范围 + 全局搜索 + 通知 + 当前账号

主区域
  页面标题与关键动作
  筛选条
  指标/趋势/列表
```

桌面端优先支持 1280px 以上；平板允许查看和处理普通运营事项；高风险管理动作不以移动端为主要场景。

### 7.3 必备状态

每个页面必须覆盖：加载中、空数据、部分数据缺失、无权限、请求失败和数据过期。统计必须显示时间范围、更新时间和口径说明。

## 8. 数据与统计口径

### 8.1 可直接复用的数据

- `users` / `ai_instances`：客户与实例。
- `conversation_sessions` / `conversation_messages`：活跃和对话量。
- `codex_acp_traces`：响应时间、错误和模型用量；Partner 只能使用脱敏后的响应时间、状态和错误聚合，不返回原文、Prompt、回复正文、token 或 cost 字段。
- `onboarding_drafts` / `onboarding_state.yaml`：Onboarding 进度和一致性。
- `scheduled_task_runs`：任务成功率和延迟。
- `push_jobs` / 微信 delivery attempt：触达状态。
- `alert_rules` / `alert_events`：规则与触发。
- Workspace 只读派生状态：Onboarding 是否完成、配置项是否存在、通知偏好、规则数量、最近复盘时间；Partner 不读取持仓、自选、策略正文、规则条件或复盘正文。
- 数据源质量日报和告警。

### 8.2 建议新增的后台数据

- 后台账号、角色和权限。
- 后台登录/session 状态。
- 管理员操作审计。
- 经营异常聚合的计算口径和缓存状态。
- 可选的用户反馈/质量标记。

第一版统计优先实时聚合现有表；只有查询变慢或历史口径需要冻结时，再增加日统计快照。不要一开始建设独立数据仓库。

## 9. 技术架构建议

### 9.1 前端形态

当前 `platform-page.ts` 是单文件 HTML/CSS/JS。继续在该文件叠加登录、权限和七个模块会迅速失控。

建议将 Platform 前端拆为独立的管理端应用，但仍由本仓库构建和部署：

- 前端：沿用仓库现有可用框架；若没有既定管理端框架，采用 React + TypeScript + Vite。
- 服务端：继续由 Fastify 提供 `/api/platform/*`。
- 契约：用显式 response schema；前端不直接依赖数据库结构。
- 第一阶段保留旧 Platform 路由作为 Owner 运维回退入口，完成验收后再切换。

### 9.2 鉴权与授权

新增独立的 Platform auth 模块，不复用用户 Portal 登录，也不复用 `INVEST_AGENT_API_TOKEN` 作为人员身份。

建议数据表：

- `platform_users`
- `platform_roles`
- `platform_user_roles`
- `platform_sessions`
- `platform_login_events`
- `platform_admin_audit_logs`

每个 `/api/platform/*` 路由声明所需 permission，统一 preHandler 校验；Partner 查询固定为经营聚合和脱敏字段。未来增加分配范围后，再在查询层应用数据 scope；禁止由前端传任意 `userId` 绕过服务端权限。

### 9.3 敏感信息处理

- 列表默认不返回原始对话正文、持仓明细和微信身份信息。
- 原始对话按单独权限按需加载，并记录查看审计。
- 日志和 trace 默认脱敏 token、路径、内部 prompt 和凭据。
- 导出功能仅 Owner 可用，需要单独权限、操作确认和导出审计；Partner 首版不提供导出。

## 10. 分阶段实施

### Phase 0：产品决策与数据盘点

- 确认角色、数据范围、敏感数据边界和管理入口。
- 给现有 Platform API 标注权限、风险等级和目标页面。
- 固化核心统计口径与时间范围。
- 产出页面线框和响应式信息架构。

#### Phase 0.1 权限矩阵

| 能力 | Owner | Partner | 说明 |
| --- | --- | --- | --- |
| 登录 Platform | 是 | 是 | 两者都必须使用后台账号密码登录。 |
| 查看经营总览 | 是 | 是 | Partner 只看经营、活跃、Onboarding、复盘、推送和质量聚合。 |
| 查看客户列表 | 是 | 是 | Partner 只看脱敏客户标识和运营状态。 |
| 查看单客户运营详情 | 是 | 是 | Partner 只能看配置完成状态、活跃、复盘、推送和健康状态。 |
| 查看产品质量 | 是 | 是 | Partner 只看聚合指标和脱敏问题类型。 |
| 查看运行与触达 | 是 | 是 | Partner 只看任务/推送状态聚合和失败类型，不看消息正文。 |
| 查看成本与用量 | 是 | 否 | 成本、token、单客户成本和高成本会话均 Owner-only。 |
| 查看原始对话/Prompt/回复正文 | 是（需审计） | 否 | 即使 Owner 查看也要记录管理员审计。 |
| 查看持仓明细/股票代码/成本价/资金 | 是（需单独权限） | 否 | Partner 只能看到数量级状态，例如“持仓配置已完成”。 |
| 查看策略正文/规则条件/复盘正文 | 是（需单独权限） | 否 | Partner 只能看到是否存在、数量、最近更新时间。 |
| 创建/删除/重置实例 | 是 | 否 | 高风险操作。 |
| 微信连接/断开/测试推送 | 是 | 否 | 高风险操作，必须审计。 |
| 生成 Portal 凭据 | 是 | 否 | 高风险操作，必须审计。 |
| 管理后台成员/角色 | 是 | 否 | Owner-only。 |

#### Phase 0.2 Partner 数据暴露边界

Partner 允许读取：

- 客户总数、激活数、近 7/30 日活跃数。
- Onboarding 完成/进行中/异常数量和单客户步骤状态。
- 对话量、成功率、失败率、P50/P95 响应时间。
- 日/周/月复盘生成率、失败率和最近生成时间。
- 推送送达率、失败率、重试率、失败原因分类和待处理数量。
- 微信是否绑定、是否可主动推送、最近入站/出站时间。
- 通知偏好、规则数量、配置项是否存在、最近更新时间。
- 数据源质量、任务运行状态和产品质量事件分类。

Partner 禁止读取：

- 原始对话、用户原文、Prompt、模型原始回复、推送正文。
- 持仓名称、股票代码、数量、成本价、资金、现金比例。
- 自选股名称、股票代码、观察理由。
- 策略正文、规则条件、价格区间、止损止盈、用户投资方法细节。
- 复盘正文、观点正文、内部 Chain/trace、sandbox token、Workspace 路径。
- WeChat external user id、二维码、登录态、Portal 凭据。
- token/cost/model cost、单客户成本、高成本异常会话。

#### Phase 0.3 当前 Platform API 盘点与处置

| 当前接口 | 当前暴露内容/能力 | 风险 | Partner 处置 | Owner 处置 |
| --- | --- | --- | --- | --- |
| `GET /platform` | 单文件运维页面；本机访问自动发 session | 高 | 不复用，改为登录后的 Partner 专用壳 | 保留为 Owner 入口或回退页 |
| `GET /api/platform/instances` | 实例、owner、workspace、channel binding、recent traces、持仓/自选/预案/规则数量 | 高 | 禁止直接访问；用脱敏客户列表替代 | 加权限保护 |
| `GET /api/platform/audit` | 用户原文、Prompt、回复正文、push 文本、trace、cost 字段 | 极高 | 禁止直接访问 | Owner-only，查看正文需审计 |
| `GET /api/platform/rule-alerts` | 规则、触发、任务、事件，可能包含用户规则上下文 | 高 | 只允许聚合数量和失败分类 | Owner-only 或拆出脱敏运行视图 |
| `GET /api/platform/audit/usage` | Codex token/cost 用量 | 中 | 禁止访问 | Owner-only |
| `GET /api/platform/source-quality` | 数据源质量报告、告警和健康状态 | 中 | 禁止直接访问；只能读取 runtime-health 派生的脱敏摘要 | Owner 可看完整运行细节 |
| `GET /api/platform/instances/:id/investment-state` | 持仓代码、名称、成本价、自选理由、预案价格、策略、复盘观点 | 极高 | 禁止直接访问；用配置状态摘要替代 | Owner-only，敏感详情需审计 |
| `POST /api/platform/instances` | 创建实例并生成 Portal 凭据 | 高 | 禁止 | Owner-only，写审计 |
| `POST /api/platform/instances/:id/portal/credential` | 生成 Portal 登录信息 | 极高 | 禁止 | Owner-only，写审计 |
| `DELETE /api/platform/instances/:id` | 删除实例/停 ACP/影响 workspace | 极高 | 禁止 | Owner-only，写审计 |
| `POST /api/platform/instances/:id/reset-test` | 删除测试实例大量数据和 workspace | 极高 | 禁止 | Owner-only，写审计 |
| `GET /api/platform/instances/:id/weixin/status` | 微信连接与 delivery 状态 | 中 | 只允许脱敏状态摘要 | Owner 可看完整状态 |
| `POST /api/platform/instances/:id/weixin/connect/start` | 启动微信登录 | 极高 | 禁止 | Owner-only，写审计 |
| `POST /api/platform/instances/:id/weixin/listener/start` | 启动监听 | 高 | 禁止 | Owner-only，写审计 |
| `POST /api/platform/instances/:id/weixin/connect/stop` | 停止微信连接 | 高 | 禁止 | Owner-only，写审计 |
| `POST /api/platform/instances/:id/weixin/push/test` | 主动测试推送给用户 | 高 | 禁止 | Owner-only，写审计 |
| `POST /api/platform/instances/:id/workspace/ensure` | 补建 workspace / 初始化运行时 | 高 | 禁止 | Owner-only，写审计 |

#### Phase 0.4 建议新增 Partner API 契约

第一版 Partner 不读取现有高风险接口，而是新增只读、脱敏、聚合 API：

| 新接口 | 用途 | Partner 返回边界 |
| --- | --- | --- |
| `GET /api/platform/partner/overview` | 经营总览 | 客户、活跃、Onboarding、对话成功率、复盘覆盖、推送送达、异常数量；不含成本。 |
| `GET /api/platform/partner/customers` | 脱敏客户列表 | customerKey、显示名/脱敏标识、助手状态、Onboarding 状态、最近活跃、复盘/推送状态、通知偏好、规则数量。 |
| `GET /api/platform/partner/customers/:customerKey/operations` | 单客户运营详情 | 配置完成状态、活跃趋势、复盘/推送状态、质量事件数量；不返回投资明细。 |
| `GET /api/platform/partner/quality` | 产品质量 | 成功率、超时率、重复确认、错误类型、Onboarding 步骤耗时和流失；全部聚合。 |
| `GET /api/platform/partner/runtime-health` | 运行与触达 | scheduler、push、数据源、微信可触达状态摘要和失败分类。 |

所有新接口必须由服务端从登录 session 解析角色，不接受前端传入 role；Partner 固定全客户数据范围，但只能拿脱敏字段。

#### Phase 0.5 Partner 可执行字段契约

第一版 Partner API 必须采用显式 allowlist。禁止把现有 Owner API 的返回对象复用后“删几个字段”直接返回；每个 Partner response 都必须由服务端构造新对象。

##### 0.5.1 脱敏标识

- customerKey：由服务端使用 HMAC-SHA256(platform_anonymization_secret, instanceId) 生成，格式为 cus_<12 hex>。不得使用 userId、instanceId、微信 external id 或其明文后缀。
- customerLabel：默认格式为“客户 <customerKey 后 6 位>”。除非 Owner 后续显式维护非敏感展示名，否则 Partner 不显示用户真实姓名、微信名、手机号、OpenID、externalAccountId 或 ownerUserId。
- Partner 查询单客户详情时只接受 customerKey，服务端反查内部 instanceId；不得允许 Partner 传 userId、instanceId 或 workspace path。
- platform_anonymization_secret 由运行时密钥配置提供，不写入 Workspace、数据库或 response。轮换时保留 active/previous 两个 secret 只用于读取旧 customerKey，新增 response 统一使用 active secret；截断后碰撞必须检测并拒绝启动，不能静默合并客户。

##### 0.5.2 Partner response allowlist

GET /api/platform/partner/overview 只能返回：ok、updatedAt、timeRange(start/end/timezone)、metrics、exceptions、dataQuality。metrics 限于客户数、活跃数、Onboarding 数量、今日对话量、对话成功率、响应 P50/P95、复盘覆盖率、推送送达率、质量异常数、数据源异常数；不得包含 cost、token、模型名、原文或内部路径。

GET /api/platform/partner/customers 只能返回：customerKey、customerLabel、assistantStatus、onboardingStatus、missingSetupSteps、wechatBound、pushReachable、lastInboundAt、lastOutboundAt、lastActiveAt、conversationCount7d、lastReviewAt、lastPushStatus、notificationPreference、enabledRuleCount、health、分页游标和筛选回显。

GET /api/platform/partner/customers/:customerKey/operations 只能返回：customerKey、customerLabel、配置完成布尔值、notificationPreference、enabledRuleCount、conversationCount7d、reviewCount30d、pushCount7d、wechatBound、pushReachable、lastPushStatus、failureCategory、timeoutCount7d、errorCount7d、repeatConfirmationCount7d。

GET /api/platform/partner/quality 和 GET /api/platform/partner/runtime-health 只能返回聚合数组，元素最多包含 type、status、count、rate、p50Ms、p95Ms、latestAt、affectedCustomers 和 trend。不得包含原始消息、Prompt、回复、规则条件、股票代码、内部路径、token、cost 或外部账号标识。

##### 0.5.3 现有接口逐字段剥离规则

| 来源 | Partner 禁止字段/内容 | Partner 允许派生 |
| --- | --- | --- |
| summarizeInstance / GET /api/platform/instances | owner.id、真实 owner.displayName、workspace.path、workspace.identity、permissions、resourceTypes、allowedTools、config、channelBindings、externalAccountId、externalUserIdSuffix、recentTraces.userText | assistantStatus、workspaceReady 布尔值、traceCount 聚合、holding/watchlist/plan/rule 数量 |
| GET /api/platform/audit | userText、promptText、replyTextRaw、replyTextSanitized、pushJobs.message、reviewContextSummary、sandboxTokenId、token/cost 字段、conversation/message id | 成功/失败/超时数量、响应时间分位数、错误分类 |
| GET /api/platform/rule-alerts | rule condition、ticker/code/name、阈值、事件正文、taskKey 中可反推出客户或规则的信息 | 启用规则数、运行次数、命中次数、失败次数、suppressed 次数、最新运行状态 |
| GET /api/platform/audit/usage | 全部 token/cost/模型成本数据 | Partner 不返回；Owner-only |
| GET /api/platform/source-quality | sourceQualityDir、原始 report/alert payload、内部路径、供应商内部错误栈 | Partner 禁止直接访问；只能由 runtime-health 派生数据源健康状态、异常类别、受影响数据类型、最新更新时间 |
| GET /api/platform/instances/:id/weixin/status | stateDir、二维码 URL/data URL、sessionKey、accountId、external id、lastConversationId、cookies/session、真实账号名 | wechatBound、pushReachable、lastInboundAt、lastOutboundAt、failureCategory |
| GET /api/platform/instances/:id/investment-state | holdings/watchlist/plans/reviews/viewpoints 全部明细、股票代码、名称、成本价、理由、策略、价格区间、观点正文 | portfolioConfigured、watchlistCount、planCount、latestReviewAt、openViewpointCount |
| 所有 POST/DELETE 管理接口 | 全部请求和响应 | Partner 一律 403 |

##### 0.5.4 路由、权限与审计事件

| 路由集合 | 所需 permission | Partner | Owner | 审计事件 |
| --- | --- | --- | --- | --- |
| /api/platform/partner/overview、/customers、/quality、/runtime-health | overview.read / customers.read / quality.read / operations.read | 允许，只返回 allowlist | 允许 | partner_read_aggregate |
| /api/platform/instances、/api/platform/audit、/api/platform/rule-alerts、/api/platform/audit/usage | admin_audit.read 或对应 Owner-only read permission | 403 | 允许，敏感详情按需审计 | sensitive_read |
| /api/platform/source-quality | admin_audit.read | 403；改走 runtime-health 派生 | 允许完整运行细节 | source_quality_read |
| /api/platform/instances/:id/investment-state | customers.sensitive.read | 403 | 允许，必须审计 | investment_state_read |
| POST /api/platform/instances、POST portal/credential、DELETE instance、POST reset-test、POST workspace/ensure | instances.create / portal.credential.issue / instances.archive / instances.reset_test | 403 | 允许 | admin_write |
| POST /api/platform/instances/:id/weixin/* | weixin.connect / weixin.disconnect / weixin.test_push | 403 | 允许 | weixin_admin_write |

所有拒绝都必须记录 actor、role、route、permission、target customerKey（若已解析）、结果和 requestId；不得记录密码、token、二维码或原始对话正文。

##### 0.5.5 统计口径

| 指标 | 来源 | 时间窗 / 去重 | 缺失语义 |
| --- | --- | --- | --- |
| 客户总数 / 已激活数 | users + ai_instances | 当前 active 实例；按 instance 去重 | 表缺失或查询失败为 unknown，不得显示 0 |
| 近 7/30 日活跃客户 | conversation_messages 或 codex_acp_traces | Asia/Shanghai 自然日；按 customerKey 去重 | conversation log 不可用时标记 partial |
| Onboarding 状态 | onboarding_drafts + workspace onboarding_state.yaml 派生布尔状态 | 每客户取最新 draft/state | workspace 读取失败为 exception，不展示文件路径 |
| 对话成功率 | codex_acp_traces.status | 今日；分母为进入 ACP 的会话/推送 trace；按 trace id 去重 | trace 缺失为 unknown |
| 响应 P50/P95 | codex_acp_traces.elapsedMs | 今日成功和失败均可计入，剔除 null | 样本数不足 5 时返回 null 并标注 insufficient_sample |
| 复盘覆盖率 | scheduled_task_runs + review artifacts 派生 | 今日/本周；按 customerKey + reviewType + date 去重 | 调度未开启与生成失败分开 |
| 推送送达率 | push_jobs + weixin_delivery_attempts | 今日；按 push job id 去重 | awaiting_user 单独分类，不算 sent |
| 质量异常数 | trace error/timeout、重复确认事件、onboarding exception | 今日与近 7 日双窗口 | 只能输出类别和数量 |
| 数据源异常数 | source-quality reports/alerts | 最新报告 + 今日 alerts | 原始路径和 payload 不返回 |

所有日期统计默认 Asia/Shanghai。所有 rate 字段在分母为 0 或数据源缺失时返回 null，并在 dataQuality.missing 中说明，禁止把缺失显示为 0。

##### 0.5.6 22646 运行边界

22646 是后续公网管理入口，不得通过把现有 runtime 22655 直接改为 0.0.0.0:22646 来实现。允许两种实现：

1. 独立 Platform listener 监听 22646，只注册 Platform 页面和 Platform API。
2. 本机 runtime 仍绑定 127.0.0.1:22655，由同机反代监听 22646，路径白名单只转发 /platform、/api/platform/auth/* 和授权后的新 Platform API。

无论采用哪种方式，/acp/*、/api/portal/*、/api/sandbox/*、MCP、scheduler 内部接口和 runtime 管理端口都不得因 Partner 后台入口而直接暴露公网。

#### Phase 0.7 迁移、回滚与验证门槛

- Phase 0 不做数据库迁移、不改运行时代码、不部署火山云，只产出角色/权限/数据/API 清单。
- Phase 1 才允许按 `db-migration` 增加后台账号、角色、session、登录事件和管理员审计表；迁移必须是 additive。
- 回滚策略：关闭 `22646` 入口或撤掉新 Platform 路由，保留旧本机 Platform/服务 token 运维入口；新增表不参与旧路径即可安全闲置。
- 权限验证：未登录 401；Partner 对所有高风险旧接口 403；Partner 新接口 200 且 response schema 不含禁用字段；Owner 可访问 Owner-only 能力并记录审计。
- 浏览器验证：Partner 登录后只看到经营总览、客户与助手、经营异常、产品质量、运行与触达；不出现成本页、日志正文页、创建/删除/重置/微信连接/测试推送/凭据按钮。
- 运行回归：新后台不可影响微信、scheduler、MCP、用户 Portal 和 workspace ACP 普通消息链路。

### Phase 1：账号、登录与 RBAC

已在本地完成服务层第一版，详见 `docs/platform-partner-admin-phase1-implementation.md`：

- 新增后台账号、Owner/Partner 角色、session、登录事件和管理员审计表；迁移标记为 `platform_auth_v1`。
- 完成账号密码登录、首次改密、退出、session 过期/撤销、失败限流和锁定。
- 统一 preHandler 服务端授权；Partner 访问旧高风险 API 返回 403，不能通过 URL/query 绕过。
- 新增 Partner 脱敏聚合 API。

本阶段仍不重写页面，不部署 `22646`，现有 `127.0.0.1:22655` Owner 运维入口保留作为回退路径。

### Phase 2：新后台壳与经营总览

- 独立前端工程、设计令牌、布局、路由和错误状态。
- 经营总览聚合 API。
- 客户列表和客户详情只读能力。
- 旧 Platform 保留为 Owner 回退入口。

### Phase 3：经营指标、质量、运行和 Owner 成本

- 经营异常聚合，不做负责人分配和待办流转。
- 产品质量漏斗和慢/错/重复确认分析。
- 任务、推送、规则和数据源运行视图。
- Owner-only 成本趋势和异常会话。

### Phase 4：权限收口与切换

- 逐项迁移微信、凭据、归档和重置操作。
- 完成角色与数据范围验收。
- 安全测试、审计测试、备份和回滚演练。
- 新后台成为 `/platform`，旧页面进入只读回退期后删除。

## 11. 验收标准

### 11.1 登录与权限

- 未登录无法访问页面和 `/api/platform/*` 数据。
- 每个角色只能看到允许的导航和操作。
- 直接调用隐藏 API 仍会返回 403。
- Partner 无法通过修改 URL、query 或直接调用 API 获取敏感字段或执行管理操作。
- 原始对话查看、高风险操作和导出均有管理员审计记录。

### 11.2 页面与统计

- 总览核心指标均显示时间范围、更新时间和口径。
- 客户列表可在 2-3 次操作内定位未完成 Onboarding、推送失败和不活跃客户。
- 客户详情能在一屏内判断配置、微信、复盘、推送和运行健康。
- 统计为零、数据缺失和采集未覆盖能够被明确区分。
- 1280px 桌面和 768px 平板没有遮挡、溢出或不可用操作。

### 11.3 安全与运行

- 密码使用强哈希，session 可撤销并有过期时间。
- 密码错误限流、账号禁用和 session 撤销通过验证。
- Platform 使用固定公网 IP 的 `22646` 入口；runtime 内部端口 `22655` 不直接暴露公网。
- 新后台故障不影响微信、scheduler、MCP 和普通用户 Portal。
- 数据库迁移有备份、回滚和旧 Platform 回退路径。

## 12. 风险与控制

| 风险 | 控制方式 |
| --- | --- |
| 合伙人误看到过多客户敏感信息 | 角色 × 数据范围；敏感字段独立权限；查看审计 |
| HTTP 登录凭据被窃听 | 强随机密码、短 session、登录限流、失败锁定、云防火墙；明确记录该残余风险 |
| 为了远程访问直接暴露 runtime | 独立 `22646` 管理入口；路径白名单；不开放 22655 |
| 前端隐藏按钮但 API 可调用 | 所有权限在服务端执行 |
| 统计口径不一致 | 每个指标定义数据源、时间窗、去重键和缺失语义 |
| 新后台影响核心投资服务 | 后台聚合限流、只读查询、异步统计；与消息主链路隔离 |
| 单文件页面继续膨胀 | 新管理端独立前端工程，旧页只作过渡 |
| 一开始建设过重的权限系统 | 第一版只做 Owner/Partner 两个预设角色，不做客户分配或任意策略编辑器 |

## 13. 需要负责人提供的信息

以下问题会实质改变方案，应在 Phase 0 确认。按优先级排序：

1. **登录账号由谁创建和重置？** 当前假设由 Owner 管理，不引入自助找回。
2. **Partner 是否可以看到脱敏客户标识和单个客户的运营状态？** 当前假设可以，但不能看到投资信息。
3. **是否需要导出经营统计？** 若需要，需要确认格式、导出范围和审计要求。
4. **移动端要求多高？** 当前假设桌面端为主，手机只做响应式查看，不做管理操作。
5. **环境范围是什么？** 当前假设后台只管理火山云生产，是否还要纳入本地测试环境需要确认。
6. **用户规模预期是什么？** 未来 3、12、24 个月的客户数、后台成员数和日对话量级，用于确定聚合查询是否需要快照表。

## 14. 当前默认假设

在负责人补充信息前，初稿暂按以下假设：

- 后台成员少于 20 人，客户少于 1,000 人。
- Partner 可看全部客户的经营统计和脱敏运营状态，但不看任何投资敏感信息。
- 第一版使用服务器固定公网 IP 入口 + 账号密码，不接 TOTP 和 SSO。
- Platform 通过火山云服务器公网 IP 的 `22646` 入口访问，runtime 的 `22655` 仍不直接暴露。
- 第一版重点是经营、质量和运行概况，不建设投资绩效统计。
- Partner 没有任何管理操作；高风险操作只留给 Owner/内部角色。

## 15. 执行与验收交接

### 执行 Agent 提示词

按照 `docs/platform-partner-admin-design.md` 实施 Platform 合伙人后台改造。先完成 Phase 0 的角色、权限、数据范围和 API 清单，不要直接重写页面。数据库变更使用 `db-migration`，Platform API 变更使用 `service-api-change`。所有授权必须在服务端执行，不得以隐藏前端按钮代替。每个阶段提供迁移、回滚、权限矩阵测试和真实浏览器证据；不得影响微信、scheduler、MCP 和用户 Portal。

### 验收 Agent 提示词

独立验收 `docs/platform-partner-admin-design.md`。重点证明：未登录访问被拒绝；角色和数据范围都由服务端约束；越权修改 URL/API 仍返回 403；敏感数据与高风险操作有独立权限和审计；核心统计口径可复核；新后台故障不影响微信、scheduler、MCP 和用户 Portal。结合数据库、API、浏览器、管理员审计和回滚证据给出 pass/partial/fail，不以页面截图或单元测试通过代替权限穿透测试。
