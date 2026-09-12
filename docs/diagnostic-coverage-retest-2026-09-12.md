# 诊断覆盖率复测报告（2026-09-12，观察窗口终局·提前收口）

状态：**终局复测**（T-474；7 天观察窗口提前收口）

对 [diagnostic-coverage-report-2026-09-06.md](./diagnostic-coverage-report-2026-09-06.md) 基线的终局复测，验证 GAP-1/2 修复（发布 20260906T020157Z-2afb5e0f）在真实生产窗口的效果；中期复测见 [diagnostic-coverage-retest-2026-09-10.md](./diagnostic-coverage-retest-2026-09-10.md)。

- **窗口端点审计痕**：原窗口 `2026-09-06T02:04Z` .. `09-13`（owner 9-6 审核结论定的 7 天窗口）。owner 2026-09-12 裁决提前收口，理由=剩余 1.5 天为周末非交易日：交易类任务（盯盘/行业复盘/复盘推送）零流量、空壳照推观察对象不产生，边际证据价值低；巡查兜底不因收口消失。实际窗口 `2026-09-06T02:04Z` .. `2026-09-12T01:25Z`（约 6.0 天，完整覆盖交易周 9-07~9-11）。
- 测量方式：与中期同纪律——SSH 只读连接生产库（`better-sqlite3 {readonly:true}`），全部 SELECT、零写操作、零部署、不在服务器落文件。查询脚本 [scripts/diagnostic-coverage-retest.mjs](../scripts/diagnostic-coverage-retest.mjs) 重跑，另加三组补充只读查询（异常终态逐条归因、质量下限终验、MCP failed 明细）。
- 期间部署链：2afb5e0f → 6e57155 → 8790ecfb → b5f065c7 → da8df7a0（061953Z/063117Z 两跳）→ d7ff4fa0 → b7202c2 → 0824e856 → ea1ee19d → 066a777b（含中间版 5e13ddba）——GAP-1/2 修复面无回退（全窗口数据形态本身为证：键形态、关联率持续一致）。
- 巡查交叉核对：`data/patrol-reports/2026-09-06..09-11.md` 六份 + 本报告 SQL 直算。

## 一、结论先行

1. **GAP-1 终局验证通过，断链归零且 6 天未回升**：窗口内微信轮 15 条 trace 全部持统一信封键（`weixin-inbound:*`），旧 `wx-<时间戳>` 形态 0、兜底形态 0；trace_id/message_id 同键 15/15；助手消息 request_id 反链 trace 15/15；**微信键形态 MCP 调用未解析 0 条**（基线为 85 条工具调用 + 21 条消息断链）；全通道 MCP 调用未解析 0/564（基线 88.5% → 100% 维持）。唯一未反链的 1 条 user 消息（9-10T06:32Z「农发种业全部清仓」）属其首轮 web 失败尝试的信封键——该轮 trace 未落库、巡查 P-003 守卫簇在案（审计 id 5172~5190 区间），用户同分钟内在微信通道重试成功、回复送达；是已归因事件，非关联机制缺陷。
2. **S7 三率全达标（终局）**：audit trace 覆盖率 225/228 显式关联（222 trace 直解 + 3 conversation 兜底），余 3 条为 111 盯盘租约过期 run 的模型前服务审计（n.a. 白名单类）——有效口径 **100%**（阈值 100%）；automation trace 关联率 88/89，唯一 miss 为同一租约过期 run（n.a.）——有效口径 **100%**（阈值 ≥99%）；push origin 关联率 81/81、delivery 关联率 87/87 = **100%**（阈值 100%）。
3. **无重复推送、异常终态全部归因（零未解释项）**：同一 push 重复 sent 0；同 origin_run+message_kind 多 push 0；push expired 8 条全部 `expired_while_awaiting_user`（T-315 族设计内挂起超时）；投递 failed 19 条全部 `context_expired`（T-315 面状已知问题，较中期 14 条随窗口自然增长、无新形态）；awaiting_user 5 条设计内；automation failed 3 条逐条归因（§三）；trace timeout 2 条均为 9-08 已归因事件（9-09 之后零新增）；MCP failed 9 条全部挂在两条已归因 failed run 上（§三）。
4. **GAP-2 终局=部分通过，遗留一行白名单收尾（与中期结论一致，非新缺陷）**：n.a. 过滤机制工作正常（窗口内 n.a. 16 条正常剔除、30 天 `scheduledRunsNa`=96 非零单列呈现）；平台 scheduler 反链率仍 0%（0/61）——两因素叠加：①`trace_payload_retention`/`file_retention_*` 三类未登记白名单（补登一行仍未发布，本地源码核实 [run-diagnostic.ts](../src/services/run-diagnostic.ts) 仍为两条目）；②8 月历史 typed 前旧行随 30 天窗口自然滑出中（分母 99→61）。补登 + 滑出（约 9-17 完成）后该指标进入 0/0 结构性 n.a.，属修复收尾，不阻断收口。
5. **新增观察两条（均不阻断）**：①`trace_payload_retention` 9-11 漏跑一次（9-07~9-10 每日一条节奏、9-11 缺失；90 天滚动清理任务漏一日无数据面影响，9-12T04:18Z 自然恢复可验）；②生产 `logs/app.log` 混入测试套件日志——9-10T06:21Z 的 7 条 `automation summary quality floor applied` WARN 为发布验收期间在服务器执行测试套件所致（任务名 `validity-watch-*`/`floor-shell` 与 [tests/automation-delivery-validity.test.ts](../tests/automation-delivery-validity.test.ts)、[tests/automation-summary-quality-floor.test.ts](../tests/automation-summary-quality-floor.test.ts) 夹具同名；对应 run_id 在生产 `automation_task_runs` 零存在、零 push；[logger.ts](../src/lib/logger.ts) 按 `process.cwd()` 相对路径共享写 `logs/app.log`）——**该 7 条不构成生产防线触发证据**，生产流量实际触发仍为 0 次（详见 §五）；测试进程与生产日志写入口径隔离登记为日志卫生可选项。

