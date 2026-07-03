# Invest Agent 可评测性体系设计

> Status: current direction, 2026-07-02

## 背景

Invest Agent 当前已经有单元测试、smoke 脚本、收敛检查、对话黄金集、策略推荐评测和 Platform 黄金数据集页面。但这些资产的层级边界还不够清晰:一些本该程序化验证的链路样本进入了黄金集,一些语义回归样本被当成人工审查对象,人工页面也容易变成 case 清单浏览器。

当前需要收敛的是整套可评测性体系,不是单独调整黄金数据集分类。

## 核心原则

1. 能程序化的必须程序化。
2. 不能稳定程序化、但能按标准语义判断的,进入 AI 评估。
3. 人工只处理标准校准、疑难裁决和高价值产品取舍。
4. 黄金样本不是所有 case 的集合,而是 AI 语义评测里的高权重产品标准样本。
5. Platform 不应默认让人浏览全部 case,而应展示评测结果、待审项和失败原因。

## 三层评测架构

| 层级 | 名称 | 目标 | 主要执行者 | 当前资产 |
| --- | --- | --- | --- | --- |
| L1 | 程序化评测 | 验证确定性代码、状态机、API contract、格式、权限和硬红线 | Node test / smoke scripts | `npm run test`, `smoke:*`, `verify:convergence`, `eval:golden` |
| L2 | AI 语义评估 | 跑真实或模拟对话输出,由 AI judge 按 rubric 判定 pass/warn/fail | ACP backend + AI judge | `tests/golden/conversation/cases.yaml`, `npm run eval:conversation` |
| L3 | 人工审核 | 校准标准、处理 AI judge 不确定项、确认产品取舍 | 人 | Platform 评测工作台、审计报告 |

## L1: 程序化评测

程序化评测负责所有确定性能力。只要可以用代码稳定判断,就不应留给 AI 或人工。

应放入 L1 的能力:

- YAML/JSON 格式、字段完整性、唯一 ID、schema 合法性。
- 工具入参、API 返回结构、数据库落库、状态机流转。
- pending confirmation 的创建、消费、取消和跨会话隔离。
- watch-rule catalog、rule dry-run、scheduler 抢锁、push queue 状态。
- sandbox token、权限、审计记录和隔离边界。
- 客户输出硬红线,如 `localhost`、`token`、内部路径、API 路径、ACP/Codex 工程词泄露。
- 数据源 telemetry、fallback、freshness、confidence、degraded-source alert。

当前命令归位:

| 命令 | 层级 | 职责 |
| --- | --- | --- |
| `npm run build` | L1 | TypeScript 编译和 dist 产物健康 |
| `npm run test` | L1 | store、calendar、method-change 等单元/集成测试 |
| `npm run eval:golden` | L1 | 只校验评测资产结构,不评模型输出 |
| `npm run verify:convergence` | L1 | 聚合架构边界和链路 contract |
| `npm run smoke:*` | L1 | 对应服务能力的确定性 smoke |

设计约束:

- `smoke` 样本不应作为人工黄金样本展示。
- 如果某个对话 case 只是在验证落库/状态机/禁词,应下沉为 L1 测试。
- L1 失败不进入 AI judge,应直接修代码或修 contract。

## L2: AI 语义评估

AI 语义评估负责模型输出质量。它不判断数据库是否真的写入,而判断最终用户回复是否符合产品语义和投资纪律。

标准流程:

1. 选择 case 集合和目标运行通道。
2. 通过真实入口或模拟入口跑出 `actual_output`。
3. 将 `user_input`、`expected rubric`、`actual_output`、必要上下文交给 AI judge。
4. AI judge 输出结构化结论: `pass` / `warn` / `fail` / `unknown`。
5. 只把 `warn`、`fail`、`unknown` 和新核心样本提交给人工。

AI judge 适合判断:

- 是否理解用户真实意图。
- 是否遵守确认闸门。
- 是否把事实、推断、行动、验证点分开。
- 是否没有编造行情、策略、收益或主力控盘结论。
- 是否没有把工具原始列表当作最终回答。
- 是否符合投资助手的谨慎、直接、可操作语气。
- 复盘、选股、方法论、策略草案是否符合当前产品标准。

L2 case 元数据建议:

