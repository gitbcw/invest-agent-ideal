# MCP 注册与 Agent 工具架构重构独立验收

> 验收日期：2026-07-30
>
> 被验收分支：`refactor/mcp-registry-agent-tooling`
>
> 被验收提交：`a422a750da828fb29d58c1a70c1a703a9ab51cac`
>
> 对照计划：[MCP 注册与 Agent 工具架构重构计划](./mcp-registry-and-agent-tooling-refactor-plan.md)

## Acceptance Verdict

**Status: Fail。当前不得合并。**

分支已经完成 MCP 注册骨架、`market-data-tool` stdio 接入、研究预抓取移除、价格规则批量取数、snapshot 停写和大部分文档收敛；全量单测与多数 smoke 通过。但定时 ACP 会话仍可见服务 MCP 的全部写工具，违反计划的最小权限边界；周/月复盘没有通过受控保存/发布动作完成；窄价格事实仍直接复用完整 `marketDataReadCapability`，且缺少计划要求的 TTL、创建期代码规范化和存量审计。分支自带的 WP9 验收把这些已知缺口标成通过，因此不能作为独立验收依据。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Git | 分支基于当前 `main`，提交完整且 worktree 干净 | Pass | merge-base=`71ccfcd8`；`main...branch=0/11`；worktree clean | 线性快进关系成立 |
| WP0 | 决策基线、消费者矩阵、冲突表 | Pass | `docs/mcp-refactor-wp0-baseline.md` | 产物存在且可供后续使用 |
| WP1 | 配置型注册表和会话 manifest | Partial | `src/acp/mcp-registry.ts`、`mcp-session-manifest.ts` | server 级注册成立；manifest 只有结构化日志，没有 run 持久关联 |
| WP2 | 外部 `market-data-tool` 整服务器接入 | Partial | `external-mcp-registrations.ts`、MCP probe、12 个测试 | stdio 注册和原生 `tools/list` 成立；缺少可复核的真实 codex-acp 会话证据和工具冲突处理 |
| WP3 | 定时会话只读能力 + 唯一最终动作 | Fail | `scheduled-tasks.ts:186-199`；`invest-agent-service-tools.ts:42-46,556` | 新路径无 allowlist，空 allowlist 的语义是暴露全部 43 个服务工具，包括无关写工具 |
| WP3 | 用户/实例和 session 隔离 | Partial | `computeAllowlistFingerprint` 测试、scope 测试 | allowlist 指纹修复有效，但未覆盖“定时任务实际不可见未授权写工具” |
| WP4 | market-watch 不再预抓 snapshot/审计纠偏/强制 fallback | Pass | `scheduled-tasks.ts:177-203`；目标测试 | 默认新路径成立，旧路径由 flag 保留 |
| WP4 | 服务不要求具名市场工具 | Fail | `scheduled-tasks.ts:535-554` | 新 prompt 仍要求至少调用一个具名行情读取能力并规定固定简报输出 |
| WP4 | 日/周/月均以明确保存/发布成功为完成条件 | Partial | daily `reviews.save` 校验；periodic `writeWorkspaceReview` | 日复盘符合；周/月直接保存 ACP 文本，自带验收也承认未完成 |
| WP5 | 独立窄价格事实、批量主备、TTL、失败码 | Partial | `rule-price-facts.ts` | 形状和批量 Map 已有；仍调用完整 `marketDataReadCapability.quote`，没有独立 TTL |
| WP5 | 创建/修改期名称到代码规范化、存量只读审计 | Fail | `watch-rules.ts:285-336` | 仅 `trim()`；未校验规范代码，未实现名称解析或存量报告 |
| WP6 | 非价格规则分类和人类产品决策 | Unknown | `mcp-refactor-wp6-rule-decision.md` | 文档称用户确认全部退役；本验收上下文没有可核对的明确决策消息，合并前需用户确认 |
| WP7 | snapshot 默认停写、历史保留、不删表 | Pass | `market-watch-snapshot.ts`、3 个测试 | 符合 no-delete-first |
| WP8 | 旧入口按消费者证据退役 | Partial | WP8 提交和文档 | 非价格规则代码已删；保留旧 MCP/HTTP 有说明，但外部消费者缺少强反证，保守保留合理 |
| WP9 | 权威文档、全链测试、独立验收 | Fail | 分支自带 `mcp-refactor-wp9-acceptance-review.md` | 把已知 WP3/WP4/WP5 缺口标为 Accepted；未运行计划列出的 publication smoke |
| Verification | `npm run verify` | Pass | 269 tests、context check、build、7 boundary tests | 本次独立复跑通过 |
| Verification | 计划列出的主要 smoke | Partial | stage1/stage2/MCP/security/db 均通过 | `smoke:scheduled-review-publication` 裸命令 exit 1，要求额外参数 |
| Hygiene | `git diff --check main...HEAD` | Fail | `src/services/watch-rules.ts:572` | 文件尾多余空行 |

