# Dashboard 残留端点 Manifest

> 配套 [dashboard-residual-cleanup-plan.md](./dashboard-residual-cleanup-plan.md) Phase 0
> 日期:2026-07-16
> 范围:本地 `invest-agent-ideal` 主线,不含火山云冻结版本

本文件是 Phase 0 交付物,基于静态代码扫描 + 仓库内消费者审计。后续 Phase 决策以此为准,不得在没有更新本表的情况下删除端点。

## 列说明

- **端点**:`METHOD path`,可能含路径参数 `:id`。
- **模块**:当前注册该路由的代码位置。
- **仓库内消费者**:页面、Agent、scheduler、外部脚本等。
- **目标动作**(对照 plan §4):
  - `keep` — 留在 Platform/领域 adapter,本路由不动
  - `move` — 迁到独立领域路由或 Platform
  - `remove` — Phase 3 删除
  - `archive` — Phase 4 数据库迁移时再处理
- **阻塞项**:有 ✅ 表示需要先解决依赖才能 remove。

## 1. Dashboard 专属聚合与页面

| 端点 | 模块 | 仓库内消费者 | 目标动作 | 阻塞项 |
| --- | --- | --- | --- | --- |
| `GET /dashboard` | `routes/dashboard.ts` | `admin/platform-page.ts` 链接、`security-boundary-smoke.mjs`、CLAUDE.md | Phase 3 改 301 → 最终 404 | Phase 2 Platform 替代 |
| `GET /api/dashboard` | `routes/dashboard.ts` | `admin/dashboard-page.ts` | Phase 3 remove | Phase 2 Platform 紧凑摘要 |

## 2. 投资数据 CRUD(持仓/自选/预案/策略)

| 端点 | 模块 | 仓库内消费者 | 目标动作 | 阻塞项 |
| --- | --- | --- | --- | --- |
| `POST /api/portfolio/add` | `routes/dashboard.ts` | `admin/dashboard-page.ts` | Phase 3 remove | Phase 2 |
| `POST /api/portfolio/remove` | `routes/dashboard.ts` | `admin/dashboard-page.ts` | Phase 3 remove | Phase 2 |
| `POST /api/watchlist/add` | `routes/dashboard.ts` | `admin/dashboard-page.ts` | Phase 3 remove | Phase 2 |
| `POST /api/watchlist/remove` | `routes/dashboard.ts` | `admin/dashboard-page.ts` | Phase 3 remove | Phase 2 |
| `POST /api/plans/set` | `routes/dashboard.ts` | `admin/dashboard-page.ts` | Phase 3 remove | Phase 2 |
| `POST /api/plans/remove` | `routes/dashboard.ts` | `admin/dashboard-page.ts` | Phase 3 remove | Phase 2 |
| `GET /api/strategies` | `routes/dashboard.ts` | `admin/dashboard-page.ts` | Phase 3 remove |  |
| `POST /api/strategies/set` | `routes/dashboard.ts` | `admin/dashboard-page.ts` | Phase 3 remove |  |
| `POST /api/strategies/remove` | `routes/dashboard.ts` | `admin/dashboard-page.ts` | Phase 3 remove |  |

产品决策(plan §10):不保留任何绕过用户对话 + MCP 确认的投资数据写入。Platform 替代不复制这些 POST/PATCH/DELETE。

> **修正记录(2026-07-16)**:本表前版误列 `GET /api/portfolio`、`GET /api/watchlist`、`GET /api/plans`,原 `routes/dashboard.ts` 不存在这三个 GET 端点(只有 POST add/remove/set)。已删除虚条目。

## 3. Watch-rule HTTP adapter(Phase 1 处理)

