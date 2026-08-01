# T-243 投研助手 MCP/Skills 挂载管理能力标准化 — 方案建议

- 任务：T-243（投研助手 MCP/Skills 挂载管理能力标准化）
- 项目：P-17 投研助手
- 日期：2026-08-01
- 状态：**已选定方案 B（声明式注册 + 控制面）**，2026-08-01 用户确认。进入实施，executor 转 hybrid。按三期推进：Phase 1 通水 → Phase 2 控制面+门禁 → Phase 3 可观测增强+真实验收。
- worktree：`invest-agent-ideal-mcp-mount` / 分支 `feat/mcp-mount-standardization`

## 1. 任务契约回顾

动机：接入太手工（数据源、文件解析等各接各的）。

范围 = 四项能力：

1. 统一注册与配置
2. 启用 / 停用管理
3. 运行状态可见
4. 接入质量门禁

路径：调研后拿方案（2-3 个，含开发量对比，用户选定）→ 独立先行，机制先建，后续接入（含 T-235 文件解析）走新机制。

验收：方案选定 + 用真实工具按新机制完成挂载验证四项能力 + 标准化接入文档。首版分期由方案建议。

> 本文是"方案选定"环节的输入。选定后进入实施，实施转 hybrid。

## 2. 现状摘要（基于本仓库 2026-08-01 实测）

### 2.1 已有资产（可直接复用，不是从零）

| 能力域 | 已有 | 位置 |
|---|---|---|
| 注册中心 | `McpRegistry` 进程内单例 + `validateRegistration` 静态校验（id 格式 / trustClass 一致性 / 模板 token / 安全边界），扎实 | `src/acp/mcp-registry.ts` |
| 声明式注册 builder | 每个 MCP server 一个 builder + `requiredEnvRefs` + `sessionKinds` + `versionPolicy` | `src/acp/external-mcp-registrations.ts` |
| 装配链路 | `resolveSessionMcpServers`：按 backend/sessionKind 过滤 + HTTP 能力 gating + observer 改写 | `src/acp/mcp-session-manifest.ts` |
| 冲突探针 | 会话创建前 initialize→tools/list，跨 server 同名工具 fail-closed | `src/acp/mcp-tool-conflict-probe.ts` |
| 观测采集 | observer 透明中继外部 HTTP MCP，记 server/tool/status/elapsed/errorClass，**绝不记 body**；含 per-turn 预算门禁 | `src/services/external-mcp-observer.ts` |
| 观测落库 | SQLite `external_mcp_tool_calls` 表，带 runId 关联 ACP trace，已建三个索引 | `src/db/schema.ts:343` |
| Platform UI | T-196 已落地模块化结构（owner 5 视图 / partner 4 视图） | `src/admin/platform-ui/` |

### 2.2 四项能力的现状缺口（实测确认）

| 能力 | 现状 | 缺口 |
|---|---|---|
| ① 统一注册 | 外部 server 声明式 builder，但 **activation 仍是 `switch-case` 加分支**（`external-mcp-registrations.ts:81-94`，未知 id 默认 fail-closed）；service-tools 内部 ~28 个工具**硬编码**在入口文件，无注册表抽象；**无声明式配置文件**（无 server.json / yaml，TS 代码即真相）；Skills 完全由 workspace 文件承载，**服务不感知** | 声明式配置文件、activation 去硬编码、内部工具与 Skills 的统一管理 |
| ② 启用/停用 | `setEnabled(id, bool)` 方法存在，但 **src 里生产零调用方**（唯一调用是构造时强制 `true`，`mcp-registry.ts:364`）；实际启用靠 env 开关 + 重启；**无运行时开关 API**；无 per-tool flag（仅会话级 allowlist） | 运行时启停 API、运行时重读、per-tool（差异化点） |
| ③ 运行状态可见 | observer 采集 + 落库扎实，但 `external_mcp_tool_calls` **只写不读**（实测：src 里只有 insert，零 select）；**无聚合 API、无任何 UI 展示**；`platform.ts:1545` 的 source-quality health 已硬编码 `"retired"`（明示该视图不覆盖外部 MCP，且未接 observer 数据） | 聚合 read API、Platform UI 的 MCP 工具状态视图 |
| ④ 接入质量门禁 | 静态校验 + 冲突探针扎实；有 live probe 脚本（opt-in）；`versionPolicy` 只记录不执行；**无"新接入标准冒烟契约"**、无 catalog 漂移检测、无接入后健康基线 | 标准化冒烟门、版本/漂移检测、接入后健康基线 |

