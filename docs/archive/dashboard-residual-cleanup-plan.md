# Dashboard 残留盘点与清理方案

> 状态：产品决策已确认，待执行
> 日期：2026-07-16
> 范围：本地 `invest-agent-ideal` 主线；不修改或部署火山云冻结版本

## 1. 结论

仓库中确实存在 Dashboard 残留，但要分成三类处理：

1. **确定死代码**：可以优先清理，不需要产品迁移。
2. **仍在运行的过渡实现**：`/dashboard` 页面和聚合路由目前仍被注册、链接和文档声明，不能直接删除。
3. **历史兼容语义**：`dashboard` channel、sandbox 权限名、legacy `alerts` 数据等不一定对应当前页面，需要独立迁移，不能按关键词一删了之。

推荐目标是：

- `/platform` 成为唯一的本地管理员入口。
- 微信和云端 Portal 继续作为用户入口。
- workspace Agent 只使用 MCP 服务工具。
- HTTP 只保留有明确非 Agent 消费者的适配器。
- 不把现有 1600 行 Dashboard 原样搬入 Platform；只迁移仍有运维价值的最小能力。

## 2. 当前事实

### 2.1 Dashboard 仍然是活跃入口

| 证据 | 当前状态 | 判断 |
| --- | --- | --- |
| `src/server.ts` | 调用 `registerDashboardRoutes(app)` | Dashboard 仍在服务启动时注册 |
| `src/admin/platform-page.ts` | Platform 导航和实例详情链接到 `/dashboard` | Platform 仍把它当正式工作台 |
| `src/routes/dashboard.ts` | 提供 `/dashboard`、`/api/dashboard` 和约 30 个 CRUD/运维端点 | 不是单纯静态残留 |
| `src/admin/dashboard-page.ts` | 1631 行，自包含完整投资工作台 | 仍有持仓、自选、预案、规则、复盘、观点、对话、微信等页面 |
| `scripts/security-boundary-smoke.mjs` | 验证 Basic Auth 后 `/dashboard` 返回 200 | 安全契约仍认可该入口 |
| `README.md`、`CLAUDE.md`、`docs/system-overview.md` | 明确将 Dashboard 定义为本地投资工作台 | 当前可信文档尚未宣布退役 |

因此，直接删除 `dashboard-page.ts` 和 `routes/dashboard.ts` 会造成真实能力损失，并让当前文档、Platform 链接和安全检查同时失效。

### 2.2 高置信残留

| 残留 | 证据 | 建议 |
| --- | --- | --- |
| `src/admin/weixin-page.ts` | 渲染函数没有调用者；`/admin/weixin` 已经 301 到 Dashboard | 删除页面文件和无效 import；重定向改到 Platform 的实例/微信管理入口 |
| `src/routes/watch-rules.ts` | 导出 `registerWatchRuleRoutes`，但服务从未注册；同名端点又复制在 `routes/dashboard.ts` | 不直接删除；把它收敛成 canonical 独立路由并注册，再删除 Dashboard 内重复定义 |
| Dashboard 内未被页面调用的 API | `/api/users*`、`/api/indicators*`、legacy `/api/alerts/*`、`/api/strategies*`、`/api/reviews/*` 等没有仓库内运行时消费者 | 进入兼容消费者审计；无外部调用后删除或拆入明确的领域路由 |
| 全局微信管理 API | `/api/weixin/*` 与 Platform 的实例级微信 API 重叠 | Platform 实例级 API 保留；全局 API 进入退役流程 |
| Dashboard ACP 后端切换 | `/api/acp-backends/switch` 允许 UI 改全局推理后端 | 不迁移到 Platform；收敛为显式运行时配置，避免管理员误切全局后端 |
| legacy `alerts` | 不参与当前 scheduler 规则巡检，只被旧 Dashboard/sandbox 兼容接口和聚合快照读取 | 单独做数据迁移和兼容退役，最终删除表和旧接口 |

