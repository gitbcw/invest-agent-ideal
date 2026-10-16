# 发布记录：T-595 后续——automation 通道退出 partial 叙述降级（2026-10-16）

- releaseId：`20261016T020758Z-7eda0aee`，commit `7eda0ae`，installedAt 2026-10-16T02:09:44Z，known-good 已标记（acceptedAt 02:10:06Z）。
- 发布过程备档（如实）：先以 `deploy-volcano.sh` 直发同 commit（`20261016T015807Z-7eda0aee`，02:02:21Z 安装并完成验收），随后补走官方 snapshot 台账对同 commit 幂等重发（`release:snapshot create` → `release:deploy`），服务器 release.json 终态为 snapshot ID。两次安装内容完全相同（同一 commit、均含 dist 实证）。
- 上一个生产部署：2026-10-13T02:02Z（`20261013T020148Z-5a20a61c`）。本次对生产的实质功能增量为 `5a20a61c` 之后的 main 提交（即本提交）。

## 发布内容

1. **automation 通道退出 partial 叙述降级（修三，方向 A）**：`agent.ts` 的空响应/超时残留叙述判定抽为 `isPartialTextUsableReply`，channel=automation 一律不可用——此前汉字占比 ≥30% 的工具期叙述会被当作「阶段性回复」以 success 形态返回（executionStatus=partial），吞掉 `MASTRA_EMPTY_RESPONSE`，generic runner 误判主轮成功、空响应修复链（`-empty-repair`，回喂工具工作记录）永不触发，只能走看得见叙述散文的旧验证修复轮（`-repair`）。会话通道（web/weixin 等）阶段性回复语义不变。
2. **`-empty-repair` 提示词新增【补交列数要求】**：appendRows 每行必须恰好 columnCount 列、严格按 header 列序，已删除/停用/不适用列也必须占位（可填空串或「不适用」），不得因列语义省略整列。
3. 新增测试 2 例（T-317 回归：automation+中文叙述必须判不可用；提示词契约），`automation-empty-response-repair` 共 8 例。

## 根因备档（生产只读取证，2026-10-16）

T-317（mg 行业复盘，17 列含「已删除：公司涨幅(%)」墓碑列）10-13/14/15 三天修复轮 trace 消息 ID 后缀均为 `-repair`，从未走过 `-empty-repair` 新链；10-13 巡查报告「补交轮未携带表头」的归因不成立（`-repair` 提示词中 spreadsheetContext 一直含完整 17 列表头）。真实链路：主轮 EMPTY → partial 降级截胡（叙述汉字占比 ≥30%）→ runner 视为主轮成功但无 stagedOutput → 旧 `-repair` 轮回喂叙述散文 → 模型从散文重建 17 列（10-14 成功轮墓碑列填字面量「已删除」；10-13/15 均为 16 列且列对位错乱）→ commit 列数校验拒。mg 持仓复盘走新链纯因叙述为英文（占比 <30%）→ 判不可用 → 返回 failed → 新链捕获。走哪条链取决于叙述语言占比，纯偶然。

## 验证证据

- 本地：新测试 2 例 + `automation-empty-response-repair` 8/8；回归 automation-generic-tasks / delivery-validity / summary-quality-floor / schema-contract 68/68；portal-empty-response-degradation / agent-instructions 7/7；typecheck 干净；snapshot 流程内含 `npm run verify`（全量测试 + agent-context + build + boundary 7 项）。
- 发布后验收（02:09:44Z 重启点）：`/health` ok；PM2 双进程 online（invest-agent-mastra ↺137、mastra-portal ↺31）；Portal `/login`、`/api/health` 均 200；微信三实例 monitor started；重启点后 app.log ERROR=0；生产 dist 实证含两处新逻辑（【补交列数要求】×1、isPartialTextUsableReply×3）；PM2 无残留 `CODEX_*` 覆盖；`smoke:mcp-service-tools` ok（tools=68）。
- 部署窗口核对：两次重启前自动化在途 run 均为 0。

## 已知范围（如实标注）

- **新链首个 17 列案例未发生**：`-empty-repair` 链生产实证仅 mg 持仓复盘（10 列，3/3）与 mgreplay（2/2）；T-317 的 17 列重建成功率未知。首验点 2026-10-16T11:30Z（T-317 行业复盘，本地 19:30）——EMPTY 已连发 4 天，若复发应在 trace 中看到 `-empty-repair` 消息（而非 `-repair`）。
- scheduler 通道（market-watch 等在用）未纳入本次豁免：无取证支持其受害，且豁免会改变其 EMPTY 降级形态（有用户体验回归风险），如需覆盖另行立项。
- 未随本次发布：EMPTY 主轮根因专项（疑与 market-data 30s 超时/批量快败因果，FP-20260924-03 / FP-20261014-01，连续 4 天）；T-317 工作簿墓碑列清理（用户实例资产，需与 mg 确认）。
- 本地 main 领先 origin（push 为独立授权，未做）。

## 回滚

- 回退本发布（恢复上一 known-good）：`npm run release:rollback -- 20261013T020148Z-5a20a61c`。
- 未来发布故障时回退到本 known-good：`npm run release:rollback -- 20261016T020758Z-7eda0aee`。
- 纯代码路径，无数据迁移、无配置变更，回滚即恢复原语义。