| 端点 | 模块(Phase 1 前) | Phase 1 后 | 备注 |
| --- | --- | --- | --- |
| `GET /api/watch-rules/catalog` | `routes/dashboard.ts` | `routes/watch-rules.ts` | 内容一致 |
| `GET /api/watch-rules` | `routes/dashboard.ts` | `routes/watch-rules.ts` | scope 解析等价 |
| `POST /api/watch-rules/validate` | `routes/dashboard.ts` | `routes/watch-rules.ts` | |
| `POST /api/watch-rules` | `routes/dashboard.ts` | `routes/watch-rules.ts` | 写入 `source.kind: "platform_api"`(2026-07-16 已从 `dashboard_api` 改名) |
| `PATCH /api/watch-rules/:id` | `routes/dashboard.ts` | `routes/watch-rules.ts` | 同上 |
| `DELETE /api/watch-rules/:id` | `routes/dashboard.ts` | `routes/watch-rules.ts` | |
| `POST /api/watch-rules/:id/dry-run` | `routes/dashboard.ts` | `routes/watch-rules.ts` | |
| `GET /api/watch-rules/default-scope` | 未注册(仅定义于 `routes/watch-rules.ts`) | `routes/watch-rules.ts` 注册后生效 | 当前不在运行时 |

Phase 1 收敛后 `routes/dashboard.ts` 不再注册任何 `/api/watch-rules*`。

## 4. Sandbox watch-rule / 观察池/预案镜像(本 PR 不动)

`/api/sandbox/watch-rules*` 是 workspace Agent 兜底通道,继续保留在 `routes/sandbox.ts`。Phase 3/4 时按消费者审计处理。

## 5. Legacy alerts(Phase 4 处理)

| 端点 | 模块 | 当前作用 | 目标动作 |
| --- | --- | --- | --- |
| `POST /api/alerts/set` | `routes/sandbox.ts`(早期为 `routes/dashboard.ts`) | 写入 legacy `alerts` 表 | Phase 4 remove(2026-07-16 已完成) |
| `POST /api/alerts/toggle` | `routes/sandbox.ts` | 切换 legacy 规则 | Phase 4 remove(已完成) |
| `POST /api/alerts/remove` | `routes/sandbox.ts` | 删除 legacy 规则 | Phase 4 remove(已完成) |
| `POST /api/alerts/check` | `routes/server.ts` | 手动巡检,写入 `alert_events` | keep(规则巡检主通路,与 legacy alerts 无关) |
| `POST /api/alerts/check-and-push` | `routes/server.ts` | 手动巡检 + 推送 | keep(同上) |
| `POST /api/alerts/mock-and-push` | `routes/server.ts` | 微信链路探测,不写表 | keep(测试通道) |

> **修正记录(2026-07-16)**:前版误列 `GET /api/alerts`,原 `routes/dashboard.ts` 不存在该 GET 端点;legacy `alerts` 表写入端点位于 `routes/sandbox.ts`,Phase 4 已删除。

## 6. 全局微信管理 API

| 端点 | 模块 | 仓库内消费者 | 目标动作 |
| --- | --- | --- | --- |
| `GET /api/weixin/status` | 已删除 | 无 | 2026-07-16 remove |
| `POST /api/weixin/connect/start` | 已删除 | 无 | 2026-07-16 remove |
| `POST /api/weixin/listener/start` | 已删除 | 无 | 2026-07-16 remove |
| `POST /api/weixin/connect/stop` | 已删除 | 无 | 2026-07-16 remove |
| `POST /api/weixin/push/test` | 已删除 | 无 | 2026-07-16 remove |
| `GET /admin/weixin` | `routes/server.ts` | 仅 301 重定向 | 兼容期保留(目标 `/platform#instances`) |
| `POST /api/testing/weixin-simulate` | `routes/server.ts` | smoke 与人工调试 | keep(测试通道) |

> **修正记录(2026-07-16)**:独立复验确认 Platform 使用的是实例级 `/api/platform/instances/:instanceId/weixin/*`,仓库内没有全局 `/api/weixin/*` 消费者。五个全局端点已直接删除；`/admin/weixin` 只保留无副作用的 301 书签过渡。

## 7. 用户与指标(无运行时消费者)