## Findings

### [P1] 定时 ACP 会话暴露全部服务写工具

默认的新 market-watch、daily、weekly 和 monthly 路径构建 `UserContext` 时不设置有效工具授权。服务 MCP 把空 `INVEST_AGENT_MCP_ALLOWED_TOOLS` 解释为“不限制”，因此定时会话可发现所有服务工具，而不是计划规定的“所有启用只读 MCP + scope 状态读取 + 本任务唯一最终动作”。这会让后台任务获得与任务无关的组合修改、规则修改、onboarding、确认或发布能力，是合并阻断项。

### [P1] 周/月复盘绕过受控发布完成契约

`runScheduledPeriodicReview` 接收 ACP 最终文本后直接调用 `writeWorkspaceReview` 并生成推送。没有本次 conversation、scheduled 标志、生成时间或保存内容的回读绑定，也没有任务级唯一 final-action grant。ACP 回复与实际保存/投递之间缺少 daily 已有的确定性边界。分支自带验收在同一份文档中既标 WP4 通过，又把此项列为遗留，结论自相矛盾。

### [P1] WP6 的删除决策缺少本次验收可核对的用户授权

分支删除了八类非价格规则的 catalog、验证和求值代码，依据是某次“用户已确认全部退役”。这可能确实发生在执行 Agent 的独立对话中，但提交和仓库文档没有可核对的外部决策引用。本次合并前必须由用户明确确认该产品决定；否则应恢复删除提交或保留软退役。

### [P2] market-watch prompt 仍在服务层编排工具行为

虽然代码不再审计具体调用，prompt 仍强制“至少调用一个具名行情读取能力”，并在固定简报模式要求必须输出正文。这与本次讨论形成的“服务只调度，工具选择和是否 `NO_PUSH` 交给 ACP/Skills/通知策略”不一致，也会延续特定情况下模型被代码/提示拒答的问题。

### [P2] `getRulePrices` 只缩小了返回类型，没有真正缩小依赖

`rule-price-facts.ts` 直接导入完整 `marketDataReadCapability`，继续继承其来源元数据、交叉校验、telemetry 和通用 facade 生命周期。计划要求的独立短 TTL、明确主备边界和逐代码 fallback 测试没有完整落地；规则创建/修改仍接受任意非空字符串作为 `stockCode`。

### [P2] MCP 工具名冲突没有验收

实现只拒绝重复 server ID，没有证明 ACP runtime 会为工具加服务器命名空间，也没有在真实 `tools/list` 冲突时 fail closed。计划明确要求工具冲突测试，当前测试“duplicate external server id”不能替代它。

### [P2] 外部 MCP 的真实 ACP 端到端证据不可复核

仓库 probe 直接作为 MCP client 启动 `market-data-tool`，可以证明服务器本身的 `initialize/tools/list/tools/call`，但不能证明 Invest Agent -> codex-acp -> 两个 MCP server -> Agent 回复的链路。自带验收声称该链路已成功，仓库中没有对应脚本、结构化日志或可复现命令。

