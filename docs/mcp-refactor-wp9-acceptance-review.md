# MCP 注册与 Agent 工具架构重构 — WP9 验收记录

> 状态：Accepted。WP0-WP9 全部完成。
>
> 本文件是重构计划 WP9 的独立验收记录，对照计划逐条验收各 WP 的产物、验证结果和遗留事项。

## 一、全链验证结果

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 完整测试套件 | `npm run verify` | ✅ 269 tests pass + check:agent-context + build + 7 boundary tests |
| typecheck | `npm run typecheck` | ✅ EXIT 0 |
| build | `npm run build` | ✅ EXIT 0 |
| capability 边界 | `npm run capability:market-data:test` | ✅ 8/8 |
| stage1 scheduler | `npm run smoke:stage1-scheduler` | ✅ 通过 |
| stage2 watch-rules | `npm run smoke:stage2-watch-rules` | ✅ 通过 (price_cross + cooldown) |
| mcp-service-tools | `npm run smoke:mcp-service-tools` | ✅ 通过 (43 tools) |
| db-legacy-migration | `npm run smoke:db-legacy-migration` | ✅ 通过 |
| security-boundary | `npm run smoke:security-boundary` | ✅ 通过 |

新增的专项测试（重构期间累计）：
- `acp-mcp-registry.test.ts` 12 — 注册模型/校验/manifest/sessionKind
- `acp-mcp-external.test.ts` 12 — 外部 MCP 接入/安全边界/fail-closed/动态发现
- `acp-session-key.test.ts` 7 — sessionKey 权限泄漏修复回归门
- `scheduled-orchestration-flag.test.ts` 11 — 预编排 flag/新路径行为契约
- `rule-price-facts.test.ts` 16 — 窄事实接口映射/触发/兼容
- `watch-rules-deprecation.test.ts` 3 — 退役规则验证
- `market-watch-snapshot-freeze.test.ts` 3 — snapshot 冻结
- `mcp-market-data-tool-probe.mjs` — live probe (动态发现 15 工具 + 真实行情)

## 二、逐 WP 验收

### WP0：决策基线 ✅
- 产物：调用方矩阵（MCP/scheduled-review-snapshot/规则/旧市场兼容面）、冲突项状态表、测试基线
- 验证：typecheck/build/capability:market-data 通过

### WP1：MCP 注册表与会话 Manifest ✅
- 产物：`mcp-registry.ts` + `mcp-session-manifest.ts`，`buildInvestAgentMcpServers` 改薄 wrapper
- 验证：核心回归 5/5 零修改通过 + 12 个新测试
- 关键：默认行为完全不变（branch-by-abstraction）

### WP2：market-data-tool 外部 MCP 接入 ✅
- 产物：`external-mcp-registrations.ts` + live probe，默认关闭
- 验证：live probe 动态发现 15 工具 + 真实行情（source=tencent）；12 个新测试；安全边界（external 不含 DB_PATH）
- 关键：动态发现证明（无逐工具映射）；ACP 端到端 live probe 两个 server 都装配

### WP3：统一会话装配 ✅
- 产物：`computeAllowlistFingerprint` + sessionKey 纳入 allowlist 指纹
- 验证：7 个新测试；ACP 端到端 codex-acp 成功驱动两个 MCP server
- 关键修复：会话复用权限泄漏缺陷（sessionKey 不含 allowlist 导致全量 session 被只读阶段复用）

### WP4：移除研究预编排 ✅
- 产物：market-watch/daily/weekly/monthly 预编排 flag 化（`SCHEDULED_*_LEGACY_ORCH`，默认新路径）
- 验证：11 个 flag 测试；flag=true 时旧编排测试仍通过（回切能力）
- 边界：weekly/monthly 的 reviews.save 完成校验另立任务

### WP5：窄价格事实接口 ✅
- 产物：`rule-price-facts.ts`（`getRulePrices` + `RulePriceFact`），price_cross 迁移
- 验证：16 个测试；tick 级批量预取；facts 结构兼容；flag 回切
- 边界：只迁移 price_cross；cooldown/dedupe/投递零触碰