| 端点 | 模块 | 仓库内消费者 | 目标动作 |
| --- | --- | --- | --- |
| `GET /api/users*` | `routes/dashboard.ts` | 无(已无页面 selector) | Phase 3 remove(已完成) |
| `GET /api/indicators*` | `routes/dashboard.ts` | 无前端调用 | Phase 3 remove 或迁只读领域路由(已完成) |
| `POST /api/signals/update` | `routes/dashboard.ts` | `admin/dashboard-page.ts` | Phase 3 决策:并入 Platform 运维设置或迁领域路由(已完成) |
| `POST /api/interval/set` | `routes/dashboard.ts` | `admin/dashboard-page.ts` | 同上(已完成) |
| `GET /api/acp-backends` / `POST /api/acp-backends/switch` | `routes/dashboard.ts` | `admin/dashboard-page.ts` | Phase 3 remove(不迁移切换能力,已完成) |
| `/api/reviews*` 旧聚合 | `routes/dashboard.ts` | `admin/dashboard-page.ts` | Phase 3 remove(用户阅读走 Portal,已完成) |

## 8. 仍属于 Platform / 通用层的端点(本 PR 不动)

Platform 实例、规则巡检审计、数据源质量、实例级微信管理、`/api/sandbox/*`、`/api/portal/*`、`/api/testing/*` 与本方案无关,本表不展开。

## 9. 阻塞项与未解决问题

1. **仓库外脚本**:无通用访问日志,无法证明 5-7 节 remove 候选没有外部 curl/Postman 调用。Phase 3 删除前需要产品负责人签字放弃观察期,或临时增加结构化访问计数。**当前状态**:破坏性删除于 2026-07-16 在用户明确授权下执行;仓库外消费者证据仍未独立核验,移除观察期内的兼容回滚依赖源码控制。
2. **Sandbox 摘要权限名**:`invest.dashboard.read` 已硬切为 `invest.snapshot.read`,`/api/sandbox/dashboard` 已改为 `/api/sandbox/snapshot`,`resourceType` 改为 `investment_snapshot`。仓库内无旧消费者，因此未保留 alias；旧 sandbox token 最长有效期一小时且不能命中新工具权限。
3. **`channel/source/acknowledged_via = "dashboard"` 历史值**:不删旧数据读取;Phase 3 后停止写入新值。**当前状态**:已完成。`/api/chat` 不再接受 `channel=dashboard`,改为 `"weixin-mobile" | "api"`;新 watch-rule 审计 `source.kind` 从 `dashboard_api` 改为 `platform_api`。
4. **Portal 协议 `dashboard.snapshot`**:云端协议名,本地改名必须与 portal 同步版本化,不在本方案范围。

## 10. Phase 1 完成判据

- `routes/watch-rules.ts` 在 `server.ts` 显式注册。
- `routes/dashboard.ts` 不再注册任何 `/api/watch-rules*`。
- 同一 `METHOD path` 不重复注册(由路由唯一性测试守护)。
- `src/admin/weixin-page.ts` 删除;`renderWeixinAdminPage` import 消失。
- `/admin/weixin` 重定向目标改为 `/platform#instances`。
- 启动日志不再宣传 `/admin/weixin` 入口。

**状态(2026-07-16):已完成。**`scripts/route-uniqueness-smoke.mjs` 守护回归。

## 11. Phase 2 完成判据

- `GET /api/platform/instances/:instanceId/investment-state` 在 `routes/platform.ts` 注册。
- 返回紧凑只读摘要:`summary`(计数)+ 前 12 条 holdings/watchlist/plans + 最近 5 条**复盘产物** + 最近 5 条观点(辅助指标)。
- 不复制 `/api/dashboard` 的大聚合对象;不暴露任何投资数据写入端点或 repair action。
- Platform 实例详情在"投资状态摘要"区域异步加载并渲染。
- 404/401 行为有 smoke 守护。
- **无副作用**:GET 请求不得触发 `ensureWorkspace`;workspace 不存在时返回 `workspaceReady: false` + 零值摘要,不创建目录。