### 2.3 不能直接删除的同名语义

以下关键词虽然包含 `dashboard`，但不是同一类页面残留：

- `channel: "dashboard"`、`acknowledged_via: "dashboard"`、`source: "dashboard"`：可能已经写入历史记录。应停止产生新值，但不应破坏旧数据读取。
- `invest.dashboard.read`：当前是 sandbox 聚合读取权限名，服务仍在检查。要么删除对应兼容 API，要么先引入中性名称并提供短期 alias。
- `/api/sandbox/dashboard`：是 workspace 范围快照，不是本地 Dashboard 页面。应按消费者决定改名为 snapshot 或退役。
- Portal 协议中的 `dashboard.snapshot`：属于云端协议能力名，不证明本地 `/dashboard` 仍需存在。协议改名必须单独版本化。
- `/acp/alerts` 和全局 `pendingAlerts`：是邻近的旧 OpenClaw 兼容面，不属于 Dashboard 本身；可在本轮登记，但应独立验证后清理。

## 3. 目标边界

### 3.1 保留

- Platform：实例、workspace、成本、日志审计、规则巡检审计、数据源质量、实例级微信连接与探测。
- MCP：Agent 使用的确定性查询、确认写入、规则、复盘和行情能力。
- Portal connector：云端用户会话入口和权威对话日志同步。
- Scheduler/push：时间性和状态性服务职责。
- 独立 watch-rule HTTP adapter：仅在确认仍有非 Agent 消费者时保留。

### 3.2 不迁移

- Dashboard 的整套页面结构和视觉代码。
- 在管理 UI 中直接切换全局 ACP backend。
- legacy `alerts` 编辑能力。
- 仅为了“可能有用”而保留的通用 CRUD。
- Dashboard 中与 Platform 已重复的微信、对话、规则审计能力。

### 3.3 确认迁移

在 Platform 实例详情增加一个紧凑的只读“投资状态”区域：

- 当前持仓和现金摘要。
- 自选数量和前若干项。
- 当前预案和明确规则数量。
- 最近复盘产物链接或摘要。

不迁移持仓、自选、预案、策略的直接写按钮，也不设计绕过用户对话的投资数据 repair action。所有普通业务修改继续走用户对话 + MCP 确认工作流，不保留平行 CRUD。

## 4. 能力去向表

| Dashboard 能力 | 当前实现 | 目标动作 |
| --- | --- | --- |
| 用户/实例切换 | `/api/dashboard` + 页面 selector | 删除，Platform 已拥有实例管理 |
| 微信连接 | 全局 `/api/weixin/*` | 删除或短期重定向到 Platform 实例级 API |
| 对话记录 | Dashboard 聚合读取 ACP trace | 删除重复视图，使用 Platform 审计时间线 |
| 规则巡检审计 | Dashboard 事件/规则页 | 删除重复视图，使用 `/platform#rule-alerts` |
| 持仓/自选/预案读取 | `/api/dashboard` 聚合 | 迁移为 Platform 实例级紧凑只读 snapshot |
| 持仓/自选/预案写入 | `/api/portfolio*`、`watchlist*`、`plans*` | 无外部消费者时删除；不迁到 Platform |
| 交易策略 CRUD | `/api/strategies*` | 优先由 MCP/确认流程承担；兼容调用者为空时删除 |
| watch rules | Dashboard 内重复 HTTP 路由 | 抽到并注册独立 `routes/watch-rules.ts` |
| legacy alerts | `/api/alerts/set|toggle|remove` + `alerts` 表 | 先冻结写入和导出，再删除接口，最后迁移表 |
| 指标定义 | `/api/indicators*` | 有外部消费者则独立成只读领域路由，否则删除 |
| 信号配置 | `/api/signals/update` | 判断是否仍是产品能力；若保留，进入明确的 Platform 运维设置，不留在 Dashboard |
| 巡检间隔 | `/api/interval/set` | 配置化或迁入 Platform 运维设置；避免通用裸 API |
| ACP backend | `/api/acp-backends*` | 删除 UI 切换；后端选择由环境和运行时配置控制 |
| 手动巡检/测试推送 | 全局 alert/weixin API | 收敛到 Platform 的实例级、可审计操作 |
| 复盘阅读/观点追踪 | Dashboard 聚合 | 用户阅读走 Portal；管理员诊断走 Platform/文件审计，避免双实现 |