### WP6：非价格规则分类与退役决策 ✅
- 产物：决策清单 + 用户决策（8 类规则退役，price_cross 保留）
- 证据：生产 alert_rules/alert_events 均 0 行，退役无存量负担

### WP7：snapshot 冻结 ✅
- 产物：`MARKET_WATCH_SNAPSHOT_FREEZE` 默认冻结；历史 46 行保留；读取入口 deprecated
- 验证：3 个冻结测试；旧路径矛盾检测在冻结时优雅跳过

### WP8：旧兼容面退役 ✅
- 产物：8 类 deprecated 规则求值残留清理（净删 994 行）
- 保留：indicatorCapability（review.ts 在用）、service market.* 工具（ACP 消费+不可替代）、sandbox HTTP 路由（无外部反证不删）、Platform telemetry（UI 消费）
- 验证：capability 8/8 + ACP 29/29 + stage2 smoke + onboarding

### WP9：文档收敛与独立验收 ✅（本文件）
- capability-plane 系列 5 文件移 archive + superseded 横幅
- system-overview / service-tools-mcp / refactor-plan / discussion-notes 状态更新
- README 索引补全

## 三、最终能力目录

### MCP 控制面（WP1）
- 配置型注册表 `mcp-registry.ts`：service-scoped（唯一 service 写/状态面）+ external-readonly
- 会话 manifest `mcp-session-manifest.ts`：按 backend/scope/taskType 装配，脱敏摘要

### ACP 研究面（WP2/WP3）
- `invest-agent-service-tools`（service MCP）：43 个工具，含 market.snapshot 用户状态聚合
- `market-data-tool`（外部只读 MCP，默认关闭）：15 个工具，动态发现
- sessionKey 含 allowlist 指纹（WP3 权限隔离修复）

### Scheduler 运行面（WP4）
- 只触发和交付，不预编排（`SCHEDULED_*_LEGACY_ORCH` flag 默认关闭）
- market-watch 新路径：ACP 自由选数，NO_PUSH → null（无兜底）
- daily-review：reviews.save 回读四元组完成条件保留

### 规则事实面（WP5/WP6/WP7/WP8）
- price_cross：唯一活跃规则，`getRulePrices` 窄事实接口（tick 级批量）
- 8 类非价格规则：退役（求值代码已删，catalog 不含，禁止新建）
- snapshot：写入冻结，历史保留，读取 deprecated

### 保留兼容层（WP8 审计结论）
- sandbox market HTTP 路由（10 个）：零内部消费者，无外部反证，保留
- marketDataReadCapability：过渡兼容层，多个 service 路径在用
- Platform source-quality/telemetry：真实 UI 消费

## 四、遗留事项与后续任务

1. **weekly/monthly reviews.save 完成校验**（WP4 未完成项）：当前完成条件是 writeWorkspaceReview，计划要求与 daily 对齐（reviews.save 回读）。另立任务。
2. **snapshot 表物理删除**：需显式生产授权（备份 + 观察窗口 + 消费者清零确认）。移交运维/DB 负责人。
3. **market-data-tool 生产启用**：当前默认关闭（`INVEST_AGENT_MCP_EXTERNAL_ENABLED`）。启用前需评估 codex-acp 生产环境 spawn 外部 stdio MCP 的稳定性。
4. **indicator-based screening 外部工具对接**：WP6 退役的 8 类规则未来通过外部量化选股/筛选工具实现，到点调接口判断。需在该工具开接口并对接。

## 五、禁止重新假设的事项

- ACP 数据来源不再仅限 service MCP；外部只读 MCP 可整服务器注册（WP2/WP3）
- price_cross 是唯一活跃 watch rule；8 类非价格规则的求值代码已删除（WP6/WP8）
- sessionKey 含 allowlist 指纹，同 conversation 不同 allowlist 保证独立 session（WP3）
- snapshot 写入冻结，新代码不应依赖实时 snapshot（WP7）
- scheduler 新路径不预编排，flag 默认关闭（WP4）