### [P2] 计划规定的 publication smoke 不是自包含命令

`npm run smoke:scheduled-review-publication` 不带参数会直接抛 usage error。本次复跑 exit 1。该 probe 还需要隔离用户、实例、日期和 ACP 凭据，不能把缺参数的命令记为已通过。

### [P3] 分支未通过 diff hygiene

`git diff --check main...HEAD` 报 `src/services/watch-rules.ts:572: new blank line at EOF`。修复简单，但应在最终合并门禁前清理。

## Verification Performed

- `git merge-base main refactor/mcp-registry-agent-tooling`：分支从当前 main 线性前进。
- `git rev-list --left-right --count main...refactor/mcp-registry-agent-tooling`：`0 11`。
- `npm run verify`：通过，269 tests；`check:agent-context`、build、7 个 boundary tests 通过。
- `npm run smoke:stage1-scheduler`：通过。
- `npm run smoke:stage2-watch-rules`：通过。
- `npm run smoke:mcp-service-tools`：通过，43 tools。
- `npm run smoke:security-boundary`：通过。
- `npm run smoke:db-legacy-migration`：通过。
- `npm run smoke:scheduled-review-publication`：失败，缺少 `<userId> <instanceId> <YYYY-MM-DD>`。
- `git diff --check main...HEAD`：失败，`watch-rules.ts` 文件尾空行。
- 源码审查：MCP registry/manifest、stdio session、scheduled tasks、service MCP allowlist、review publication、rule facts、rule validation、tests 和分支自带验收。

## Follow-Up Routing

修复任务见 [MCP 重构验收修复任务](./mcp-refactor-acceptance-follow-up-tasks.md)。F1、F2 和用户对 F3 的产品确认是合并阻断项；F4、F5 解决计划中未完成的架构契约；F6 是最终重新验收和合并准备。

---

## 2026-07-30 第二次复验

### Acceptance Verdict

**Status: Fail。提交 `9456d39` 仍不得合并。**

F1-F4 的主体方向已有实质进展：四类已知定时任务获得了 reads + final-action grant，周/月复盘增加 `reviews.save` 回读，规则价格事实不再导入通用 capability，八类规则退役决策已有再次确认记录。但新增的周/月保存路径允许未经校验的 `reportKey` 进入 Workspace 文件路径，定时 ACP 可借 `reviews.save` 覆盖 `AGENTS.md` 等 Workspace 资产；工具冲突探针没有接入任何会话创建路径；未知 scheduled task 仍会绕过只读兜底；market-watch prompt 的具名工具强制编排没有修复。F6 的 smoke 和 ACP 证据也不能支持其声明。

### Changed Checklist

