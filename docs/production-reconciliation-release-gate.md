# 生产收敛发布闸门

> 状态：受控 scheduler 验收已执行；盘中简报通过，日复盘发布链路仍未通过，禁止合入 `main`。
> 当前候选主线：`codex/production-reconciliation-integration-20260722`。  
> 本记录在验收完成并合入 `main` 后移入 `docs/archive/`。

## 目的

把 2026-07-22 火山云生产快照中值得保留的修复收敛到当前主线，并在合入 `main` 前验证新用户的真实 onboarding 与定时任务运行。目标是一个可审计的单一候选主线，不是把历史生产分支整体合并回来。

## 分支职责与当前结论

| 分支 / 标签 | 角色 | 当前处理 |
| --- | --- | --- |
| `codex/volcano-snapshot-20260722` / `volcano-snapshot-20260722` | 2026-07-22 火山云代码冻结快照 | 只读证据与回退参照；不继续开发、不直接合并。 |
| `codex/production-reconciliation-20260722` | 生产修复筛选候选 | 历史比较分支；与当前主线有大量已淘汰结构差异，不整体 merge。 |
| `main` | 当前稳定主线 | 仍停在 `66be9d9`，在发布闸门通过前不前进。 |
| `codex/production-reconciliation-integration-20260722` | 唯一候选主线 | 从 `main` 演进；`main` 是其直接祖先，验收通过后可 fast-forward 合入。 |

禁止把冻结快照或旧候选分支整体 merge 到 `main`。若以后发现新的生产修复，只按最小、已审计的提交或等价补丁进入当前候选主线。

## 已收敛提交

| 提交 | 内容 | 验证 |
| --- | --- | --- |
| `f2c0115` | 已审计的 market-watch 恢复：窗口快照、MCP 读取、ACP 重试、附件清理、微信连接换绑恢复 | `npm test`、`typecheck`、构建与 MCP smoke 已通过。 |
| `d2b0027` | Onboarding 最终提交可靠性：结构化回复交接标记、明确跳过规则直接收口、兼容回填、契约与 smoke | `typecheck`、58 项测试、MCP smoke、Onboarding 提交 smoke 通过；见下方真实用户证据。 |

## 已完成的真实用户验收

保留对象：用户 `112`，实例 `invest-agent-112`，会话 `o9cq80-W6fuaXdv05G2TXbSoVc24@im.wechat`。

已验证：

- 微信扫码连接、新用户 onboarding、A/H 股歧义确认、持仓/观察仓/策略/时间/通知偏好逐步草稿确认。
- 用户明确选择“暂不设置规则”，最终 `alert_rules` 为 0。
- 冻结草稿已完成：`onboarding_drafts.status=completed`，有 handoff message ID、完成时间和完成通知时间。
- `config/onboarding_state.yaml` 为 `completed`；持仓、策略、日复盘 `19:00`、盘中窗口 `09:55/11:20/14:30`、积极盯盘偏好均已写入 workspace。
- 完成通知已进入 `push_jobs` 且状态为 `sent`。

已修复的两个回归：

1. 后台提交不再依赖客户文案是否包含“统一完成”；它只等待 initiating assistant reply 已写入权威对话日志。
2. 用户明确跳过最后的规则设置后，不再要求无内容的“确认完成”。

首次录入持仓时曾出现一次 ACP 短暂停止，用户重试后流程成功。该现象尚未重复，作为稳定性观察保留，不阻塞当前发布闸门。

## 受控 scheduler 验收（2026-07-22）

在本地运行时 `invest-agent-codex`、端口 `22655` 健康的前提下，已对用户 `112 / invest-agent-112` 执行受控触发。用户明确授权该测试账号接收真实 `market-watch` 与 `daily-review` 微信推送；未修改持仓、策略、时间或规则。

| 能力 | 结果 | 证据与结论 |
| --- | --- | --- |
| `market-watch` | 通过 | 成功写入 `market_watch_snapshots`（窗口 `23:05`），ACP trace 成功，scheduler push job 已 sent；用户已收到简报。行情时效告警被如实披露，未伪装为实时。 |
| `daily-review` 首次 | 失败，已修复 MCP 协议缺陷 | Agent 调用 `reviews.save` 时共享 logger 写入 stdout，污染 stdio JSON-RPC，导致 transport closed。现已将 MCP 服务普通日志转到 stderr，并补充成功保存路径的 stdio 回归 smoke。 |
| `daily-review` 后续三次 | 未通过，保持失败 | ACP 能成功生成客户摘要，但未调用 `reviews.save`；因此没有 `sandbox_audit_logs.reviews.save`、`daily_plans` 发布产物或 scheduler push job。服务层拒绝把这段未保存文本当作报告推送，task run 均明确记录 `scheduled daily review did not publish artifact`。 |

已定位并修正一处相互冲突的提示词：复盘上下文原先写有“不要调用任何工具”，与定时日复盘必须使用 `reviews.save` 发布相冲突。现在仅对 scheduled daily-review 放行该发布工具，普通复盘仍保留无工具边界，并有单测覆盖。

修正后，当前 ACP 仍未实际发起发布工具调用，因此这不是可以用提示词继续掩盖的“假成功”。下一步需单独解决“scheduled ACP 必须执行已开放 MCP 发布工具”的可靠执行契约；在此之前不可合入 `main`，也不可部署火山云。

验收时不需要新增明确规则；当前用户选择跳过规则，预期仍为 0 条。若需要另行验收规则巡检，创建独立、可执行且经用户确认的规则，作为下一轮范围，不混入本次发布闸门。

## 合入 main 的门槛

仅在以下条件同时满足时推进：

1. 当前候选分支工作树除用户明确保留的 `tmp/` 临时产物外干净。
2. 受控 scheduler 验收无 P0/P1 问题；每项有 scheduler / trace / push 或明确 skip 证据，且日复盘必须存在 `reviews.save` 成功审计、发布产物与投递记录。
3. `npm run typecheck`、`npm test`、`npm run smoke:mcp-service-tools`、`npm run smoke:onboarding-draft-commit` 仍通过。
4. 先将验收结论写回本文件，再将候选分支 fast-forward 合入 `main`。

合入后，才决定是否推送远端、创建 PR 或部署火山云；这三项不由本地验收自动授权。

## 恢复指令

1. 读取本文件、`AGENTS.md`、`CLAUDE.md`，确认仍在 `codex/production-reconciliation-integration-20260722`。
2. 检查 `http://127.0.0.1:22655/health` 与 PM2 `invest-agent-codex` 状态；必要时使用 `local-runtime-restart`。
3. 先解决 scheduled daily-review 对 `reviews.save` 的可靠工具执行契约；禁止将 Agent 最终文本自动提升为完整报告作为绕过。
4. 修复后重新对该测试账号进行一次受控 `daily-review`，收集 scheduler、trace、`reviews.save` 审计、发布产物与 push 投递证据。
5. 更新本文件的验收结论，按“合入 main 的门槛”作出通过或修复决定；不要重新从火山云快照分支挑选或合并代码。