**状态(2026-07-16):已完成。**`scripts/platform-investment-state-smoke.mjs` 已扩展为三条断言:
1. 无 workspace 时返回 `workspaceReady: false`,且 stdout 不出现 `workspace.created`。
2. 写入一条 daily plan 后 `recentReviews` 返回真实复盘产物(含 date/summary/generatedAt)。
3. `viewpoints` 字段独立返回观点列表,不与 reviews 混淆。

## 12. Phase 3 完成判据

- Platform 实例详情移除"打开 Dashboard / 返回 Dashboard"链接。
- `registerDashboardRoutes` 不再注册;`renderDashboardPage` 与 `src/admin/dashboard-page.ts` 删除。
- `/dashboard` 改 301 → `/platform`,security-boundary-smoke 的 `/dashboard → 200` 断言同步调整。
- 删除仅被 Dashboard 消费的端点:`/api/dashboard`、`/api/users*`、`/api/portfolio*`、`/api/watchlist*`、`/api/plans*`、`/api/strategies*`、`/api/indicators*`、`/api/acp-backends*`、旧 `/api/reviews*`、`/api/signals/update`、`/api/interval/set`。
- workspace `AGENTS.md` 与 README/CLAUDE.md/docs 同步移除 Dashboard 入口叙述。
- 启动日志不再打印 `数据看板: /dashboard`;`/api/chat` 不再接受 `channel=dashboard`;新 watch-rule 审计 `source.kind` 不再写 `dashboard_api`。

**状态(2026-07-16):已完成,仅保留页面书签重定向。**

已完成:
- `src/routes/dashboard.ts`(734 行)与 `src/admin/dashboard-page.ts`(1631 行)整体删除。
- 仅被 Dashboard 消费的端点全部移除;`security-boundary-smoke.mjs` 断言更新为 `/dashboard → 301`;`route-uniqueness-smoke.mjs` 守护路由清单不回退。
- 启动日志去除"数据看板"行,改为"平台管理"行。
- `/api/chat` `channel` 取值改为 `"weixin-mobile" | "api"`,旧 `dashboard` 值降级为 `api`。
- 新 watch-rule 审计 `source.kind` 从 `dashboard_api` 改为 `platform_api`。

**兼容期只保留无副作用页面跳转**:
- `/dashboard` 301 重定向到 `/platform`。
- `/admin/weixin` 301 重定向到 `/platform#instances`。
- 五个全局 `/api/weixin/*` 读写端点无仓库内消费者，已删除；实例级 Platform API 是唯一管理入口。

破坏性删除由用户在 2026-07-16 会话中明确授权;仓库外消费者证据仍未独立核验。

## 13. Phase 4 完成判据

- legacy `alerts` 表行数盘点、归档、备份记录。
- 删除 `/api/alerts/set|toggle|remove` 与 sandbox 镜像。
- 数据库迁移删 `alerts` 表(走 `db-migration` skill)。
- `invest.dashboard.read` 权限名二选一(删除或 alias)。

**状态(2026-07-16):已完成。**`drop_legacy_alerts_table_v1` 迁移在 `src/db/index.ts` 中落地:

- 迁移前 `COUNT(*)` 探测行数。
- 行数为 0:直接 `DROP TABLE`,写入 `schema_migrations`,不产生归档文件。
- 行数 > 0:`SELECT * FROM alerts` 全量导出到 `${RUNTIME_DATA_ROOT}/archive/alerts-<ISO>.json`,导出行数与表行数一致才继续 DROP;不一致时保留表结构并发出 `WARN`。
- 非空归档与空表 DROP 两条路径由 `scripts/db-legacy-alerts-drop-smoke.mjs` 守护(已加入 verify)。
- schema.ts、project-registry.ts、sandbox.ts 中的 `alerts` 引用同步移除;sandbox snapshot 保留 `alertRules: []` 兼容字段。
- `invest.dashboard.read` 已重命名为 `invest.snapshot.read`,`/api/sandbox/dashboard` 已替换为 `/api/sandbox/snapshot`,`resourceType` 使用 `investment_snapshot`。路由唯一性 smoke 同时断言旧端点不再注册。

