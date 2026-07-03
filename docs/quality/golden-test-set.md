# 黄金测试集设计

> Status: v1 baseline, 2026-06-23

> 当前评测体系源头见 [evaluation-system-design.md](./evaluation-system-design.md)。本文只描述对话语义 case 库和相关链路检查,不再承载完整可评测性架构。

## 目的

黄金测试集不是普通单元测试。它用来固定 Invest Agent 的产品判断标准:什么回答算稳、什么行为算越界、哪些投资纪律不能被模型漂移破坏。

传统测试主要问"代码有没有按函数契约运行"。AI 原生测试还要问:

- 是否理解用户真实意图。
- 是否遵守确认闸门。
- 是否不编造行情、策略、收益。
- 是否能把事实、推断、行动、验证点分开。
- 是否保持客户可接受的语气和长度。

## 三层评测位置

Invest Agent 的完整可评测性分为三层:

- L1 程序化评测:能用代码确定判断的 contract、状态机、权限、格式、禁词和 smoke。
- L2 AI 语义评估:跑出模型回复后,由 AI judge 按 rubric 判断 pass/warn/fail。
- L3 人工审核:只处理 AI judge 的 warn/fail/unknown、新核心样本和标准取舍。

本文件中的 conversation cases 主要属于 L2。`eval:golden` 只是 L1 结构校验,不是模型质量评测。

## 当前命令分层

| 层级 | 目录/命令 | 作用 |
| --- | --- | --- |
| L0 结构校验 | `npm run eval:golden` | 校验黄金集格式、case 覆盖、期望断言和 fixture 一致性,不调用模型 |
| L1 确定性 smoke | `npm run verify:convergence` | 校验服务、workspace、后端抽象、只读微信路径等确定性能力 |
| L2 真实通道评测 | `npm run eval:conversation` | 走真实微信模拟入口 + workspace-scoped ACP backend,生成结果报告,人工或 AI 复评 |
| L3 专项推理评测 | `npm run eval:strategy-recommendation` | 专门评估策略推荐等可量化推理能力,依赖对应推理端点 |

## 当前黄金集

- `tests/golden/conversation/cases.yaml`: 对话黄金集。覆盖问候、拒答、持仓/自选、提醒、监控、投资模型引导、方法论 overlay、交易策略/指标草案、策略两道闸门。
- `tests/eval/strategy-recommendation/fixtures.yaml`: 策略推荐输入 fixture。
- `tests/eval/strategy-recommendation/expected.yaml`: 策略推荐期望输出和命中率阈值。

## 审查分层

`cases.yaml` 里的 `category` 保留原始来源语义,`review_tier` 用于人工审查和 Platform 默认展示:

| review_tier | 含义 | Platform 默认 |
| --- | --- | --- |
| `golden_core` | 真正定义产品形态和投资纪律的少量核心样本 | 展示 |
| `regression` | 历史事故、误路由、确认态、上下文指代等回归样本 | 展示 |
| `principle_probe` | 验证 AGENTS.md / skills 原则是否被模型执行 | 默认隐藏 |
| `smoke` | 快速确认基础链路仍然可用 | 默认隐藏 |
| `archived_candidate` | 暂时不参与常规审查的候选/待合并样本 | 默认隐藏 |

不要把所有 case 都提升为 `golden_core`。黄金核心应少而稳定;事故修复后进入 `regression`;同一能力的相近问法优先沉淀为 edge case 或回归样本,不要稀释黄金核心。

## 链路与契约 Smoke

这些测试不需要放进 Platform 页面。它们是给 AI/开发流程使用的链路契约清单:当修改相关模块时,由 AI 根据变更范围选择运行,并总结结果。

