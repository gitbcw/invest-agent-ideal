# T-531 B1（mg）独立验收记录

日期：2026-09-21。范围：步骤 0、mg B1 导入/注册/resolver 切换和窗口 smoke。

## Acceptance Verdict

Status: **Partial — B1 已完成切换并通过即时 smoke，进入观察期；暂不解锁 T-532。**

步骤 0–9 的执行证据完整：发布、22 张表及结构核验、备份、46 项导入、D1 方法采用、依赖注册、mg resolver 切换、真实会话、真实模型、真实微信投递和跨 scope 抽查均有留痕。窗口内发生一次导入字节根错位，机器护栏阻断了错误模型调用，随后迁移字节并核验 checksum 后恢复；该事故已修复但属于 B2/B3 必须吸收的发布前风险。当前仍需至少一个交易日的自然调度观察，观察证据通过后才可进入 T-532。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 步骤 0 发布/schema | 当前代码发布、22 表快检、结构比对、健康检查 | Pass | `W7-batch-log.md`；`.state/agent-space-w7-b1/server-evidence/` | 结构核验 `pass:true`，Portal/服务/connector 恢复。 |
| 备份与清单 | 新 DR 快照、46/46 staging 零漂移、导入前在线快照 | Pass | 批次日志 §步骤 1–2 | sha256、quickCheck 和 manifest 指纹已记录。 |
| 导入与 D1 | 46 项导入、scope/hash 核对、mg 四因子 adopt、任务依赖 pin | Pass | `batch-import-report.json`、`verify-outcomes.json` | D1 方法 checksum 与源一致；confirm 前 dry-run 已执行。 |
| Resolver 切换 | mg scope resolver 生效，旧 Workspace 不再默认装配 | Pass with caveat | 批次日志 §8–9；`w7-smoke-mg.json` | workspace null 3/3，workspace 工具事件 0。旧 `reports/daily` 服务层产物写入保留为 T-534 依赖。 |
| 真实会话 | Portal web 真实消息、方法正文注入、真实模型回复 | Pass with caveat | smoke ①；basis checksum/方法版本 | 首轮因资产字节根错位失败，修复后成功；失败轮被 fail-fast 阻断，无错误回答。 |
| 真实任务与投递 | daily-review 成功、execution/delivery outcome、真实微信投递 | Pass | smoke ②；run/push/basis 记录 | 成功轮 59s，push sent 且 origin_run_id 可关联。 |
| 跨 scope | 同 scope 可读、跨 scope 拒绝 | Pass | smoke ③、verify outcomes | 未见隔离泄漏。 |
| 事故处置 | 根因、影响、修复、checksum 与误建目录清理可查 | Pass with caveat | 批次日志事故段；commit `2cab6af` | 修复是前向数据补偿，未回退 resolver；B2/B3 必须先部署该修复。 |
| 自然调度观察 | 切换后的自然 market-watch/daily-review 证据 | Unknown / pending | 批次日志 §观察 | 当前即时 smoke 与旧路径回归不能替代至少一个交易日观察。 |

## Findings

- **[P1] 不解锁 T-532。** 仍缺切换后自然调度的装配、运行终态和投递证据；按 W7 计划至少观察一个交易日，并由独立验收确认。
- **[P1] B2/B3 发布前必须吸收 2cab6af。** 事故暴露导入驱动脚本在 SSH 环境缺省 `NODE_ENV=test` 会把资产字节写到错误根。当前修复已存在，但必须确认 B2/B3 实际发布 commit 包含它，并在导入前执行生产根护栏/可读性检查。
- **[P2] T-534 需跟踪 `reports/daily`。** 该文件是 `reviews.save` 服务层产物链写入，当前不判作模型旧 Workspace 双写；但它仍是兼容窗口收口时要处理的旧根路径依赖。
- **[P2] 步骤编号顺序留痕可接受。** 实际先切 resolver 再跑需要装配态的 smoke，批次日志已说明原因；W7 手册可补“smoke 需切换后执行”的顺序说明，避免复盘歧义。

## Decisions Needed from Owner

1. 接受 mg B1 作为“切换成功、进入观察期”，不提前进入 T-532。
2. 允许继续保留 `AGENT_SPACE_ASSEMBLY_MODE=scope:mg`，直到观察期验收完成；异常时由主 Agent 按既有授权关闭 mg resolver。
3. 要求 B2/B3 先部署包含 `2cab6af` 的版本，并复用生产根校验。
4. 接受 `reports/daily` 作为 T-534 兼容窗口待处理项，不把它当作本轮双写阻塞。

## Follow-Up Checklist

- [ ] 观察至少一个交易日的 mg 自然调度，采集 basis/outcome/delivery/微信终态。
- [ ] 观察期间若出现真实失败，先关闭 mg resolver并停止后续批次。
- [ ] B2/B3 执行手册加入 `2cab6af` 版本门和资产可读性核对。
- [ ] 观察通过后再解锁 T-532；否则按 scope 补偿回滚并保留历史证据。