```yaml
id: alert-price-draft-001
eval_layer: semantic_ai
case_purpose: product_gold
automation_status: ai_judged
domain: alert
priority: P0
user_input: 赛轮轮胎涨到 13 块提醒我
rubric:
  must:
    - 形成提醒草案
    - 明确价格达到或高于 13 元
    - 要求用户确认后才写入
  must_not:
    - 直接落库
    - 误解为 13 日均线
```

当前 `tests/golden/conversation/cases.yaml` 应逐步从 `review_tier` 迁移到更清晰的四个字段:

| 字段 | 作用 |
| --- | --- |
| `eval_layer` | 归属 L1/L2/L3 中哪一层,如 `semantic_ai` |
| `case_purpose` | 样本目的,如 `product_gold` / `regression` / `principle_probe` |
| `automation_status` | 自动化状态,如 `ai_judged` / `manual_only` / `should_move_to_code` |
| `domain` | 业务域,如 `alert` / `portfolio` / `review` / `screening` |

## L3: 人工审核

人工审核不是全量 case 浏览,而是标准校准和裁决。

人工应该看:

- AI judge 判为 `warn` / `fail` / `unknown` 的输出。
- 新增或修改的 `product_gold` 样本。
- 涉及产品定义变化的样本,如是否允许某种投资建议表达。
- AI judge 和人类直觉明显冲突的样本。

人工不应该常规看:

- 已通过的 L1 程序化测试。
- 所有历史回归样本。
- 只验证链路活着的 smoke 样本。
- 可以通过禁词、schema、状态机直接判断的 case。

Platform 页面应演进为评测工作台:

| 区块 | 展示内容 |
| --- | --- |
| 程序化检查 | 最近一次 L1 命令状态、失败命令、失败摘要 |
| AI 评估 | pass/warn/fail/unknown 数量、失败分布、AI judge 摘要 |
| 人工待审 | 只展示 warn/fail/unknown、新核心样本和标准变更样本 |
| Case 库 | 作为检索和编辑入口,不作为默认审查入口 |

当前 Platform 评测工作台还提供三类动作能力:

- 人工待审决策:对单个待审项标记 `accept_judge` / `override_pass` / `override_fail` / `needs_fix` / `move_to_l1` / `update_case`,结果落盘到 `eval-reports/_review-decisions.json`。
- 候选 case 草稿:从日志审计中的真实对话生成候选样本,结果落盘到 `eval-reports/_candidate-cases.json`,后续再人工整理进正式 `cases.yaml`。
- 运行命令生成:按 judge、priority、case id、scenario 生成 `npm run eval:conversation` 命令;工作台暂不直接启动长跑任务。

## 当前资产归位

| 当前资产 | 目标归属 | 说明 |
| --- | --- | --- |
| `tests/golden/run.mjs` | L1 | 结构校验器,名称可保留,但职责是评测资产 lint |
| `tests/golden/conversation/cases.yaml` | L2 | 对话语义评估 case 库,不等于整套黄金体系 |
| `tests/conversation-eval/run.mjs` | L2 | 应升级为跑 case + AI judge + 产出评测报告 |
| `tests/eval/strategy-recommendation/*` | L2/L1 混合 | 输入 fixture 是 L1 资产,推荐质量可由 AI 或指标评估 |
| `scripts/*-smoke.mjs` | L1 | 确定性链路 smoke,不进人工黄金页面 |
| Platform `#golden` | L3 入口 | 应从 case 浏览器演进为评测工作台 |

## 迁移计划

### 阶段 1: 概念收敛

- 保留 `review_tier`,但文档明确它只是过渡字段。
- 在 `docs/quality/golden-test-set.md` 中引用本设计,避免黄金集继续承担全部评测概念。
- Platform 页面文案从"黄金数据集"逐步改为"评测工作台"或"语义评测"。

### 阶段 2: L2 AI Judge

- 为 `tests/conversation-eval/run.mjs` 增加可替换 judge 层。
- `--judge=static` 基线:用 `must_contain`、`must_not_contain`、全局禁词和运行错误产出结构化 verdict。
- `--judge=model` 调用本地 provider 配置,默认使用 DeepSeek `deepseek-v4-flash`;未配置模型或 API key、模型调用失败、JSON 解析失败时输出 `unknown` 并进入人工待审。
- 后续可替换或新增模型 judge,但保持相同结果结构。
- 输出结构化 JSON: case id、actual output、judge verdict、reason、violated rubric。
- 生成面向人工的 Markdown 摘要 `eval-reports/_review-queue.md`,只列 warn/fail/unknown。
- 生成机器可读队列 `eval-reports/_review-queue.json`,供 Platform 评测工作台读取。
- Platform 读取最近评测队列,默认展示待审项而非全部 case。
- Platform 的人工处理结果单独保存在 `_review-decisions.json`,不直接改写 judge 原始结果。

