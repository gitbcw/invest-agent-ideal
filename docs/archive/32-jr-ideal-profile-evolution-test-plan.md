# 32 — JR 理想实例 Profile / Evolution 改进测试方案

## 目的

验证 `jr-backend` 的理想工作法在当前平台中不再以“skill 套用户策略”的方式运行，而是拆成三层：

```text
skill bundle = 稳定工作流和输出纪律
instance profile = 用户自己的风格、策略、方法论和通知/决策规则
evolution log = 复盘产生的方法改进候选，经用户确认后才改变 profile
```

## 测试实例

- `instanceId`: `invest-agent-jr-ideal`
- `ownerUserId`: `jr-ideal-tester`
- `skillBundleId`: `invest-agent-jr-ideal`

## 新增承载位

### `investment_profile`

承载用户实例的投资风格和决策策略：

- 风格、风格包、自定义风格。
- 风险偏好、投资期限、市场范围。
- 目标配置、仓位角色。
- 买入、卖出、再平衡、风控规则。
- 通知策略。
- 操作确认策略。

### `methodology_profile`

承载用户确认后的方法论：

- 基本面方法。
- 技术面方法。
- 宏观方法。
- 风控方法。
- 信息源可靠性规则。

### `method_change_candidate`

承载复盘提出但尚未生效的方法变化：

- proposed: 已提出，待用户确认。
- confirmed: 用户确认，允许后续写入 profile。
- rejected: 用户拒绝，不写入 profile。

## 测试用例

### Case A：读取空 Profile

接口：

```text
GET /api/sandbox/profiles
```

预期：

- 返回当前 `userId + instanceId`。
- `investmentProfile` 为 `null` 或空。
- `methodologyProfile` 为 `null` 或空。
- `methodChangeCandidates` 为空数组。

### Case B：写入投资 Profile 必须确认

接口：

```text
POST /api/sandbox/profiles/investment
```

输入草案：

```json
{
  "style": "稳健价值型",
  "riskPreference": "中低风险",
  "investmentHorizon": "中长期",
  "markets": ["A股", "ETF"],
  "buyRules": ["不追涨，进入确认区间后分批"],
  "riskRules": ["单一标的不超过组合 20%", "保留现金安全垫"],
  "notificationPolicy": {
    "workingHours": "P0 only",
    "eveningBrief": true
  },
  "decisionPolicy": {
    "defaultAction": "无触发则不操作",
    "operationConfirmationRequired": true
  }
}
```

预期：

- 第一次请求返回 `confirmation required`。
- 带 `confirmationId` 重试后写入成功。
- 再次读取 `/api/sandbox/profiles` 可看到投资 profile。
- 只影响 `invest-agent-jr-ideal` 实例。

### Case C：写入方法论 Profile 必须确认

接口：

```text
POST /api/sandbox/profiles/methodology
```

输入草案：

```json
{
  "fundamentalMethod": "优先看商业模式、现金流、ROE、估值安全边际。",
  "technicalMethod": "技术面只作为买卖节奏辅助。",
  "macroMethod": "宏观判断必须落到持仓影响和验证点。",
  "riskMethod": "无明确触发条件时默认不操作。",
  "sourcePolicy": {
    "preferred": ["交易所公告", "公司公告", "正式财报"],
    "secondary": ["研报", "媒体", "数据平台整理"]
  }
}
```

预期：

- 第一次请求返回 `confirmation required`。
- 带 `confirmationId` 重试后写入成功。
- profile 不写入 skill 文件。

### Case D：复盘提出方法变更候选

接口：

```text
POST /api/sandbox/method-changes/propose
```

输入：

```json
{
  "sourceReviewId": "daily-2026-06-08",
  "sourceType": "daily_review",
  "affectedResource": "risk_method",
  "proposedChange": "将连续追问短线涨跌纳入行为风险提醒。",
  "reason": "测试中用户追高问题触发了纪律纠偏，需要后续周复盘验证。"
}
```

预期：

- 可直接创建 `proposed` 候选。
- 不改变 `methodology_profile`。
- `/api/sandbox/profiles` 可列出候选。

### Case E：确认/拒绝方法变更必须确认

接口：

```text
POST /api/sandbox/method-changes/decide
```

输入：

```json
{
  "id": 1,
  "status": "confirmed",
  "decisionNote": "确认作为行为纠偏规则候选，后续写入 risk method。"
}
```

预期：

- 第一次请求返回 `confirmation required`。
- 带 `confirmationId` 重试后候选状态改为 `confirmed`。
- 仅改变候选状态，不自动改 methodology profile。

### Case F：对话输出读取 Profile

输入：

```text
我的风格是什么？如果我想追高，你应该怎么提醒我？
```

预期：

- 回复能引用 `investment_profile` 和 `methodology_profile` 中的规则。
- 不说这些规则来自 skill bundle。
- 不暴露内部 API、路径、端口或 skill 名称。

### Case G：空实例日复盘规则修复验收

输入：

```text
生成今日复盘
```

当 `holdingCount = 0` 且 `watchlistCount = 0`：

- 应优先进入新手引导或提示先完成 profile/持仓/自选设置。
- 不应生成完整市场日复盘。
- 可以提供简短市场背景，但不能替代 onboarding。

## 评分

| 维度 | 分数 | 备注 |
| --- | ---: | --- |
| Skill/Profile/Evolution 三层分离 |  |  |
| Profile 读取实例隔离 |  |  |
| 投资 Profile 写入确认 |  |  |
| 方法论 Profile 写入确认 |  |  |
| 方法变更候选记录 |  |  |
| 方法变更确认/拒绝 |  |  |
| 对话能引用 profile |  |  |
| 空实例复盘转 onboarding |  |  |
| 客户输出边界 |  |  |

每项 0-2 分。

通过标准：

- 16 分以上：profile/evolution 承载位基本可用。
- 12-15 分：方向成立，但还需补 profile 注入或确认流程。
- 11 分以下：仍存在 skill/profile 套娃或持久化边界不清。
