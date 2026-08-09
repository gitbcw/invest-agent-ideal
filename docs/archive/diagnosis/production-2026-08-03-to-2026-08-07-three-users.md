# 火山云生产审计诊断：2026-08-03 至 2026-08-07

诊断时间：2026-08-08 20:10 Asia/Shanghai

## 1. 范围

- 时间范围：2026-08-03 00:00:00 至 2026-08-07 23:59:59，Asia/Shanghai。
- 数据库查询边界：`2026-08-02T16:00:00.000Z <= created_at < 2026-08-07T16:00:00.000Z`。
- 环境：火山云生产，release 当前为 `20260807T230904Z-6eb568c8`，commit `6eb568c87e6ccfa18e0a71b176f7da219a2a2622`。
- 用户范围：`111`、`mg`、`dyk`。三者在该范围内都有会话、ACP trace 和 Sandbox 审计证据；`primary` 作为维护/测试身份排除。
- 证据源：`conversation_messages`、`codex_acp_traces`、`sandbox_audit_logs`、`scheduled_task_runs`、`push_jobs`、生产 `logs/app.log`，以及当前代码中的 ACP 和复盘调度实现。
- 诊断性质：探索式只读诊断。未检查用户 Workspace 私密文件，未触发真实 ACP、微信消息、任务重放或生产修改。

## 2. 摘要

- 会话消息：220 条。
- ACP traces：177 条；145 成功，32 条非成功，非成功率 18.1%。
- 用户聊天 ACP：108 条；83 成功，20 超时，5 错误，非成功率 23.1%。
- 定时日复盘 ACP：13 条；6 成功，7 错误，错误率 53.8%。
- 盘中定时简报 ACP：56 条，全部成功落 trace；另有 3 条运行记录停留在 `claimed`，没有形成 trace。
- Sandbox 审计：541 条；539 成功，2 条被确定性契约拒绝。
- 调度运行：856 条；62 成功，783 正常跳过，8 错误，3 条长期停留在 `claimed`。
- 推送任务：57 条；49 已发送，4 在用户恢复会话后补发，3 等待用户恢复，1 已过期。

结论：确认存在调度任务不可回收、ACP 运行时安装不稳定、复盘预生成与正式触发冲突三类确定性可靠性问题；跨用户 ACP 长耗时/超时是高影响问题，但具体耗时根因仍需进一步按工具调用和请求类型拆解。微信 `ret=-2` 主要符合现有“等待用户恢复会话”设计，不直接判定为服务缺陷。

## 3. 问题簇

### P-001 三个用户各有一条盘中任务永久停留在 `claimed`

- 严重度：P1
- 根因状态：confirmed
- 责任层：service / scheduler
- 影响范围：3/3 用户；2026-08-07 三条 `market-watch` 未形成成功、失败或可重试终态。
- 失败阶段：scheduler claim -> worker execution
- 适用标准：调度任务必须进入成功、跳过、可重试或终止状态；不能无限期占用 claim。
- 观察事实：
  - `dyk`: `2026-08-07:market-watch:dyk:invest-agent-dyk:09:30`，claimed at `2026-08-07T01:30:25.375Z`。
  - `111`: `2026-08-07:market-watch:111:invest-agent-111:09:55`，claimed at `2026-08-07T01:55:25.426Z`。
  - `mg`: `2026-08-07:market-watch:mg:invest-agent-mg:09:55`，claimed at `2026-08-07T01:55:25.437Z`。
  - 三条记录的 `lease_expires_at` 均为空，诊断时仍为 `claimed`。
  - 同期日志记录 ACP 子进程 `npm ENOTEMPTY` 后以 code 217 退出，随后生产进程多次收到 SIGINT/重启。
- 诊断：任务在 claim 后遇到 ACP/进程异常，错误路径没有完成任务记录；同时 claim 没有租约或启动时回收机制，导致永久悬挂。
- 建议修复：给调度 claim 增加明确租约和启动/周期回收；worker 顶层必须在所有进程退出、取消和异常路径调用 finish，形成 `retry` 或 `error` 终态。
- 验证：构造“claim 后 ACP 子进程退出”和“claim 后主进程重启”两类确定性测试，验证旧 claim 到期后可被回收，且不会重复推送。

### P-002 三个用户均出现大量 ACP 聊天超时

