# 发布记录：20260910T063117Z-da8df7a0

按 [release-governance-evidence-template.md](./release-governance-evidence-template.md) 口径记录。known-good 已标记（同日首个直接部署 20260910T061953Z-da8df7a0 同提交，见「发布执行」）。

## 变更摘要

```text
release_id: 20260910T063117Z-da8df7a0
commit: da8df7a09a812d9905c6eede5e1551573af54f6d（main，committed-local-main）
branch: main
date: 2026-09-10 14:19–14:33（北京时间，白天发布惯例）
owner: 用户授权（2026-09-10 对话：「deepseek更新模型到4.1了，你把本系统支持的deepseek模型更新到最新，把pro下线」）
agent 执行
change_type: code（模型链与计价注册表换挡，无安全面改动）
```

- 上游事实（官方文档检索 2026-09-10）：DeepSeek 发布 **V4.1-Flash**，官方新 ID 为 **`deepseek-flash`**（全模态文本+图片）；牌价输入峰2/闲1、输出峰8/闲4、缓存命中峰0.04/闲0.02（元/百万 tokens），峰谷窗口为**工作日** 9-12 / 14-18 点（周末恒空闲价）。旧 ID `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 仍可调用但上游已改路由至 4.1 并按 4.1 价计费；`deepseek-v4-pro` 上游 **2026-09-14 12:00** 退役后同样改路由。
- 链路换挡（`src/services/model-health.ts`）：文本/图片双链 deepseek 档换为 `deepseek-flash`；`deepseek-v4-flash-vision-exp` 降一位保留作**桥接兜底**——中转网关（newapi）尚未配 `deepseek-flash` 通道（实测 `No available channel`，503），探针失败 2 次即降级、自动路由落到旧 ID（上游同模型），零功能损失；通道就位后探针转绿自动换回。选择器（MODEL_DESCRIPTIONS）下架 vision-exp、上架 deepseek-flash。
- 计价注册表（`src/services/model-pricing.ts`）：新增 `deepseek-flash` 峰谷条目，新字段 `weekdaysOnly`（峰谷窗口仅工作日生效，`isBeijingPeakHour` 平移 8 小时后按北京星期判定；仅新条目启用，旧 deepseek 条目口径不变）。旧条目（v4-flash / v4-pro / vision-exp）保留原价仅供历史 trace 重算；pro 注记下线。桥接期落在旧 ID 的少量流量按旧价偏高估记（上游实收 4.1 价）。
- Portal：兜底清单（`apps/portal/src/lib/models.ts`）与选择器/用量页显示名同步——DeepSeek V4.1 Flash 上架（峰价 2/8 展示口径），v4-pro / v4-flash / vision-exp 下线；旧 ID 显示名保留在映射中供历史行渲染。
- 明确不影响的生产状态：`.env`、SQLite、Workspace、`reviews/`、`.state/`、微信状态零触碰；纯代码发布。

## 验证证据

| 门类 | 结果 | 证据 |
| --- | --- | --- |
| 确定性测试/类型检查/构建 | pass | 本地 `npm run verify`：660 测试 0 fail、agent-context、build、boundary 7/7；Portal typecheck + next build + 49 测试全绿；首个部署 RUN_SMOKE=true 远端 `npm test` 通过 |
| scope/权限/确认/revision/幂等 | n/a | 未动确认与写入路径 |
| 计价正确性 | pass | 新增用例：工作日高峰 ¥2/M、周末同时段空闲 ¥1/M、工作日晚间输出 ¥4/M、生效前走空闲价占位；summary 暴露 weekdaysOnly；旧条目既有用例原样通过 |
| 链路与健康门禁 | pass | 链路测试更新：glm→qwen→deepseek-flash→vision-exp（桥接）→doubao 逐级降级、exclude 跳选、选择器目录断言（deepseek-flash 在册、vision-exp 出册） |
| 错误终态、超时、取消、重试 | n/a | 未改终态机 |
| Trace 覆盖和秘密边界 | n/a | 无新增数据面 |
| Portal/微信/scheduler/automation 适用链路 | pass | 手动/自动选模型路径未动逻辑，仅清单与显示名；connector models.state 链路经 pricingSummary 透传 weekdaysOnly（消费方只读 peak/offPeak，无破坏） |
| 隔离行为评估与 Bad Case 回归 | pass | mastra-facade providerOptions 用例夹具更新，其余原样通过 |
| 故障演练 | pass | 回滚=`git revert da8df7a` 重新发布，或 `release:rollback 20260908T050221Z-b5f065c7` |

## 发布执行

- 首个部署 14:19–14:25：工作树干净（仅本次 8 文件、已全部提交）下直接 `deploy-volcano.sh`（RUN_SMOKE=true），release 20260910T061953Z-da8df7a0。为保 known-good 回滚链完整，同日又走标准快照流程从干净快照树重发同提交（20260910T063117Z-da8df7a0），两次内容零差异；known-good 标记在后者，旧档 20260906T034815Z-8790ecfb 按保留策略裁剪。
- 发布窗口核对：周四 14:19–14:33（A股午后盘中；重启仅数秒且无调度任务命中证据，connector 全部重连——若后续发现盯盘窗口缺失按巡查口径评估）。
- 重启时差现象：Portal connector socket error 若干行集中于 06:32:36-41Z 重启窗口，历次发布同现象，自愈。

## 发布后最小验收

1. `/health` 200、Portal `/api/health` 200 ✓；PM2 双进程 online、connector 全员重连（111/dyk/mg/mgreplay/primary）✓
2. dist 符号核验：`deepseek-flash` 在生产 model-health.js（×6）与 model-pricing.js（×2）✓
3. **探针实测**（手动触发两次，与调度器同路径）：glm 772ms ok / qwen 2358ms ok / vision-exp 689ms ok（桥接生效，底层已是 4.1）/ doubao 1752ms ok / **deepseek-flash 503 FAIL → consecutiveBad=2 已降级**，自动路由双链均落 glm-5.3-flash ✓（terra/luna 探针超时为存量现象，探针门禁本就将其挡在自动路由外，与本次无关）
4. release.json：20260910T063117Z-da8df7a0 @ da8df7a09a ✓

## 灰度与观测

- **外部依赖（owner 动作）**：newapi 网关给 default 组补 `deepseek-flash` 通道（上游 owned_by=deepseek 已就绪，旧 deepseek 通道的上游本就指向 4.1；如需 `-none`/`-max` 变体一并配置，配好后计价别名可随手补）。就位后无需再发版：探针转绿（最多 2 个周期，冷却 30 分钟 + 缓刑 2 好证据）`deepseek-flash` 自动恢复链位。
- 已知用户可见缺口：通道就位前**手动选** DeepSeek V4.1 Flash 会得到网关 503（手动选模型无回合内兜底）；自动路由不受影响（已降级挡住）。
- 计价口径：桥接期 vision-exp 流量按旧价（峰 3/9）记账，上游实收 4.1 价（峰 2/8），成本统计偏高估，属保守方向；通道就位、流量切到 `deepseek-flash` 后自然消解。
- 观察点（下次巡查顺带）：`deepseek-flash` 探针在通道就位后 2 个周期内恢复；`agent_traces` 出现 `model='deepseek-flash'` 行且计价 source=priced；pro 不再出现新流量（选择器已下线）。
- 回滚触发：4.1 通道就位后 deepseek 档出现系统性劣化（正确率/延迟回归）；回滚=`git revert da8df7a` 重新发布，或 `release:rollback 20260908T050221Z-b5f065c7 --confirm=rollback-code-v1`。