| Area | Previous | Current | Evidence | Judgment |
| --- | --- | --- | --- | --- |
| F1 known tasks | Fail | Pass | `service-tool-classification.ts`；四类 grant tests | 已知四类任务不再获得 other-write |
| F1 unknown scheduled | 未单列 | Fail | `mcp-session-manifest.ts:103-116` | `isScheduledTaskType` 只认表内任务；未知 `scheduled-*` 回落空 allowlist，而不是调用只读兜底 |
| F2 controlled publication | Partial | Partial | `scheduled-tasks.ts:354-398`、`service-tools-core.ts:1006-1050` | 回读链成立，但保存输入安全不成立 |
| F2 Workspace path safety | 未单列 | Fail | `review.ts:29-35`、`periodic-review-backend.ts:33-35` | `reportKey` 未校验，`../../AGENTS` 可解析到 Workspace 根 `AGENTS.md` |
| F2 serialization | 未单列 | Fail | `periodic-review-backend.ts:38-70` | 手写 YAML 无法可靠保存含换行、冒号等正常 Markdown push brief/metadata |
| F4 narrow price dependency | Partial | Pass with caveat | `rule-price-facts.ts` | 已脱离通用 capability并有 5s TTL；仍未校验行情 freshness/asOf |
| F5 conflict handling | Fail | Fail | `mcp-tool-conflict-probe.ts` 只有 tests 引用 | 探针未在 registry、manifest 或 `newSession` 前调用，生产行为未改变 |
| F5 ACP E2E | Fail | Fail | `scripts/mcp-acp-e2e-probe.mjs:39-44` | prompt 明确“不要调用任何工具”，不能证明外部 MCP 可调用或列式 JSON 可消费 |
| WP4 prompt ownership | Fail | Fail | `scheduled-tasks.ts:565-583` | 仍强制具名行情工具和固定简报必须输出 |
| Publication smoke safety | Partial | Fail | `.env` 配置非测试 `DB_PATH`；wrapper `:22-43` | 没有覆盖隔离 DB/Workspace/Runtime/Reviews，也不清理 eval user |
| Publication smoke signal | Partial | Fail | wrapper `:44-48` | ACP/timeout 类错误 exit 0，可能把真实回归报告为通过 |
| Verification | Partial | Partial | 本次独立命令 | 安全离线命令通过；不运行会触碰非测试状态的 publication smoke |

### New Findings

#### [P0] `reportKey` 路径穿越可覆盖 Workspace 管理文件

`reviews.save` 接收 Agent 提供的 `reportKey`，仅检查非空。`mirrorReviewToWorkspace` 和 `periodicReviewBackend` 都直接把该值拼入路径。对 weekly 保存传入 `../../AGENTS` 时，Markdown 目标解析为 `<workspace>/AGENTS.md`。由于 scheduled weekly/monthly 已被授权无需人工确认调用 `reviews.save`，提示注入或模型错误即可覆盖真实 Workspace 管理资产。这直接违反项目红线，必须在合并前修复，并增加实际路径逃逸测试。

#### [P1] 冲突检测仍是未接线代码

`probeToolConflicts` 和 `shouldBlockSessionOnConflict` 只被测试文件导入。`resolveSessionMcpServers`、`buildInvestAgentMcpServers` 和 `getOrCreateSession/newSession` 均未调用它们。即使探针算法正确，生产会话仍会把冲突服务器原样交给 codex-acp。

#### [P1] 未知 scheduled task 绕过 fail-closed grant

`resolveScheduledServiceGrant` 为未知类型实现了 reads-only，但 `resolveAllowedTools` 只有在 `isScheduledTaskType` 返回 true 时才调用它；后者只认可四个表内值。未来增加 `scheduled-*` 任务而忘记登记时，会回落到空 allowlist并获得全部工具。测试只直接测了未被生产调用的 helper 结果。

#### [P1] publication smoke 会使用非测试 DB 且不清理

worktree 存在 `.env`，其中 `DB_PATH` 不是 test/tmp 路径。wrapper 没有设置隔离的 `DB_PATH`、`WORKSPACE_ROOT`、`RUNTIME_DATA_ROOT` 或 `REVIEWS_ROOT`，默认创建 `pub-smoke-user`，结束时只 dispose ACP。裸运行违反本次验收和项目的数据状态边界，因此本次没有执行。

#### [P2] periodic review 的手写 YAML 不能承载正常摘要

`summary: ${record.summary}` 直接内联，反序列化只读取第一条 `summary:` 行。包含换行、冒号、`#` 或 YAML 特殊字符的微信 Markdown 摘要会被截断或误解析。应使用项目现有 YAML/JSON structured API，并原样 round-trip 多行 Markdown。

#### [P2] ACP E2E probe 没有测试 MCP 调用

probe 的 prompt 是“不要调用任何工具”，成功条件只检查 ACP 有文本回复。即使 `market-data-tool` 完全无法启动，该脚本也可能在 service-only 会话下通过；它没有检查 tool-call event、服务端调用日志或行情结果。