## 二、窗口总览（2026-09-06T02:04Z .. 09-12T01:25Z）

| 实体 | 数量 | 显式关联情况 |
| --- | --- | --- |
| 模型轮次（agent_traces） | 120 | trace_id 120/120、conversation 120/120（automation 94 / weixin-mobile 15 / web 11）；status：success 118 + timeout 2（均已归因，9-09 后零新增） |
| automation 运行 | 89 | trace 关联 **88/89**（1 条 n.a.=模型前租约过期失败）；终态：succeeded 86 + failed 3（逐条归因见 §三） |
| 规则调度（scheduled_task_runs） | 20 | rule-alert-check 10 + data-quality-summary 6（均 n.a. 白名单内）+ trace_payload_retention 4（未登记白名单，见 §四；9-11 漏跑一次）；全部 success |
| 服务审计（sandbox_audit_logs） | 228 | trace_id 直解 222 + conversation 兜底 3（mg 首试失败轮，巡查 P-003）+ n.a. 3（111 租约过期 run 服务侧读，巡查 P-002） |
| 外部 MCP 调用 | 564 | run_id 564/564；解析 **564/564（100%）**；completed 555 + failed 9（全部挂已归因 failed run，见 §三） |
| push job | 81 | origin 关联 81/81（run 66 + task_key 15）；终态：sent 68 + awaiting_user 5 + expired 8（全部 expired_while_awaiting_user） |
| 投递尝试 | 87 | push 关联 87/87；sent 68 + failed 19（全部 context_expired） |
| 会话产物 | 18 | conversation 18/18；message 0/18——全部 reviews.save 定时产物（n.a. 白名单源） |

模型参与实体合计 209（120 轮次 + 89 run），显式关联 208 + n.a. 1 = 100%（基线 99.6%；基线唯一 n.a. 例外当期再现 1 次，属白名单类，口径一致）。

## 三、异常终态逐条归因（零未解释项）

| 信号 | 量 | 归因 | 巡查交叉核对 |
| --- | --- | --- | --- |
| push expired | 8 | 全部 mg 通道、terminal_reason=`expired_while_awaiting_user`、sent_at=null——设计内挂起超时（T-315 通道问题族，选型待 owner） | 9-07~9-11 巡查 FP 台账同源记录 |
| 投递 failed | 19 | 全部 reason=`context_expired`——T-315 面状已知问题（较中期 14 条 +5，窗口自然增长，无新形态） | 9-10/9-11 巡查 P-003 系列同源 |
| automation failed | 3 | ①`atrun_9b9b79a6`（9-08，mg T-317 行业复盘 timeout，无 push）；②`atrun_021a6d9e`（9-10T06:31Z，111 盯盘 `AUTOMATION_RUN_LEASE_EXPIRED`，20m9s 耗尽整个 slot；调度器 5 分钟后自动重跑 `atrun_0b5fac1b` 55s succeeded、delivery=sent——**自愈**）；③`atrun_78d514f4`（9-11T11:30Z，mg 行业复盘 appendRows 行业名称取值集误拒=**T-496**，rev24 已上线、周一 19:30 自然 run 验证） | 9-08/9-09 巡查 P0 盯防节；9-10 巡查 P-002；9-11 巡查 FP-20260911-01 |
| trace timeout | 2 | 均为 9-08 事件：portal-f2adb78f（web，terra 600s）+ atrun_9b9b79a6（1169s，同上）；9-09 之后零新增 | 9-08/9-09 巡查 |
| MCP failed | 9 | 7 条 9-08T11:31-34Z 挂 `atrun_9b9b79a6`（market-data-tool 行情工具 McpError，即 T-317 失败事件同时段）；2 条 9-11T11:31Z 挂 `atrun_78d514f4`（`get_industry_daily_overview`，即 T-496 事件链前段）——无独立于已归因 run 的新失败 | 同左 |
| audit 未直解 | 6 | 3 条=111 租约过期 run 的模型前服务读（portfolio/plans/watchlist.read，n.a. 类）；3 条=mg 首试失败信封键的守卫调用（confirmations.request×2 + portfolio.read，conversation 兜底解析）——巡查 P-003 守卫簇（审计 id 5172~5190，14 次确定性契约拒收，守卫正确工作、无越权写入）的子集 | 9-10 巡查 P-002/P-003 |
| 重复推送 | 0 | 同 push 多条 sent 0；同 origin_run+message_kind 多 push 0 | 基线 G4 判据延续通过 |