## 5. 分阶段执行

### Phase 0：建立退役清单和消费者证据

目标：在删除任何活跃端点前，明确每个端点的消费者和退出方式。

1. 建立机器可读或文档化 endpoint manifest：路径、owner、当前消费者、认证方式、目标动作、移除版本。
2. 对仓库内消费者做静态检查；当前已知 Dashboard 页面是多数 CRUD 的唯一代码消费者。
3. 当前服务没有通用访问日志，无法证明是否存在仓库外脚本。对候选旧端点增加短期结构化访问计数，或由负责人明确签字放弃兼容观察期。
4. 火山云冻结版本只用于对照，不部署 instrumentation，不以其模板或流量反推本地主线接口仍应保留。
5. 已确认不存在管理员绕过用户对话直接编辑持仓/自选/预案的需求；endpoint manifest 不为此类写入保留迁移目标。

交付物：完整 endpoint manifest 和最终 keep/move/remove 决策。

### Phase 1：清除确定死代码并解除路由耦合

目标：先做不改变产品能力的清理。

1. 删除未使用的 `renderWeixinAdminPage` import 和 `src/admin/weixin-page.ts`。
2. 将 `/admin/weixin` 过渡重定向改为 `/platform#instances`，启动日志不再宣传旧微信后台。
3. 将 `src/routes/watch-rules.ts` 修正为 canonical HTTP adapter：
   - 在 `server.ts` 显式注册。
   - 与 service 层共享 `create/list/update/delete/dry-run/validate` 实现。
   - 保持 userId/instanceId scope 和 service auth。
   - 删除 `routes/dashboard.ts` 内完全重复的 watch-rule 路由。
4. 增加路由唯一性检查，防止两个模块再次声明相同 method + path。

验收：功能不变；watch-rule HTTP 端点仍可用；没有重复注册；旧微信页代码消失。

### Phase 2：补齐最小 Platform 替代能力

目标：只补齐 Dashboard 退役后确实会缺失的运维信息。

1. 增加实例级只读端点，例如：
   - `GET /api/platform/instances/:instanceId/investment-state`
2. 响应只包含受控摘要，不复制 `/api/dashboard` 的大聚合对象。
3. Platform 实例详情按需展示持仓、自选、预案、规则和最近复盘摘要。
4. 手动微信探测、规则审计、对话审计继续使用现有 Platform 能力，不重复建设。
5. 不增加投资数据 repair action，不恢复通用 body/query `userId` CRUD；所有投资数据修改继续由用户对话触发并经过 MCP 确认。

验收：管理员不进入 Dashboard 也能完成已确认的必要运维任务。

### Phase 3：退役 Dashboard 页面和专属 API

目标：停止双入口维护。

1. 删除 Platform 中所有“打开 Dashboard”链接。
2. 移除 `registerDashboardRoutes` 注册和 `renderDashboardPage`。
3. 删除 `src/admin/dashboard-page.ts`。
4. 将 `/dashboard` 先改成到 `/platform` 的 301 过渡入口；兼容期结束后移除该路由。
5. 删除只被 Dashboard 页面消费、且 manifest 标记为 remove 的端点：
   - `/api/dashboard`
   - `/api/users*`
   - `/api/portfolio*`
   - `/api/watchlist*`
   - `/api/plans*`
   - `/api/strategies*`
   - `/api/indicators*`
   - `/api/acp-backends*`
   - 旧 `/api/reviews*`
   - 全局 `/api/weixin*` 和模拟推送端点