**一句话**：底座（registry / observer / probe）已经很扎实，缺的是**把"只写不读"接通成可见、把 switch-case 沉淀成声明式、把散落的校验收敛成接入门禁**。不是推倒重来，是把现有资产接通 + 补控制面。

### 2.3 外部实践关键借鉴（精炼，详见调研）

- **注册**：MCP 官方 registry 用声明式 `server.json`（Identity/Capabilities/Location/Configuration 四类字段）；ToolRegistry（arXiv 2507.10593）给统一 Tool 描述符 + namespace + `register_from_mcp`。
- **启停**：ToolRegistry 的 `disable(name, reason)` —— 元数据保留但从 `list_tools()` 移除（对 LLM 隐藏）；Roo Code 教训：`disabled:true` 但进程仍跑是坑，disable 必须真生效。
- **可观测**：OpenTelemetry GenAI semconv（v1.41+）已是事实标准，专有 `mcp.method.name`/`mcp.session.id`/`gen_ai.tool.*` 属性；指标基线 = `mcp.{client,server}.operation.duration` + 成功率 + token usage。**不要自研 schema**。
- **门禁**：业界"MCP 五道门"（smoke → conformance → scenario → load → pentest）；**catalog digest 漂移检测**（跨 release 比对工具集哈希）是低成本高收益的差异化点，正好补业界网关普遍缺失的同名/静默变更预警。
- **不照搬**：微软 mcp-gateway 的 K8s Deployment Manager（我们不跑 K8s）；Pact CDC（MCP 契约是 schema 非 HTTP，五道门更对路）。

## 3. 三个方案

三个方案是**范围 / 侵入性 / 开发量**的递进，不是互斥设计——B 是 A 的超集，C 是 B 的超集。选定哪个决定"做到哪一层"。

### 方案 A：最小可见（先通水）

**定位**：不重构注册层，只把现有资产接通成"可用 + 可见"，补最小门禁。最快交付，侵入最低。

**四项能力覆盖**：
- ① 注册：保持 TS builder 为运行时真相（不动 fail-closed 校验链路），**补一份声明式 `docs/mcp-servers-catalog.md`（或 `mcp-servers.json`）作为人类可读注册清单 + 生成 `.env.example` 模板的来源**。activation switch-case 不动。
- ② 启停：加 admin API（`POST /api/admin/mcp/:serverId/enable|disable`）直接调已有的 `setEnabled`；registry 支持运行时重读（懒单例 → 可刷新）。env 仍是基线，API 做运行时覆盖。
- ③ 状态：给 observer 表写聚合 read API（`GET /api/admin/mcp/status`，按 server+tool 维度：调用量 / 成功率 / p95 延迟 / 最近错误）；在 Platform UI owner 侧把 **retired 的 source-quality 视图切换为"MCP 工具状态"视图**（复用现有视图位置，最小 UI 改动）。
- ④ 门禁：把现有静态校验 + 冲突探针提炼成**接入 checklist + `npm run mcp:check` 脚本**（注册校验 / activation / sessionKind / 安全边界 / 冲突，离线可跑，不依赖 live endpoint），新接入必跑。

**开发量**：约 8-12 人天。
**优点**：侵入最低、风险最小、最快让"只写不读"变可见；不引入新依赖；不动稳定链路。
**缺点**：不解决 activation switch-case（每加一个 server 仍要改代码）；service-tools 内部工具和 Skills 仍不在统一管理内；"四项能力"做得不够彻底，验收时可能觉得"注册"这项还是半成品。

### 方案 B：声明式注册 + 控制面（推荐）

**定位**：对齐业界"控制面 / 数据面"分离，把注册层沉淀为声明式，建一个进程内 MCP 控制面模块。彻底解决 switch-case 和只写不读。