## 四、GAP-2：通过项 + 遗留（与中期一致）+ 新增观察

**通过项（终局确认）**：`SCHEDULER_TRACE_NA_TASK_TYPES` 过滤生效——rule-alert-check（窗口 10 条）/ data-quality-summary（窗口 6 条）已从分母剔除，`scheduledRunsNa` 30 天 96 条正常单列呈现（判据「scheduledRunsNa 正常呈现」✅ 终局维持）。

**遗留（修复收尾，非新缺陷）**：白名单补登一行仍未发布——本地 [run-diagnostic.ts](../src/services/run-diagnostic.ts) 的 `SCHEDULER_TRACE_NA_TASK_TYPES` 核实仍为两条目。处置建议延续中期：

```ts
const SCHEDULER_TRACE_NA_TASK_TYPES: readonly string[] = [
  "rule-alert-check", "data-quality-summary",
  "trace_payload_retention",                       // 新增（9-10 复测发现）
  "file_retention_trash_purge", "file_retention_attachment_cleanup",  // 同类无模型维护任务，一并登记
];
```

同步动作：基线报告 §六 n.a. 白名单条目追加这三类（白名单变更需在基线文档追加记录）；EV-017 补断言。发布后 30 天口径仍需等 8 月历史行滑出（约 9-17）才完全反映，属已知过渡。平台分母滑出进度：中期 99 → 终局 61。

**新增观察**：
- `trace_payload_retention` 9-11 漏跑一次（§一.5①）；建议随白名单补登发布时顺带核对 9-12 恢复，不单独立案。
- `app.log` 测试日志混入（§一.5②）；登记为日志卫生可选项（如按 NODE_ENV 隔离 toFile），不阻断、不强制。

## 五、对 SCR-20260906-01/02 四栏的终局回填 + T-475 终验

| SCR | 栏 | 终局判定（证据截至 9-12T01:25Z） |
| --- | --- | --- |
| SCR-20260906-01（T-472 观测口径） | 业务终态正确 | **pass（终局）**：GAP-1 断链归零 6 天未回升（§一.1）、三率全达标（§一.2）、GAP-2 除白名单收尾外按设计工作（§四） |
| SCR-20260906-02（T-473 质量下限） | 业务终态正确 | **pass（终局）**：已投递 automation_summary 59 条 sent，最短 80 字符（正常短摘要）、0 条低于 40 字符下限、0 条降级模板标记；run 落库 result_summary 86 条最短 66 字符、0 条低于下限——9-04 的 13 字元话语签名零再现；生产流量防线触发 0 次（app.log 中 7 条 WARN 为 9-10 发布验收的测试套件 fixture 日志，生产库零对应 run/push，§一.5②）；S3 催补 9-10/9-11 关键词命中 0、S6 点踩持续 0——用户未因此受阻 |

**T-475 终验结论**：BC-20260904-001 观察窗口（9-06T02:04Z~9-12T01:25Z，端点随本复测提前，owner 裁决）内无「空壳照推」同型、无降级模板实际送达、用户未受阻——**符合 BC 文件关闭条件，建议 status triaged→fixed 并关闭（owner 终裁）**；终局观察记录已追加至 [BC-20260904-001](./bad-cases/BC-20260904-001-empty-summary-push.md)。

## 六、T-474 收口判定与遗留移交

- **判定**：GAP-1 修复验证通过（终局，归零未回升）；GAP-2 按设计工作、遗留一行白名单补登待发布。T-474 按「修复验证通过」收口。
- **遗留移交（均不阻断）**：①GAP-2 白名单一行（owner 授权 + 下次白天发布 + 基线文档 §六 n.a. 条目追加 + EV-017 断言同步；发布后约 9-17 历史行滑出完成）；②T-496 行业复盘 rev24 周一（9-14）19:30 自然 run 首验（不在本窗口判据内，巡查承载）；③`trace_payload_retention` 9-12 恢复核对；④日志卫生可选项（测试进程与生产 logger 写入口径隔离）。
- 本报告与中期报告共同构成完整窗口证据链（9-06~9-10 中期 + 9-06~9-12 终局）；提前收口审计痕见文首。