## 14. Phase 5 完成判据

- 文档全面更新:`AGENTS.md`、`CLAUDE.md`、`README.md`、`docs/system-overview.md`、`docs/table-ownership.md`、`docs/04-core-workflows.md`、`docs/23-multi-user-sandbox-design.md`、`docs/watch-runtime-phased-implementation.md`。
- Route inventory/唯一性测试守护回归(Phase 1 已交付一半,完整守护待 Phase 5)。

**状态(2026-07-16):已完成。**所有非 archive 当前文档中的正式入口已收敛到 Platform；sandbox 摘要使用中性 snapshot 命名；legacy alerts 与旧 reviews/API 描述已移除。`route-uniqueness-smoke.mjs` 在 verify 中守护旧 Dashboard、全局微信和 sandbox dashboard 端点不会回归。

## 15. 本会话产出汇总

- 新增 `dashboard-endpoint-manifest.md`(本文件)。
- 新增 `scripts/route-uniqueness-smoke.mjs`、`scripts/platform-investment-state-smoke.mjs`、`scripts/db-legacy-alerts-drop-smoke.mjs`。
- `src/admin/weixin-page.ts` 删除。
- `src/server.ts`:移除 weixin-page import、修复 `/admin/weixin` 重定向、注册 `registerWatchRuleRoutes`、添加 `onRoute` 路由收集、去除"数据看板"启动日志、收紧 `/api/chat` channel 枚举。
- `src/routes/dashboard.ts`:Phase 1 删除 8 个重复 watch-rule 路由块;Phase 3 整文件删除。
- `src/admin/dashboard-page.ts`:Phase 3 整文件删除(1631 行)。
- `src/routes/watch-rules.ts`:写入 `source.kind: "platform_api"`(原 `dashboard_api` 已改名)。
- `src/routes/platform.ts`:新增 `GET /api/platform/instances/:instanceId/investment-state` 端点;workspace 缺失时返回 `workspaceReady: false`,不创建目录;`recentReviews` 改用 `dailyPlanBackend` 真实复盘产物;新增独立 `viewpoints` 字段。
- `src/lib/workspace.ts`:新增 `workspaceExists(userId)` 只读检查。
- `src/admin/platform-page.ts`:实例详情增加"投资状态摘要"区域 + JS 加载逻辑 + 表格样式;移除指向 `/dashboard` 的链接;区分"最近复盘产物"和"最近复盘观点";处理 `workspaceReady: false`。
- `src/lib/config.ts`:新增 `runtimeData.archiveDir` 配置。
- `src/routes/sandbox.ts`、`src/platform/project-registry.ts`、`src/db/schema.ts`、`src/db/index.ts`:Phase 4 移除 legacy `alerts` 引用;`drop_legacy_alerts_table_v1` 迁移支持非空归档 + DROP;`archiveLegacyAlerts` 导出 `${archiveDir}/alerts-<ISO>.json`。
- `scripts/security-boundary-smoke.mjs`:断言从 `/dashboard → 200` 改为 `/dashboard → 301`。
- `src/server.ts`:离线模式不启动 push queue worker,且投递函数有二次离线防线;五个无消费者的全局 `/api/weixin/*` 端点删除。
- `scripts/offline-runtime-smoke.mjs`:预置到期 push job 后启动离线 server,验证 job 仍为 pending 且 attempts=0。
- 文档(AGENTS.md / CLAUDE.md / README.md / docs/system-overview.md / docs/README.md / docs/table-ownership.md / docs/04-core-workflows.md / docs/23-multi-user-sandbox-design.md / docs/watch-runtime-phased-implementation.md):Phase 5 同步移除 Dashboard 入口叙述并登记退役事实。
