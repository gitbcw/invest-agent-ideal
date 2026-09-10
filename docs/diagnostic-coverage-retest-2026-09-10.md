# 诊断覆盖率复测报告（2026-09-10，观察窗口中期）

状态：**中期复测**（T-474；7 天窗口第 4 天，终局收口 2026-09-13）

对 [diagnostic-coverage-report-2026-09-06.md](./diagnostic-coverage-report-2026-09-06.md) 基线的复测，验证 GAP-1/2 修复（发布 20260906T020157Z-2afb5e0f）在真实生产窗口的效果。

- 测量方式：SSH 只读连接生产库（`better-sqlite3 {readonly:true}`，与每日巡查同纪律），全部 SELECT、零写操作、零部署、不在服务器落文件。查询脚本固化为 [scripts/diagnostic-coverage-retest.mjs](../scripts/diagnostic-coverage-retest.mjs)，9-13 终局复测可直接重跑。
- 关联判定：只用显式 ID 相等（与 `src/services/run-diagnostic.ts` 契约一致），时间邻近不参与任何覆盖率计算。
- 复测窗口：`2026-09-06T02:04Z`（2afb5e0f 部署完成时刻）.. `2026-09-10T03:11Z`（约 4.05 天）。期间部署链 2afb5e0f → 6e57155 → 8790ecfb → b5f065c7 均为其后继，修复持续在效（数据形态本身亦为证）。
- 巡查交叉核对：`data/patrol-reports/2026-09-06..09-09.md` 四份 + 本报告 SQL 直算（S7 三率未并入巡查正文，按任务口径以只读 SQL 直算替代平台 UI）。

## 一、结论先行

1. **GAP-1 验证通过，断点归零且未回升**：窗口内微信轮 11 条 trace 全部持统一信封键（`weixin-inbound:*`），旧 `wx-<时间戳>` 形态 0 条；trace_id/message_id 同键 11/11；助手消息 request_id 反链 trace 11/11；**微信键形态 MCP 调用未解析 0 条**（基线为 85 条工具调用 + 21 条消息断链）。全通道 MCP 调用未解析也为 0（基线 88.5% → 100%）。
2. **S7 三率全达标**：audit trace 覆盖率 128/128 = **100%**（阈值 100%）；automation trace 关联率 54/54 = **100%**（阈值 ≥99%，窗口内无模型前过期失败需剔除）；push origin 关联率 50/50、delivery 关联率 55/55 = **100%**（阈值 100%）。
3. **无重复推送、无未解释异常终态**：同一 push 重复 sent 0；idempotency 键重复 0；7 条 expired push 终态原因全部 `expired_while_awaiting_user`（mg 通道挂起，T-315 已知族）；14 条 failed 投递全部 `context_expired`（mg 11 / dyk 2 / 111 1，同 T-315 面）；automation 唯一 failed = T-317 行业复盘 9-08 timeout（巡查已升级盯防）；trace 仅 2 条 timeout 且均可归因（同上前者 + 111 web 9-08 terra 600s，9-09 巡查已记）。
4. **GAP-2 部分通过，并发现一个口径侵蚀**：n.a. 过滤机制本身工作正常（`scheduledRunsNa` 30 天 92 条单列呈现、非零），但 **9-06 新上线的无模型调度类型 `trace_payload_retention` 未登记 n.a. 白名单**，叠加 8 月历史 `market-watch`/`daily-review` 行仍在 30 天分母，平台 scheduler 反链率仍显示 0%（0/99）——「不再恒 0%」判据当前不满足。处置见 §四：一行白名单补登即可，属修复收尾而非新缺陷。

## 二、窗口总览（2026-09-06T02:04Z .. 09-10T03:11Z）

| 实体 | 数量 | 显式关联情况 |
| --- | --- | --- |
| 模型轮次（agent_traces） | 79 | trace_id 79/79、conversation 79/79（automation 58 / weixin-mobile 11 / web 10）；status：success 77 + timeout 2（均已归因） |
| automation 运行 | 54 | trace 关联 **54/54**；终态：succeeded 53 + failed 1（timeout，T-317 9-08）；delivery：sent 37 / pending 4（今日在途）/ not_requested 12（delivery.mode=none 或 suppressed，设计内）/ null 1（失败 run） |
| 规则调度（scheduled_task_runs） | 14 | rule-alert-check 7 + data-quality-summary 4（均 n.a. 白名单内）+ **trace_payload_retention 3（未登记白名单，见 §四）**；全部 success |
| 服务审计（sandbox_audit_logs） | 128 | trace_id 128/128（100%），全部解析到 trace 行 |
| 外部 MCP 调用 | 290 | run_id 290/290；**解析 290/290（100%）**；completed 283 + failed 7（9-08 行情工具 McpError，见 §三） |
| push job | 50 | origin 关联 50/50（run 41 + task_key 9）；终态：sent 41 + awaiting_user 2 + expired 7（全部 expired_while_awaiting_user） |
| 投递尝试 | 55 | push 关联 55/55；sent 41 + failed 14（全部 context_expired） |
| 会话产物 | 9 | conversation 9/9；message 0/9——全部 reviews.save 定时产物（n.a. 白名单源） |