#### [P2] market-watch prompt 的服务编排仍未删除

上轮验收已指出具名行情调用和固定简报强制输出与目标架构不一致，本轮没有相关改动。静态测试仍明确要求该文字存在。

### Verification Performed

- `npm run verify`：通过，290 tests；context check、build、7 boundary tests 通过。
- `npm run smoke:stage1-scheduler`：通过。
- `npm run smoke:stage2-watch-rules`：通过。
- `npm run smoke:mcp-service-tools`：通过。
- `npm run smoke:security-boundary`：通过。
- `npm run smoke:db-legacy-migration`：通过。
- 新增目标测试：37/37 通过。
- `git diff --check main...HEAD`：通过。
- `npm run smoke:scheduled-review-publication`：未运行；当前 wrapper 会读取非测试 `.env` DB/Workspace 配置并写入状态，不满足安全前置条件。
- 源码调用扫描：冲突探针无生产调用方；ACP E2E prompt 不调用工具。

### Routing

第二次复验任务见 follow-up 文档的 R1-R6。R1、R2、R3 是合并阻断项；R4、R5 关闭架构与证据缺口；R6 重新执行安全验收并决定合并。

---

## 2026-07-30 最终复验

### Acceptance Verdict

**Status: Pass。已允许并完成合并。**

最终验收对象为 `refactor/mcp-registry-agent-tooling` 提交 `cfb55eb`。前两次验收发现的 P0-P2 均已关闭；分支保持从 `main` 线性前进，并已通过 `git merge --ff-only` 合并到 `main`。

### Closed Findings

- 定时任务授权由生产 resolver 统一计算；未知 `scheduled-*` 类型 fail closed 为只读。
- 日/周/月 `reviews.save` 在首次写入前绑定服务下发的预期 `kind` 与 report key；目标进入 session fingerprint，跨周期不会复用旧权限会话。
- periodic report key 严格校验并执行路径 containment；YAML 使用结构化库原样往返 Markdown。
- 工具冲突探针已接入 `newSession` 前路径；service-tools 探针失败阻断会话，外部失败剔除，配置变化使缓存失效。
- 冲突探针子进程只继承最小运行环境和注册项显式 env；外部注册项禁止引用完整 service scope 集合。
- market-watch 新路径不再强制具名研究工具或禁止 `NO_PUSH`。
- fixture MCP probe 使用系统临时目录；publication smoke 使用隔离 DB/Workspace/Runtime/Reviews，关闭 ACP 与 SQLite 后清理并正常退出。
- 周/月 review mutation lock 使用各自的 kind/reportKey，不再错误归入 daily 锁。

### Final Verification

- `npm run verify`：通过，307 tests；agent context、TypeScript build、7 项 boundary tests 全部通过。
- 定向安全与授权回归：54/54 通过。
- `npm run smoke:mcp-service-tools`：通过，43 tools。
- `npm run smoke:stage1-scheduler`：通过。
- `npm run smoke:stage2-watch-rules`：通过。
- `npm run smoke:security-boundary`：通过。
- `npm run smoke:db-legacy-migration`：通过。
- `npm run smoke:scheduled-review-publication`：通过；Agent 实际调用 `reviews.save`，回读成功，临时根清理后命令 exit 0。
- `git diff --check`：通过。
- 合并方式：`git merge --ff-only refactor/mcp-registry-agent-tooling`，`main` 到达 `cfb55eb`。

### Residual Notes

- 外部 `market-data-tool` 仍默认关闭，启用需要显式环境开关和本地路径配置；本次合并没有部署或修改生产配置。
- real market-data probe 对 v1.29.0 能力数量有版本期望；稳定的 ACP 工具调用证据由 fixture sentinel + 进程外计数提供。该项不构成运行时安全或合并阻断。
- live smoke 中 Codex 自身的其他全局 MCP/plugin 出现启动告警，但 `invest-agent-service-tools` 为 Ready，受控保存与回读均成功。
