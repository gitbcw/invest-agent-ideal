# 开发 Agent 上下文任务回放（2026-07-28）

本记录验证 `docs/development-task-map.md` 是否能让开发 Agent 从真实近期任务进入最小上下文。它是完成后的证据，不是默认阅读材料。

| 已完成任务 | 实际改动证据 | 任务地图路径 | 最小读取集 | 条件展开 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `f0011d2` safe SVG 样式修复 | `src/services/svg-sanitizer.ts`、`tests/svg-sanitizer.test.ts` | Local code or test | 受影响实现、测试、`package.json` | 无 | 无需架构、协议或运维文档即可定位和验证，路径充分。 |
| `4580cd6` 确认式组合更新 | MCP 注册/核心、workspace backend、组合测试与 MCP smoke | Service API / MCP / Platform | `service-api-change`、受影响代码/测试、`service-tools-mcp.md` | 因确认、scope 与审计读取 sandbox 设计 | 需要服务契约与隔离边界，但不需要全量运行时或 Portal 文档。 |
| `c97b176` Portal 文件留存治理 | Portal connector、服务、scheduler、SQLite schema、留存测试与协议 | Portal connector or protocol | `service-api-change`、`user-portal.md`、受影响代码/测试 | 因 schema/持久化边界叠加 SQLite / persistence；只读受影响协议章节 | 这是跨通道任务；主通道加第二通道即可，不需要预读全部资料。 |
| `b43402e` 核心资源并发写保护 | MCP/HTTP/Platform 写入口、跨进程锁、确认测试、Portal 并发限制 | Service API / MCP / Platform | `service-api-change`、`service-tools-mcp.md`、受影响代码/测试 | 因 scope/audit 和 Portal adapter 读取 sandbox 设计、受影响协议章节 | 需要局部跨边界资料；发布脚本属于独立发布子任务，不应因锁实现而默认加载。 |
| `3f0534e` T-194 发布/回退验收交接 | `docs/t194-maintenance-window-handoff.md` | Production release / rollback | `volcano-ops`、当前 T-194 handoff | 只有显式运行时数据恢复时才展开迁移材料 | 发布任务可从运维 Skill 和当前交接开始，不需要服务 API、数据库或产品方法文档。 |

## 结果

- 五个真实任务都能先从一个主通道进入，不需要恢复原先的四份入口预读。
- 两个跨边界任务只在实际触及的边界增加第二通道；因此短地图补充了“主通道优先、按边界叠加”的规则。
- 局部修复和发布/回退的上下文差异最大，证明统一入口预读会同时拖慢低风险和高风险任务。
- 本回放未验证 Workspace 产品 Agent 或 ACP 长会话上下文；它们不属于本轮开发 Agent 治理范围。
