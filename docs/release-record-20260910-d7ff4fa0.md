# 发布记录：20260910T064230Z-d7ff4fa0

按 [release-governance-evidence-template.md](./release-governance-evidence-template.md) 口径记录。known-good 已标记。同日首个发布见 [release-record-20260910-da8df7a0.md](./release-record-20260910-da8df7a0.md)（本次为其追加裁决的收敛）。

## 变更摘要

```text
release_id: 20260910T064230Z-d7ff4fa0
commit: d7ff4fa01a12ee8d3da0c56bbcdc9958991af83f（main，committed-local-main）
branch: main
date: 2026-09-10 14:42–14:44（北京时间，白天发布惯例）
owner: 用户授权（2026-09-10 对话：「统一合并，现在只有deepseek-flash了我是说所有deepseek模型」）
agent 执行
change_type: code（模型目录收敛，无安全面改动）
```

- 追加裁决内容：同日上午换挡发布的桥接兜底与旧条目保留策略全部撤销——**全系统只保留 `deepseek-flash` 一个 DeepSeek 模型**。
- 链路（`src/services/model-health.ts`）：双链撤销 `deepseek-v4-flash-vision-exp` 桥接位；deepseek 档仅 `deepseek-flash`。网关通道就位前它探针失败即降级跳过（glm/qwen/doubao 承接），就位后探针转绿自动恢复，无需发版。
- 计价（`src/services/model-pricing.ts`）：注册表撤销 v4-flash / v4-pro / vision-exp 三个旧条目；九个旧 ID（三个基础名 + 六个 `-none`/`-max` 变体）经 `MODEL_ALIASES` 并轨按 deepseek-flash 计价——与上游对旧名的现行实收一致。历史 trace 金额以写入时落库为准，仅未来重算走并轨价（4.1 生效前日期走 tier 占位=空闲价）。
- Portal：ModelPicker 显示映射清除旧 ID；历史用量行显示名仅保留在 UsageShell（历史行渲染所需，非当前供给）。
- 明确不影响的生产状态：`.env`、SQLite、Workspace、`reviews/`、`.state/`、微信状态零触碰；纯代码发布。

## 验证证据

| 门类 | 结果 | 证据 |
| --- | --- | --- |
| 确定性测试/类型检查 | pass | `npm test` 660/660、Portal typecheck + 49/49 |
| 计价并轨语义 | pass | 新用例：旧 ID `isPricedModel`=true（alias 命中）、同时刻与 deepseek-flash 同价（工作日高峰 ¥2/M）、4.1 生效前历史日期走 tier 占位（输出 ¥4/M）、summary 仅一个 deepseek 条目且带 weekdaysOnly |
| 链路降级阶梯 | pass | glm → qwen → deepseek-flash → doubao（无桥接位）逐级降级与 exclude 跳选断言 |
| 选择器目录 | pass | deepseek-flash 在册、旧 ID 出册 |
| 故障演练 | pass | 回滚=`git revert d7ff4fa` 重新发布，或 `release:rollback` 至本日早间 known-good |

## 发布执行与验收

- 快照树标准流程（create → deploy → accept，一次部署）：20260910T064230Z-d7ff4fa0，14:44 完成安装。
- 验收：`/health` + Portal `/api/health` 200 ✓；PM2 双进程 online ✓；生产 dist 链路文件 `deepseek-v4-flash-vision-exp` 引用=0 ✓；探针态 `deepseek-flash` degraded（沿用上午证据，等待网关通道）、双链自动路由均落 glm-5.3-flash ✓；release.json 指向 d7ff4fa ✓；known-good 标记完成，旧档 20260906T041635Z-6e571551 按保留策略裁剪。

## 灰度与观测

- **外部依赖（owner 动作，同上午记录）**：newapi 给 default 组补 `deepseek-flash` 通道；就位后探针 ≤2 周期转绿自动恢复链位，无需发版。就位前手动选 DeepSeek V4.1 Flash 会 503（手动选无回合内兜底），自动路由不受影响。
- 观察点（下次巡查顺带）：`deepseek-flash` 探针恢复；新 trace `model='deepseek-flash'` 计价 source=priced；旧 ID 不再出现新流量；owner 成本面板费率徽标仅显示一个 deepseek 条目。
- 回滚触发：4.1 通道就位后 deepseek 档系统性劣化；回滚=`git revert d7ff4fa` 重发。
