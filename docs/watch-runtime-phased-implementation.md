# 盘中巡检与定时任务当前契约

本文件只描述当前 watch runtime。历史分阶段方案、未来事件盯盘设想和执行提示见
[`archive/watch-runtime-phased-implementation-pre-consolidation-2026-07-28.md`](./archive/watch-runtime-phased-implementation-pre-consolidation-2026-07-28.md)。

## 当前运行面

Scheduler 中有两个不同职责的任务：

| 任务 | 职责 |
| --- | --- |
| `market-watch` | 定时生成市场观察简报，允许 Agent 做研究和判断 |
| `rule-alert-check` | 服务层确定性读取启用的 `watch_rules`、采样行情、评估条件、记录事件并按推送纪律投递 |

两者不能合并。`market-watch` 不是确定性规则执行器，`rule-alert-check` 也不负责开放式新闻研究。

## 确定性规则执行

`src/scheduler/alert-check.ts` 的 `runAlertCheck` 只执行当前启用的 stage-2 `watch_rules`。旧 `alerts` 表不再作为运行输入。

每次 scheduler tick：

1. 读取当前 scope 下启用的规则实例。
2. 获取执行时点的当前或最新可用行情事实。
3. 由 `src/services/watch-rules.ts` 按规则参数确定性求值。
4. 记录运行与事件状态。
5. 按 priority、dedupe 和 cooldown 语义决定是否生成推送。

当前语义是“调度采样时是否满足条件”，不是“盘中曾经触达”、逐笔监控或收盘确认。除非明确重设数据和调度契约，不得把文案解释成这些更强语义。

## 规则所有权与边界

- 服务层拥有规则 schema、持久化、调度、行情采样、求值、审计、去重、冷却和推送。
- Workspace Skill 负责理解用户意图、解释规则含义、收集参数，并在需要时发起确认后的写入。
- Agent 不应在对话进程中常驻轮询，也不应自行承诺规则一定覆盖每个盘中瞬间。
- 行情缺失或过期必须显式记录，不能用推测值触发规则。
- 创建或修改规则必须服从当前 sandbox/MCP 的 scope 与确认契约。

## 当前接口

规则目录、规则实例和兼容 HTTP 路由由以下实现定义：

- `src/services/watch-rules.ts`
- `src/routes/watch-rules.ts`
- `src/scheduler/alert-check.ts`
- `src/scheduler/index.ts`
- `src/mcp/service-tools-core.ts`

具体字段应从这些实现及 MCP schema 读取，不在此复制一份可能漂移的工具清单。

## 当前限制

- 新闻、公告、政策或主观事件类盯盘没有被纳入确定性 `watch_rules` 执行器。
- 调度频率决定可观察粒度；当前系统不是 tick 级行情系统。
- 规则运行依赖已接受的数据源降级策略，数据不可用时必须暴露缺口。

## 验证

规则运行变更至少执行：

```bash
npm run smoke:stage2-watch-rules
npm run verify
```

若脚本名变化，以 `package.json` 为准。生产 scheduler 与推送排障使用 `.codex/skills/scheduler-push-debug`。