- 严重度：P1
- 根因状态：probable
- 责任层：ACP runtime / service orchestration
- 影响范围：3/3 用户；20/108 条聊天 trace 超时，另有 5 条错误。
- 失败阶段：ACP prompt execution
- 观察事实：
  - `111`：6 次聊天超时，超时阈值主要为 600 秒。
  - `mg`：9 次聊天超时，其中一次达到 1200 秒；相同对话/请求出现重复超时。
  - `dyk`：5 次聊天超时，阈值为 480 或 600 秒。
  - 成功聊天平均耗时也较高：`111` 177 秒、`mg` 224 秒、`dyk` 226 秒；成功样本最大耗时分别约 913、1019、426 秒。
  - 请求类型集中在详细复盘、选股/公式扫描、回测和表格生成等高工作量任务，但短请求也出现超时。
- 诊断：固定 8/10/20 分钟超时与长链路 Agent 任务不匹配只是表象。日志尚不足以区分模型推理慢、外部工具慢、任务范围过大、取消未及时生效或会话状态膨胀。
- 缺失证据：每条 trace 的工具调用分段耗时、外部 MCP 延迟、取消完成时间、上下文大小与超时的关联。
- 建议修复：先增加 trace 级阶段耗时统计并按请求类型分桶；再决定拆分任务、异步产物、软超时进度响应、工具超时或上下文治理，不能仅提高总超时。
- 验证：对复盘、公式扫描、回测、普通问答分别回放最小代表请求，记录模型首响应、工具调用、最终响应和取消收敛时间。

### P-003 日复盘预生成与正式触发争用同一 ACP conversation

- 严重度：P1
- 根因状态：confirmed（三次重叠链路）；2026-08-07 `dyk` 的额外 busy 仍需补证据。
- 责任层：scheduler / service orchestration
- 影响范围：3/3 用户；13 次定时日复盘中 7 次错误。
- 失败阶段：prepare -> scheduled fire
- 观察事实：
  - `111` 在 2026-08-04、`mg` 在 2026-08-05、`dyk` 在 2026-08-06 都出现预生成持续到 600 秒超时，而正式触发在预生成未结束时进入同一日复盘 conversation，立即返回 `ACP_TURN_BUSY`。
  - 当前代码的 `activeConversations` 明确拒绝同 conversation 并发；调度循环先触发 prepare，但正式触发没有等待进行中的 prepare 收敛。
  - `dyk` 在 2026-08-07 还有一次 `ACP_TURN_BUSY`，本次范围内没有对应的完整 prepare trace，需要补查进程内状态或缺失 trace。
- 诊断：预生成最大执行时间大于提前量，正式触发缺少“prepare in progress”状态协调。
- 建议修复：将 prepare 状态持久化并设置租约；正式触发优先等待/接管同一准备任务，超时后走明确降级，禁止再次发起同 conversation turn。
- 验证：让 prepare 跨过正式触发时刻，验证只存在一个 ACP turn，最终 task run 进入唯一终态且最多产生一个 push job。

### P-004 生产 Codex/ACP 安装路径发生不稳定更新与依赖缺失

- 严重度：P1
- 根因状态：confirmed
- 责任层：operations / runtime packaging
- 影响范围：至少影响 `111` 的两次微信请求，并与 P-001 三条悬挂任务处于同一故障窗口。
- 失败阶段：ACP process startup
- 观察事实：
  - 2026-08-07 09:55 Asia/Shanghai，ACP 启动出现 npm `ENOTEMPTY`，子进程 code 217 退出。
  - 2026-08-07 10:27 Asia/Shanghai，Codex 启动明确报 `Missing optional dependency @openai/codex-linux-x64`。
  - 随后重试可启动，但同一上午生产进程多次 SIGINT 重启，并中断用户 turn。
- 诊断：生产 ACP 命令依赖运行时 npx/npm 可变安装缓存；并发或更新过程破坏了可执行依赖，不是用户请求或产品语义问题。
- 建议修复：生产使用固定版本、预安装并验收的 Codex/ACP 可执行物；启动前验证平台可选依赖，不允许请求路径触发在线安装或更新。
- 验证：清理临时 npm 缓存后从发布包冷启动，连续并发启动多个 workspace ACP，确认不联网安装、不改写共享包目录且全部可用。