6. 被确认仍有独立消费者的端点必须先迁到领域路由，不能继续挂在名为 `dashboard.ts` 的文件下。

验收：服务不再渲染 Dashboard；Platform 是唯一管理 UI；不存在 Dashboard 专属业务路由模块。

### Phase 4：清理 legacy alerts 和历史权限命名

目标：删除已经不参与规则巡检的第二套提醒模型。

1. 使用 `db-migration` 工作流盘点 `alerts` 行数、最近更新时间、用户和实例分布。
2. 将仍有业务价值的旧规则导出为审计归档；不要自动转换成有效 `alert_rules`，避免未经用户确认重新启用提醒。
3. 先删除 legacy 写端点：
   - `/api/alerts/set|toggle|remove`
   - `/api/sandbox/alerts/set|toggle|remove`
4. 从 dashboard/sandbox snapshot 移除 legacy alerts 字段。
5. 删除旧 tool manifest 中只指向 legacy alert CRUD 的能力；保留当前 `watch_rules.*` 和确定性 `alerts.check` 语义。
6. 在独立数据库迁移中删除 `alerts` 表、索引、schema 定义、初始化兼容和实例删除级联引用。
7. 对 `invest.dashboard.read` 做二选一：
   - 如果 `/api/sandbox/dashboard` 一并退役，直接删除该权限；
   - 如果 snapshot 仍被兼容调用者使用，引入 `invest.snapshot.read`，保留一轮 alias 后删除旧名。
8. 历史数据中的 `channel/source/acknowledged_via = dashboard` 保持可读，但新代码停止写入。

验收：当前规则巡检只有 `alert_rules` 一套机器规则源；代码不再读写 legacy `alerts`。

### Phase 5：文档、测试和发布收口

目标：让仓库可信来源与新边界一致。

1. 更新 `AGENTS.md`、`CLAUDE.md`、`README.md`、`docs/system-overview.md`、`docs/table-ownership.md` 和 watch runtime 文档。
2. 删除 Dashboard CRUD 表格和本地 Dashboard URL；明确 Platform、Portal、MCP、HTTP adapter 的边界。
3. 更新安全检查：
   - `/platform` 仅 loopback + session 或 service auth。
   - `/dashboard` 在过渡期返回 301，最终返回 404。
   - 独立 watch-rule HTTP adapter 仍要求 service auth。
4. 增加 route inventory/唯一性测试，避免未注册路由文件和重复端点再次出现。
5. 验证 Platform 的实例、审计、规则、数据源、微信功能，以及 MCP tools 和 scheduler 行为。
6. 本地主线验收通过后再决定是否形成新的生产版本；火山云冻结版本不原地修改。

## 6. 验收标准

### 6.1 代码与路由

- `registerDashboardRoutes`、`renderDashboardPage` 和 Dashboard 页面链接不存在。
- `src/admin/dashboard-page.ts`、`src/admin/weixin-page.ts` 不存在。
- 所有注册路由都有明确 owner；不存在未注册的 route module。
- 同一个 method + path 只定义一次。
- `/dashboard` 按阶段返回 301 或最终 404，不再返回工作台 HTML。
- workspace Agent 的 prompt/Skill 中没有本地 HTTP 或 Dashboard 依赖。

### 6.2 功能

- Platform 能完成实例管理、workspace 操作、审计、规则巡检查看、数据源查看和实例级微信管理。
- Scheduler、push queue、Portal connector 和微信正常运行。
- MCP 仍覆盖 Agent 所需的持仓、自选、预案、规则、行情、复盘和确认能力。
- 独立保留的 HTTP adapter 具有认证、scope、审计和明确消费者。

### 6.3 数据

- legacy `alerts` 删除前有行数盘点、归档、回滚备份和迁移记录。
- 删除 legacy 表不会删除 `alert_rules`、`alert_events` 或当前巡检状态。
- 历史 `dashboard` 来源值仍可读取，不因 enum/类型收窄导致旧数据失败。
- 不自动把旧提醒升级为当前有效规则。

