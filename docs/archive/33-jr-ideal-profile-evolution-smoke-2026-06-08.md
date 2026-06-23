# 33 — JR Ideal Profile / Evolution Smoke（2026-06-08）

## 范围

本次 smoke 只验证新增承载位和 sandbox 接口是否可用，不做完整对话质量评估。

测试服务：

- `PORT=22650`
- `INVEST_AGENT_SANDBOX_SECRET=jr-ideal-test-secret`
- `instanceId`: `invest-agent-jr-ideal`

## 结果

### 1. 空 Profile 读取

`GET /api/sandbox/profiles`

结果：

- `investmentProfile`: `null`
- `methodologyProfile`: `null`
- `methodChangeCandidates`: `[]`

结论：通过。

### 2. 投资 Profile 写入确认

第一次调用 `POST /api/sandbox/profiles/investment`：

- 返回 `confirmation required`。
- 生成 `confirmationId`。

使用同一 conversation 的新 token 带 `confirmationId` 重试：

- 写入成功。
- 返回 `style = 稳健价值型`。
- 返回 `markets = ["A股", "ETF"]`。
- 返回 `buyRules = ["不追涨，进入确认区间后分批"]`。

结论：通过。

注意：

- 同一个 token 立刻重试会被拒绝，原因是确认系统要求后一轮用户确认。
- 不同 conversation 的 token 也会被拒绝，原因是 conversation mismatch。
- 这符合确认安全模型，测试脚本必须模拟同一会话的下一轮确认。

### 3. 方法变更候选

调用 `POST /api/sandbox/method-changes/propose`：

```json
{
  "sourceReviewId": "daily-2026-06-08",
  "sourceType": "daily_review",
  "affectedResource": "risk_method",
  "proposedChange": "将连续追问短线涨跌纳入行为风险提醒。",
  "reason": "追高测试显示需要稳定纠偏规则。"
}
```

结果：

- 创建候选 `id = 1`。
- `status = proposed`。
- 再读 `/api/sandbox/profiles` 可看到候选。

结论：通过。

## 当前判断

新增 profile/evolution 承载位可以解决此前的“skill bundle 套用户策略”问题：

- skill bundle 保持稳定流程。
- `investment_profile` 承载用户风格策略。
- `methodology_profile` 承载用户确认过的方法论。
- `method_change_candidate` 承载复盘提出但尚未生效的方法改进。

下一步完整测试应按 [32-jr-ideal-profile-evolution-test-plan.md](./32-jr-ideal-profile-evolution-test-plan.md) 跑对话级验收，重点验证模型是否会主动读取 profile，并避免把用户策略当成 skill 内容。
