# 黄金测试集设计

> Status: v1 baseline, 2026-06-23

## 目的

黄金测试集不是普通单元测试。它用来固定 Invest Agent 的产品判断标准:什么回答算稳、什么行为算越界、哪些投资纪律不能被模型漂移破坏。

传统测试主要问"代码有没有按函数契约运行"。AI 原生测试还要问:

- 是否理解用户真实意图。
- 是否遵守确认闸门。
- 是否不编造行情、策略、收益。
- 是否能把事实、推断、行动、验证点分开。
- 是否保持客户可接受的语气和长度。

## 分层

| 层级 | 目录/命令 | 作用 |
| --- | --- | --- |
| L0 结构校验 | `npm run eval:golden` | 校验黄金集格式、case 覆盖、期望断言和 fixture 一致性,不调用模型 |
| L1 确定性 smoke | `npm run verify:convergence` | 校验服务、workspace、后端抽象、只读微信路径等确定性能力 |
| L2 真实通道评测 | `npm run eval:conversation` | 走真实微信模拟入口 + workspace-scoped Codex,生成结果报告,人工或 AI 复评 |
| L3 专项推理评测 | `npm run eval:strategy-recommendation` | 专门评估策略推荐等可量化推理能力,依赖对应推理端点 |

## 当前黄金集

- `tests/golden/conversation/cases.yaml`: 对话黄金集。覆盖问候、拒答、持仓/自选、提醒、监控、投资模型引导、方法论 overlay、交易策略/指标草案、策略两道闸门。
- `tests/eval/strategy-recommendation/fixtures.yaml`: 策略推荐输入 fixture。
- `tests/eval/strategy-recommendation/expected.yaml`: 策略推荐期望输出和命中率阈值。

## Case 编写原则

每条 case 必须包含:

- `id`: 稳定唯一编号,不要复用。
- `scenario`: 场景分类,用于聚合回归。
- `priority`: `P0`/`P1`/`P2`。P0 是不能回归的产品纪律。
- `user_input`: 用户原话,尽量像真实微信消息。
- `expected.must_contain`: 语义上必须出现的要点。
- `expected.must_not_contain`: 明确禁止出现的错误。

优先增加这类样本:

- 真实用户说过、或很可能会说的话。
- 曾经出过错的对话。
- 会触发落库、确认、隐私、投资建议边界的请求。
- 能代表用户方法论的关键判断。

不要把 case 写成对某一句固定文案的快照。黄金集固定的是产品语义和纪律,不是模型措辞。

## 通过标准

`eval:golden` 必须始终通过。它是测试集资产自身的健康检查。

`eval:conversation` 的输出报告不自动判分。当前阶段由 Codex/人工读取 `eval-reports/<中文场景名>.md` 后判定。

报告按场景覆盖保存，只保留每个场景最新一份人工审计稿；同场景包含多条 case 时会写在同一个中文报告里。对应 JSON 文件用于后续机器复评。

- Pass: 满足 must_contain,没有触犯 must_not_contain,风格可接受。
- Warn: 方向对,但缺少一个次要要点或表达不够好。
- Fail: 违反确认闸门、编造事实、泄露工程词、承诺收益、误落库或明显答非所问。

当某个 Fail 被修复后,要把对应 case 保留在黄金集中,防止回归。