**四项能力覆盖**：
- ① 注册：**声明式 `mcp-servers.config.ts`（或 yaml）作为唯一真相**；每项自带 `activateIf`（声明式激活条件，如 `{ envEnabled: "INVEST_AGENT_MCP_MARKET_DATA_ENABLED", requiredEnvRefs: [...] }`），**消灭 activation switch-case**；registry 启动时 load + 支持热重载。TS builder 退化为"从 config 生成 registration"。
- ② 启停：运行时控制面 API + **DB 持久化覆盖**（新增 `mcp_server_overrides` 表，per-server enable 覆盖基线）；面向未来 per-tenant/per-tool。复用 ToolRegistry 的 `disable(name, reason)` 语义——元数据保留但从装配清单移除。
- ③ 状态：observer 聚合 read API + Platform UI 视图（同 A）；**额外让 observer emit OTel GenAI semconv**（`mcp.*` + `gen_ai.tool.*` 属性），后端可接 Langfuse 自建或自研 dashboard。
- ④ 门禁：**Gate1 smoke（initialize + tools/list 可达）+ Gate2 conformance（对 2026-07-28 spec 的 schema 校验：inputSchema/outputSchema JSON Schema 2020-12 合法性 + required 字段存在性）+ catalog digest 漂移检测**，收敛为 `npm run mcp:gate`；接入后健康基线（失败率阈值告警，接 observer 数据）。

**开发量**：约 18-25 人天（含 OTel 引入）。
**优点**：彻底解决四项能力；声明式注册让"加一个 server"变成改 config 不改代码；OTel 对齐业界标准，未来可观测扩展性好；catalog digest 是差异化点。
**缺点**：要改 activation 链路（有回归风险，需充分测试覆盖）；引入 OTel SDK 有学习成本；范围比 A 大。

### 方案 C：统一工具控制面（最大）

**定位**：在 B 基础上，把 service-tools 内部 ~28 个硬编码工具**也纳入统一 registry**（借鉴 ToolRegistry 的 disable/namespace），一并解决"两份工具清单漂移"（`tool-manifest.ts` vs 实际注册）。

**额外覆盖**（在 B 之上）：
- service-tools 工具从硬编码迁移到统一 registry 注册，统一 disable/enable/状态/门禁。
- `tool-manifest.ts` 与实际注册工具的一致性校验（消除漂移）。
- 为未来 Skills 运行时管理预留接口（Skills 当前是 workspace 文件，本方案不强行纳入，但 registry 抽象留扩展位）。

**开发量**：约 30-40 人天。
**优点**：最彻底，所有工具（外部 MCP + 内部 service-tools）统一治理；解决已知漂移风险。
**缺点**：侵入性高，触及稳定的 `service-tools-core` 分发逻辑（生产在跑）；service-tools 不常改，收益边际递减；风险/收益比不如 B。**任务契约验收（"用真实工具按新机制挂载验证"）并不要求纳入 service-tools**。

## 4. 推荐 + 分期建议

**推荐方案 B（声明式注册 + 控制面）**。理由：
- A 太保守——activation switch-case 和"只写不读"的根本问题没解决透，Skills/内部工具也没管，验收"四项能力"会觉得"注册"这项是半成品。
- C 太大——把稳定的 service-tools 卷进来风险高，而契约验收不要求纳入内部工具，收益边际递减。
- B 正好：声明式注册消灭 switch-case、控制面 API 解决运行时启停、OTel + Platform UI 视图解决状态可见、五道门收敛质量门禁。且 B 是 A 的自然超集，A 的 API/UI B 都有。

**方案 B 分三期（建议）**：

| 期 | 范围 | 人天 | 验收点 |
|---|---|---|---|
| Phase 1 通水 | 声明式 config + activation 改造 + observer 聚合 read API + Platform UI MCP 工具状态视图（retired 视图切换） | 8-10 | observer 数据在 UI 可见；新 server 接入改 config 不改代码 |
| Phase 2 控制面 + 门禁 | 运行时启停 API + DB 持久化覆盖 + `npm run mcp:gate`（smoke + conformance + digest 漂移） | 6-8 | 运行时启停生效；新接入跑门禁通过 |
| Phase 3 可观测增强 + 文档 + 真实验收 | OTel emit + 标准化接入文档 + 用真实工具（market-data-tool 或 T-235 文件解析）按新机制完成挂载验证四项能力 | 4-7 | 契约验收：真实工具按新机制挂载走通 + 接入文档交付 |

> Phase 3 的"真实工具挂载验证"可与 T-235（文件解析）联动——T-235 挂载实施本就 depends_on T-243，正好用 T-235 做新机制的首个真实接入样本。

## 5. 待用户决策

请选定方案（A / B / C），或对推荐方案 B 的分期提出调整。选定后进入实施（executor 转 hybrid），按选定方案的分期推进。