模型参与实体合计 133（79 轮次 + 54 run），可显式关联 133/133（100%）；基线为 249/250 = 99.6%（唯一 n.a. 例外当期未再现）。

## 三、异常终态逐条归因（无未解释项）

| 信号 | 量 | 归因 | 巡查交叉核对 |
| --- | --- | --- | --- |
| push expired | 7 | 全部 mg、terminal_reason=`expired_while_awaiting_user`、sent_at=null——设计内挂起超时（T-315 通道问题族，选型待 owner） | 9-07/9-08 巡查 P-001 同源记录 |
| 投递 failed | 14 | 全部 reason=`context_expired`（mg 11 / dyk 2 / 111 1）——T-315 面状已知问题，非新缺口 | 9-08/9-09 巡查 P-003 系列 |
| automation failed | 1 | atrun_9b9b79a6，mg T-317 行业复盘 9-08 timeout（error_category=timeout，无 push） | 9-08/9-09 巡查 P0 盯防节，已按协议升级 |
| trace timeout | 2 | 同上 run 的 trace（1169s）+ 111 web portal-f2adb78f 9-08 terra 600s（9-09 巡查记「疑似已修复」） | 9-08/9-09 巡查 |
| MCP failed | 7 | 全部 9-08 market-data-tool 三个行情工具 McpError——与 T-317 9-08 失败事件同时段 | 9-08/9-09 巡查 |
| 重复推送 | 0 | 同 push 多条 sent 0；idempotency 重复 0；同 origin_run+message_kind 多 push 0 | 基线 G4 判据延续通过 |

## 四、GAP-2：通过项 + 新发现（trace_payload_retention 未登记）

**通过项**：`SCHEDULER_TRACE_NA_TASK_TYPES` 过滤生效——rule-alert-check（30d 64 条）/ data-quality-summary（30d 28 条）已从分母剔除，`scheduledRunsNa`=92 正常单列呈现（判据「scheduledRunsNa 正常呈现」✅）。

**新发现**：`trace_payload_retention`（[src/scheduler/file-retention.ts](../src/scheduler/file-retention.ts)，自动化工具载荷 90 天滚动清理，纯 DB 维护、无模型轮次、无 push）自 2026-09-06T01:12Z 首跑、每日 04:18Z 一条，**未登记** `SCHEDULER_TRACE_NA_TASK_TYPES`。30 天平台口径 scheduler 反链 = 0/99 = 0%——分母构成：8 月历史 `market-watch` 59 + `daily-review` 系 34 + `weekly-review-prepare` 4（typed 迁移前旧 run，9-13~9-17 自然滑出 30 天窗口）+ `trace_payload_retention` 4 + 历史 `file_retention_*` 8。当前活跃调度类型**全部**无模型轮次，白名单补登后该指标在历史行滑出后将进入 0/0 的结构性 n.a.。

**处置建议**（一行代码，走下次白天发布窗口，owner 授权）：

```ts
const SCHEDULER_TRACE_NA_TASK_TYPES: readonly string[] = [
  "rule-alert-check", "data-quality-summary",
  "trace_payload_retention",                       // 新增（本次复测发现）
  "file_retention_trash_purge", "file_retention_attachment_cleanup",  // 同类无模型维护任务，一并登记
];
```

同时建议基线 §六 n.a. 白名单条目追加这三类（白名单变更需在基线文档追加记录的规定即为本节）。EV-017 需同步补断言。

## 五、对 SCR-20260906-01/02 四栏的中期回填

| SCR | 栏 | 中期判定（证据截至 9-10T03:11Z） |
| --- | --- | --- |
| SCR-20260906-01（T-472 观测口径） | 业务终态正确 | **pass（中期）**：GAP-1 断点归零未回升（§一.1）、三率全达标（§一.2）、GAP-2 除白名单补登外按设计工作（§四） |
| SCR-20260906-02（T-473 质量下限） | 业务终态正确 | **pass（中期）**：窗口内已投递 automation_summary 0 条低于 40 字符下限、0 条含降级模板标记、run 落库 result_summary 0 条低于下限；`summary quality floor applied` 日志 0 次触发（app.log 覆盖自 8-15）；空壳照推同型 0 复发；S3 催补除 9-08 一条已知 111 会话（归因 W4 超时，与本防线无关）外全 0、S6 点踩四日全 0——用户未因此受阻 |

终局判定待 9-13 窗口收口（T-476 放行复核时翻矩阵与 SCR 清单）。

## 六、复测安排

- 9-13 终局复测：重跑 `scripts/diagnostic-coverage-retest.mjs`（窗口 `--start 2026-09-06T02:04`，覆盖至 9-13），核对 GAP-1 持续归零、GAP-2 白名单补登后比率口径、三率与终态归因；本报告 §一.1~1.3 判定若维持，T-474 按「修复验证通过」收口。
- 白名单补登发布后，30 天口径仍需等历史行滑出（~9-17）才完全反映，属已知过渡，不阻断收口。
