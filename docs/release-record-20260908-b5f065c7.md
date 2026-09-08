# 发布记录：20260908T050221Z-b5f065c7

按 [release-governance-evidence-template.md](./release-governance-evidence-template.md) 口径记录。known-good 已标记。

## 变更摘要

```text
release_id: 20260908T050221Z-b5f065c7
commit: b5f065c78fee6409413682b954e7a54fe32fcf35（main，committed-local-main）
branch: main
date: 2026-09-08 13:02–13:05（北京时间，白天发布惯例）
owner: 用户授权（2026-09-08 对话：「按你这个建议来进行治理吧后续我们再观察效果」）
agent 执行
change_type: code（确认身份比对口径收窄）
```

- 变更目的：终结确认死锁家族的第三种形态——2026-09-08 上午用户 111 调仓（会话 hQTKjx1h）确认三次才写入。terra 草案轮注册了带股数与股价估算备注的完整草案，确认轮 auto 链落 glm-5.3-flash 后每轮重复注册自己重构的变体：备注被改写（"按…价格估算市值…"→"2000股"）、名称加后缀（"稀有金属ETF"→"稀有金属ETF嘉实"）。9-3 的复用防线（内容一致即复用）做全量字符串比对，自由文本漂移被误判为"另一个草案"，新注册时间被推晚到用户确认之后，时序校验连拒两次；最终执行的是丢股数的第三变体。
- 修复：`comparableConfirmationBody`（`src/lib/sandbox-confirmation.ts`，导出共享）——`portfolio.apply_changes` 的确认身份比对剔除持仓 `name`/`notes`；复用判定（`src/mcp/service-tools-core.ts` requestConfirmation）与执行校验（validateSandboxConfirmation）两侧同口径。业务字段（代码/权重/股数/成本/现金/清仓与自选动作）不一致仍另立新草案并要求用户再确认；显式带不一致业务参数执行仍拒（安全不变量不动）。其余操作保持全量比对。
- 影响范围：`src/lib/sandbox-confirmation.ts`（比对口径 + 导出）、`src/mcp/service-tools-core.ts`（复用判定套用口径 + 注释）、`tests/confirmation-reuse-recovery.test.ts`（新增 9-08 回归 + 安全测试扩展）。
- 明确不影响的生产状态：`.env`、SQLite 数据、Workspace、`reviews/`、`.state/`、微信状态零触碰；纯代码发布（rsync + 远端构建 + PM2 重启）。111 当日已写入的持仓记录（含丢失的股数与 601816 代码疑点）不在本次范围，待用户补录裁决。
- 依赖与外部条件：无新增外部依赖。

## 验证证据

| 门类 | 结果 | 证据 |
| --- | --- | --- |
| 确定性测试/类型检查/构建 | pass | `npm run verify`：660 测试 0 fail（首跑 1 例 flaky 未复现，复跑 3 次全绿——与 9-6 发布记录同模式）、agent-context 192 文档、build、boundary 7/7 |
| scope/权限/确认/revision/幂等 | pass | 新回归：自由文本漂移（name/notes 改写）复用已确认草案不新建；业务字段漂移（权重 5→8）仍另立新草案 + warning 指路；pending 计数=2 验证不劫持 |
| 确认安全不变量 | pass | 扩展安全测试：显式带不同代码/现金参数执行仍拒（payload mismatch）；仅 name/notes 改写的显式执行放行且写入注册草案权重 |
| 错误终态、超时、取消、重试 | n/a | 未改终态机；时序校验与 TTL 行为原样 |
| Trace 覆盖和秘密边界 | n/a | 无新增数据面 |
| Portal/微信/scheduler/automation 适用链路 | pass | 走 callServiceTool 同一链路；smoke 48 工具 ok |
| 隔离行为评估与 Bad Case 回归 | pass | 8-26/9-3 两条既有回归测试原样通过（全量比对语义对非 portfolio 操作不变） |
| 故障演练 | n/a | 回滚=纯代码 revert b5f065c 重新发布 |

## 发布执行

- 快照：verified 20260908T050221Z-b5f065c7（工作树仅本次三文件，无并行改动卷入）。
- 部署：`release:deploy`——rsync → 远端 npm install/build → Portal 重建 → 双进程重启；尾部一次 23655 Connection refused 为重启时差（历次发布同现象）。
- 发布窗口核对：周二 13:02（A股午休，无盘中调度命中）。

## 发布后最小验收

1. `/health` 200、Portal `/api/health` 200 ✓；PM2 双进程 online ✓
2. `smoke:mcp-service-tools` 48 工具 ok ✓
3. dist 符号核验：`comparableConfirmationBody` 在生产 sandbox-confirmation.js（×3）与 service-tools-core.js（×1）✓
4. app.log 近 200 行 ERROR 0 ✓
5. known-good 标记完成（20260908T050221Z-b5f065c7），旧档 20260906T020157Z-2afb5e0f 裁剪

## 灰度与观测

- 观察窗口：发布后 7 天（至 2026-09-15），观测=「后续我们再观察效果」（用户裁决）——
  - 111（或任何用户）下一次确认型写入：一次确认即写入为修复生效；仍出现"系统要求本轮再确认一次"且 trace 显示 name/notes 之外的漂移（改代码/改权重/丢股数），属弱模型重构损伤，不在本防线内，按 bad case 单独评估；
  - 业务字段漂移仍应另立新草案等用户再确认（防劫持语义未动）；
  - 显式带不一致业务参数执行仍应拒（安全语义未动）。
- 已知残缺口（本次不修，观察后再裁）：flash 重构还发生过**改代码**（顾家家居 603816→601816，最终以错代码写入）与**丢股数**——业务字段漂移在确认身份比对中必须保持严格，这类损伤服务层只能"要求再确认"防写入，不能自动纠。111 现网持仓的股数缺失与 601816 代码疑点需用户补录/裁决。
- 回滚触发：确认型写入出现错误复用（用户确认 A 却执行了业务不同的 B）；回滚=`git revert b5f065c` 后重新发布。