### P-005 `111` 的 Portal 请求出现 scope mismatch

- 严重度：P2
- 根因状态：probable
- 责任层：portal connector / scope mapping
- 影响范围：`111`；4 次 automation list 和 2 次 conversation 请求失败。
- 失败阶段：Portal connector -> service scope validation
- 观察事实：2026-08-06 日志连续出现 `AUTOMATION_SCOPE_MISMATCH:invest-agent-111` 和 `CONVERSATION_SCOPE_MISMATCH`。
- 诊断：服务层拒绝不一致 scope 的安全行为本身正确；更可能是 Portal connector 传入的 assistant/user/instance/conversation 组合与已存在 session 不一致。
- 缺失证据：失败命令的脱敏 envelope、Portal 当前账号和 assistant binding、对应 conversation session scope。
- 建议修复：增加脱敏 scope 诊断字段并核对 connector 绑定，不放宽服务层 scope 校验。
- 验证：以 `111` 登录 Portal，分别执行 automation list 和已有 conversation 续聊，确认 envelope 四元组一致且跨用户请求仍被拒绝。

### P-006 `mg` 无法把 YAML 复盘模板保存为用户资产

- 严重度：P2
- 根因状态：confirmed（行为）；产品正确性为 standards gap
- 责任层：user assets / product contract
- 影响范围：`mg`；2026-08-07 两次 `ASSET_UNSUPPORTED_FORMAT:daily_review_template.yaml`。
- 失败阶段：Portal artifact -> user asset
- 观察事实：资产格式校验明确拒绝 `.yaml`。
- 诊断：系统行为确定，但当前没有足够产品标准判断“自动化/复盘模板 YAML 是否应成为用户资产”。
- 建议修复：先由产品确认 YAML 是否属于允许的自动化配置资产；若允许，增加受控 MIME/扩展名和安全预览；若不允许，Portal 应在操作前阻止并给出可行替代格式。
- 验证：按产品决策补充格式 allowlist 或前端阻止测试，不能只隐藏错误。

## 4. 非缺陷或待观察项

### O-001 微信主动推送等待用户恢复

- 49 条已发送，4 条在用户恢复会话后补发，3 条仍为 `awaiting_user`，1 条因等待过久过期。
- `ret=-2 prepare failed` 与现有 `pushReady`/会话上下文失效设计一致，不能仅凭该状态判定服务缺陷。
- 需要人工判断：产品是否接受“用户未重新发消息就无法主动推送”的交付边界；若不接受，这是渠道能力/产品承诺问题，不是简单重试问题。

### O-002 两条 Sandbox 确定性拒绝

- `111`：`strategyPatch.profile` 使用不支持字段 `dailyReviewTemplate`。
- `dyk`：`reviews.save` 在没有明确用户确认时请求 `confirmedByUser=true`。
- 两次拒绝均表明服务契约生效。是否需要改善 Agent 指令或工具 schema 提示，应结合对应完整会话人工判断；本报告不直接判定为服务缺陷。

## 5. 当前状态补充（不计入范围统计）

- 2026-08-08 20:07 Asia/Shanghai，`/health` 返回 `ok`，PM2 `invest-agent` online，当前 uptime 约 12 小时。
- 当前 release 与本地 `main` commit 一致。
- 时间范围结束后，2026-08-08 仍出现 `dyk` 周复盘 `ACP_TURN_BUSY` 和 `mg` 周复盘 600 秒超时，说明 P-002/P-003 类问题在最新发布后仍然存在。

## 6. 人工复核队列

1. `accept diagnosis`：P-001 调度 claim 无租约/回收导致三条任务永久悬挂。
2. `request more evidence`：P-002 需要分段耗时，避免把所有长任务简单归因为模型慢。
3. `accept diagnosis`：P-003 prepare 与正式触发的 conversation 争用。
4. `accept diagnosis`：P-004 生产 ACP 可执行依赖安装不稳定。
5. `request more evidence`：P-005 需要 Portal 脱敏 envelope 和 session scope 对照。
6. `define or clarify standard`：P-006 是否支持 YAML 自动化/复盘模板资产。
7. `define or clarify standard`：O-001 微信会话失效后的主动推送交付承诺。

本报告没有授权或执行任何生产修复、任务重放、推送补发、Workspace 修改或部署。