### 6.4 文档

- 当前可信文档不再把 Dashboard 描述为正式产品边界。
- `docs/archive/` 可以保留历史 Dashboard 叙述，但当前导航不把它当现状。
- 火山云冻结版本与本地主线的差异被明确记录，不混用模板和运行时结论。

## 7. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 仓库外脚本仍调用旧 API | Phase 0 访问计数或负责人签字；先迁移/301，再删除 |
| 删除 Dashboard 后有人临时要求人工改投资数据 | 坚持已确认边界：回到用户对话 + MCP 确认流程，不恢复管理端写入口 |
| watch-rule 路由抽取造成重复注册或行为漂移 | 先注册 canonical module，再删重复；加入 method/path 唯一性检查 |
| legacy alerts 被误当成当前规则迁移 | 只归档，不自动启用；迁移必须使用 db-migration 工作流 |
| Platform 再次膨胀成第二个 Dashboard | 只迁移已经确认的紧凑只读摘要；不迁移投资数据写操作 |
| 当前工作树改动较多导致误删 | 每个 Phase 独立提交；只改 manifest 标记范围；验收后再进入下一阶段 |
| 火山云稳定版本被本地清理影响 | 本方案不直接部署；生产升级使用新包、独立验收和可回滚版本 |

## 8. 回滚策略

- Phase 1–3 每阶段独立提交，Dashboard 删除前保留最后可运行 commit/tag。
- `/dashboard` 先重定向一个兼容周期，再彻底移除。
- 数据表删除必须晚于代码停止读写，并保留 SQLite 备份和导出清单。
- 若发现外部 HTTP 消费者，恢复对应领域 adapter，不恢复整个 Dashboard 页面。
- 若 Platform 最小替代不足，只补具体缺口，不回滚到双工作台长期并存。

## 9. 执行顺序建议

推荐拆成四个可独立验收的变更：

1. **PR A：死代码与 watch-rule 路由解耦**
   无产品行为变化，风险最低。
2. **PR B：Platform 最小替代与 Dashboard 页面退役**
   完成唯一管理入口切换。
3. **PR C：旧 HTTP/sandbox adapter 和权限命名清理**
   依赖消费者证据。
4. **PR D：legacy alerts 数据库迁移和文档收口**
   使用 db-migration Skill，独立备份、验收和回滚。

不建议把四部分放在一个大提交中。

## 10. 已确认产品决策

以下决策已于 2026-07-16 确认，后续执行不再重新打开，除非产品边界发生正式变更：

1. Platform 保留持仓、自选、预案、复盘的紧凑只读实例摘要。
2. 不存在管理员绕过用户对话直接修正投资数据的真实需求。Platform 不提供相关写按钮或 repair action；投资数据修改统一走用户对话 + MCP 确认工作流。

## 11. 执行交接

Executor prompt:

按照 [dashboard-residual-cleanup-plan.md](./dashboard-residual-cleanup-plan.md) 分阶段执行。产品决策已经确认：Platform 需要紧凑只读投资摘要，但不得增加绕过用户对话的投资数据写入或 repair action。先完成 Phase 0 和 PR A，不扩大到 Dashboard 页面删除或数据库迁移。保留当前未提交用户改动，建立 endpoint manifest，清理确定死代码，将 watch-rule HTTP 路由收敛为唯一注册模块，并按验收标准报告证据。任何无法确认的仓库外消费者必须登记为阻塞项，不得自行假设不存在。

Reviewer prompt:

独立审查实现是否符合 [dashboard-residual-cleanup-plan.md](./dashboard-residual-cleanup-plan.md)。重点检查路由是否唯一、是否误删仍有消费者的 HTTP adapter、Platform/微信/MCP 是否保持可用、legacy alerts 是否被未经确认地迁成有效规则，以及是否触碰火山云冻结版本。按 pass/partial/fail 给出验收结论和文件级证据。