| 命令 | 目的 | 何时运行 |
| --- | --- | --- |
| `npm run build` | TypeScript 编译与 dist 产物更新 | 任意后端或 Platform 页面改动后 |
| `npm run test` | Node test runner 下的基础单元/集成测试 | 修改 `tests/*.test.ts` 覆盖的 store、calendar、method-change 等逻辑后 |
| `node scripts/market-watch-schedule-contract-smoke.mjs` | 验证盯盘调度不会把 `trading_days_09:30...` 这类字符串误解析成分钟间隔 | 修改 scheduler、schedules loader、workspace schedules 模板或用户 schedules 后 |
| `npm run smoke:schedules-loader` | 验证 workspace `config/schedules.yaml` 的固定窗口、频率和开关字段能被服务端正确读取 | 修改 schedules schema、loader 或 onboarding 写入规则后 |
| `npm run smoke:stage1-scheduler` | 验证 `scheduled_task_runs` 抢锁、`push_jobs` 状态流转和定时推送基础契约 | 修改 scheduler、push queue、scheduled task run 记录后 |
| `npm run smoke:stage2-watch-rules` | 验证服务层 watch-rule catalog、创建、校验、dry-run、删除，以及 MACD/KDJ/RSI/BOLL/WR/量比等常见技术指标规则目录 | 修改 `src/services/watch-rules.ts`、`src/scheduler/alert-check.ts`、watch-rule API 或规则巡检文案后 |
| `npm run smoke:customer-output` | 验证用户输出清洗隐藏内部路径、接口、token 等调试信息,并保留 Markdown 表格 | 修改客户输出清洗、微信回复格式或入站/出站提示约束后 |
| `node scripts/push-routing-contract-smoke.mjs` | 验证主动推送按 `userId + instanceId` 路由,且用户等待复杂分析时调度推送会延后 | 修改微信路由、push queue、复杂任务占用标记后 |
| `npm run smoke:review-push-summary` | 验证复盘推送摘要的清洗与摘要形态 | 修改 review push、scheduled reply 清洗或复盘摘要格式后 |
| `npm run smoke:weixin-complex-ack` | 验证微信复杂任务 ACK / 后台处理的用户体验契约 | 修改微信消息桥、复杂任务识别或 ACK 文案后 |
| `npm run verify:convergence` | 聚合性收敛检查,确认当前架构边界没有明显回退 | 做运行时路径、workspace、prompt/context 相关收敛改动后 |

运行结果不需要人工在 Platform 页面逐条点。推荐流程是:AI 说明为什么选择这些测试,运行后只总结失败点、风险和下一步判断。若涉及用户实际对话或推送表现,再回到 Platform 的日志审计和黄金数据集页面一起看。

## Case 编写原则

每条 case 必须包含:

- `id`: 稳定唯一编号,不要复用。
- `scenario`: 场景分类,用于聚合回归。
- `priority`: `P0`/`P1`/`P2`。P0 是不能回归的产品纪律。
- `review_tier`: 人工审查层级,用于区分黄金核心、事故回归、原则探针和冒烟样本。
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

`eval:conversation` 会输出结构化 judge 结果。默认 `--judge=static` 使用 rubric 和全局禁词生成 `pass` / `warn` / `fail` / `unknown`; `--judge=model` 使用外部 AI judge。脚本会生成:

- `eval-reports/<中文场景名>.md`: 场景最新审计报告。
- `eval-reports/<中文场景名>.json`: 场景机器可读结果。
- `eval-reports/_review-queue.md`: 面向人工的待审摘要。
- `eval-reports/_review-queue.json`: Platform 评测工作台读取的待审队列。

Platform 的“评测工作台 / 人工待审”默认只展示 `warn` / `fail` / `unknown`。人工不需要逐条浏览全部 case;如果某个失败可以程序化判断,应下沉到 L1 测试或 smoke。

人工处理结果不会覆盖原始 judge 输出,而是追加写入 `eval-reports/_review-decisions.json`。从日志审计中发现的新样本会先写入 `eval-reports/_candidate-cases.json`,等人工整理后再进入正式 `tests/golden/conversation/cases.yaml`。

报告按场景覆盖保存，只保留每个场景最新一份人工审计稿；同场景包含多条 case 时会写在同一个中文报告里。对应 JSON 文件用于后续机器复评。

- Pass: 满足 must_contain,没有触犯 must_not_contain,风格可接受。
- Warn: 方向对,但缺少一个次要要点或表达不够好。
- Fail: 违反确认闸门、编造事实、泄露工程词、承诺收益、误落库或明显答非所问。

当某个 Fail 被修复后,要把对应 case 保留在黄金集中,防止回归。