Judge contract 由 `tests/conversation-eval/judge-contract.mjs` 承载。模型 judge 不允许调用工具、访问 workspace 或补充市场事实;它只能基于 case、rubric、actual output 和 quality gates 给出结构化裁判结果。推荐配置:

```bash
EVAL_JUDGE_PROVIDER=deepseek
EVAL_JUDGE_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=...
```

如果未显式设置 `EVAL_JUDGE_PROVIDER` / `EVAL_JUDGE_MODEL`,评测脚本会优先使用 `.env` / `.hermes/.env` 中的 DeepSeek 配置,并默认落到 `deepseek-v4-flash`。也可以使用通用 `EVAL_JUDGE_API_KEY` 覆盖 provider API key。

### 阶段 3: Case 元数据重构

- 将 `review_tier` 迁移为 `eval_layer`、`case_purpose`、`automation_status`、`domain`。
- 将 `smoke` case 移出 conversation golden,改为 L1 smoke 或删除。
- 将能程序化的 regression 下沉为测试脚本。
- 将同一能力的近似问法合并为主 case + edge case。

### 阶段 4: CI/本地运行策略

- 每次代码改动至少运行相关 L1。
- 改 prompt、skills、ACP 路径时运行 L2 目标子集。
- 合并前只要求人工处理 L2 的 warn/fail/unknown。
- 完整人工回归只在产品标准变化或大版本发布前执行。

## 运行策略

| 变更类型 | 必跑 | 选跑 |
| --- | --- | --- |
| TypeScript 服务代码 | `npm run build`, 相关 `npm run test` 或 `smoke:*` | L2 相关 case |
| scheduler / push / rule alert | `smoke:stage1-scheduler`, `smoke:stage2-watch-rules` | market-watch 语义评估 |
| customer output sanitizer | `smoke:customer-output` | L2 红线 case |
| AGENTS.md / workspace skills | `eval:golden` | L2 golden_core + principle_probe |
| review / screening / strategy prompt | L2 对应 domain case | L3 人工审核 warn/fail |
| Platform 页面 | `npm run build` | 浏览器人工验收 |

## 成功标准

- 人工默认不再需要浏览 40+ 条 case。
- L1 能拦截所有确定性 contract 回归。
- L2 能为每条语义 case 生成结构化 verdict。
- L3 页面默认只展示需要人处理的少量项。
- 新增 case 时能明确回答:这是程序化测试、AI 语义评估,还是人工校准样本。
- `golden_core` 数量保持少而稳定,不会重新膨胀成全部 case 列表。

## 非目标

- 不追求一次性把所有历史 case 改完。
- 不把 AI judge 结论视为绝对真理。
- 不让 Platform 替代命令行测试和 CI。
- 不把投资收益、胜率或交易结果作为评测目标。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| AI judge 自身漂移 | 固定 judge rubric,保留人工校准集,记录 judge 模型和版本 |
| Case 元数据过度复杂 | 先保留 `review_tier`,新字段分阶段引入 |
| 程序化测试不足导致 L2 背锅 | 每次 L2 fail 先判断是否应下沉为 L1 |
| 人工页面继续变成 case 列表 | Platform 默认展示评测结果和待审项,Case 库只作为次级入口 |

## 执行交接

Executor prompt:

```markdown
按 docs/quality/evaluation-system-design.md 推进阶段 1 和阶段 2。先不要大规模重写 case 内容。目标是让现有黄金集文档引用新三层评测体系,并为 tests/conversation-eval/run.mjs 设计/实现 AI judge 输出结构。保持 L1 程序化测试和 L2 语义评估边界清晰。
```

Reviewer prompt:

```markdown
审查执行结果是否符合 docs/quality/evaluation-system-design.md。重点看:是否把可程序化检查继续留给 L1,是否避免人工默认浏览全部 case,是否为 L2 AI judge 产出结构化 verdict,是否没有把 smoke 样本继续包装成黄金核心。
```
