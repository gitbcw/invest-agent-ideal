# 发布记录：T-595 空响应修复轮 + 失败复盘落稿补偿投递（2026-10-13）

- releaseId：`20261013T004105Z-edbebea4`，commit `edbebea`，installedAt 2026-10-13T00:42:45Z，known-good 已标记。
- 上一个生产部署：2026-10-12T02:48Z（`20261012T024626Z-ac034fe9`）。本次对生产的实质功能增量为 `ac034fe` 之后的 main 提交（即本提交）。

## 发布内容

1. **空响应修复轮（修一）**：generic automation run 抛 `MASTRA_EMPTY_RESPONSE` 且 `automation_tool_payloads` 有本 run 工具观测记录、剩余预算 ≥240s 时，回喂工作记录（≤60K）发起一次修复轮（message id `-empty-repair`），服务轨 allowlist 清空 + 提示词禁工具，只补最终提交；不重跑工具链，不触碰 agent.ts 兜底链的 `hasObservedToolCalls` 挡板。无记录/预算不足/修复轮再失败均维持原失败收口。
2. **落稿补偿投递（修二）**：run 判 failed 后反向检查 `hasReviewArtifactPublication`（claimedAt 后 reviews.save 落稿），命中则走成功路径同一 `deliverResult` 补发（正文优先已发布复盘 summary），run 状态保持 failed 不伪装成功；不限错误码（超时等失败形态同样适用），push 幂等键不变。
3. 新增 `tests/automation-empty-response-repair.test.ts` 7 例。

## 验证证据

- 本地：新测试 7 例全过；automation 域回归 68 例全过（generic-tasks / delivery-validity / summary-quality-floor / schema-contract）；typecheck 干净；snapshot 流程内含 build + boundary 7 项。
- 发布后验收：`/health` ok；PM2 双进程 online（invest-agent-mastra ↺134、mastra-portal ↺31）；Portal `/api/health`、`/login`、`/_next/static` 哈希资源均 200；「所有模块启动完成」+ 微信三实例 monitor started + Portal connector 全注册；重启点（00:42:45Z）后 app.log ERROR=0；生产 dist 实证含两处新逻辑（「空响应修复轮」×5、「落稿补偿投递」×3）；`smoke:mcp-service-tools` ok（tools=68）；活动 push job 仅 1 条 awaiting_user（微信窗口设计内挂起）。
- 根因定位备档：EMPTY_RESPONSE 原本就在 agent.ts autoRoute 兜底白名单内，被 `hasObservedToolCalls` 挡板精确放行——该挡板防换模型重跑复制工具链（正当），对「工具全部完成后未吐最终文本」形态误伤，本次在 runner 层修复而非放开挡板。

## 已知范围（如实标注）

- 修复轮模型行为未经真实生产验证：glm flash 在「基于工作记录补交最终 JSON」上的成功率未知；首验点为 10-13T09:30Z（mg 持仓复盘）/11:00Z（111 日报）/11:30Z（T-317）三个调度窗口，若复发 EMPTY_RESPONSE 应在 trace 中看到 `-empty-repair` 消息与「自动化空响应修复轮」warn 日志。
- 补偿投递首验点：任一复盘任务 run failed 但落稿存在的下一案例；日志特征「automation 落稿补偿投递」。
- 未随本次发布：MCP 30s 超时治理与大 schema 指令瘦身的因果专项（T-595 候选方向 c/d，继续挂账观察）；automation 自动链 flash 顺位调整（视修复轮上线后的复发频率再议）。

## 回滚

`npm run release:rollback -- 20261013T004105Z-edbebea4`（代码回退保留运行数据）。两修复均为纯代码路径，无数据迁移、无配置变更，回滚即恢复原语义。
