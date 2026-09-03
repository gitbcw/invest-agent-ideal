# 前沿参考：Evaluation-Driven Agent Engineering（2026-09）

状态：**参考资料，非执行规范**——owner 与 GPT 的对话整理（2026-09-03，GPT 自述查证 2026 年一线团队公开实践；引用链接来自原对话，未逐条复核）。与 [ai-application-operating-loop.md](./ai-application-operating-loop.md) 的关系：外部印证与深化素材——该对话结尾独立收敛出的九段环与本项目运营环一致，本文补充环上各段的前沿做法与本项目现状对照。

## 一、核心论断

> 行业前沿正在从「LLM Observability + Debug」走向「**Evaluation-Driven Agent Engineering**」：生产运行天然产生证据，真实失败经过诊断和归类后转化为 Eval，再用 Eval 驱动修复、回归验证和下一轮生产学习。

OpenAI 2026 公开的 Tax AI 案例已把链路完整跑通：**专家纠正 → production trace → failure grouping → eval target → Agent/Codex 调查 → targeted fix → regression eval → 再回生产**。

对已具备全量 trace 的系统，瓶颈从「看不见发生了什么」转移到「**如何从大量看得见的数据里发现值得解决的问题，并把解决过的问题变成长期能力**」。

## 二、六层参考架构

```text
                 Production
                     │
                     ▼
  1. Trace / Observability Layer    （context/model/RAG/tools/state/code version/output/latency）
                     │ failures / signals
                     ▼
  2. Failure Discovery              （user feedback / online graders / anomaly / errors / human correction）
                     ▼
  3. Diagnosis                      （evidence → hypotheses → experiments → first divergence → root cause）
                     ▼
  4. Findings / Case Corpus         （failure pattern / root cause / minimal reproduction / evidence）
                     │ promotion
                     ▼
  5. Eval System                    （Regression / Capability / Holdout；deterministic + LLM + human graders）
                     │ CI / experiment
                     ▼
  6. Improvement Loop               （diagnose → change → eval → deploy → online eval → new evidence）
```

与传统「Log → Debug → Fix」是不同工程范式。

## 三、失败知识体系：Instance → Finding → Eval Cases 三层

**过滤漏斗**（不要把所有 trace 变成 case）：100,000 traces → 5,000 看似有问题 → 500 值得调查 → 80 真实产品缺陷 → 15 个重复 Failure Pattern → **约 3 个值得形成新 Eval 能力**。

OpenAI Tax AI 的关键中间环节不是「Correction → Eval」直连，而是：Correction → 捕获差异 → **分离 actionable failure 与 workflow noise** → 分组 → 识别重复 pattern → eval target。中间的关键概念是 **Finding**：

- **Level 1 · Failure Instance**：一次真实失败（某个 trace 里「用户要求重查订单，Agent 直接用昨天历史状态回答」）。
- **Level 2 · Finding（可泛化 Failure Pattern）**：诊断后收敛，如 `STALE_CONTEXT_BYPASSES_FRESH_TOOL_CALL`——History 含旧 Tool Result 时 Agent 视其为当前事实，跳过 freshness-required 调用；标注 root cause family、受影响工具、触发条件、必需行为。Case 库真正该积累的是这个层级。
- **Level 3 · Eval Cases**：从 Finding 生成一组用例，**正例与反例都要有**（Anthropic 强调 balanced problem sets——只测「该搜索时搜索」会把 Agent 优化成「什么都搜索」）：旧状态存在→须重查；「重新查」→须重查；历史与实时冲突→信实时；查历史订单→**不应**误调实时工具。

## 四、三种 Eval Suite 与生命周期

| Suite | 回答的问题 | 来源 | 通过率特征 |
| --- | --- | --- | --- |
| **Regression** | 以前会的东西，现在还会不会 | 已解决的真实 case | 应接近 100% pass（目的是防复发） |
| **Capability** | Agent 现在还有什么不会 | 当前困难问题（复杂工具选择、长上下文 freshness、多方冲突、异常恢复、模糊意图） | 不应 100%——失去研发价值即无 hill to climb |
| **Holdout** | 在已知 case 上变强后，未见问题上真的变强了吗 | 保留集，**开发迭代时不得使用** | 防 case-library 过拟合（与 ML 训练集过拟合同构） |

漂亮的**毕业生命周期**：Failure → Finding → Capability Eval → 能力提升 → 稳定达标 → 毕业**进 Regression**。LangSmith best practices 建议同 training/validation/test 式切分与 dataset versioning。

## 五、评估什么：Outcome 优先，Trajectory 有条件

- **Outcome 优先评成功**：强 Agent 可能找到测试设计者未预想但完全有效的路径，强制精确 tool-call path 会误伤（Anthropic 明确提醒不要过度检查精确路径）。「说订好了」不算数，「数据库里 reservation EXISTS」才是 Outcome。
- **Trajectory 用于** Debug / Diagnose / Policy / 安全约束。
- **例外必须评 Trajectory**：用户要求不发邮件、最终也没发——但中途调用了 send_email 只是工具失败——Outcome 视角 PASS 却是严重失败。成熟做法是双 grader：**Outcome grader + Constraint grader**（不得改未授权字段、不得调 prohibited_tool、不得访问 restricted_data）。

## 六、三层 Grader（行业共识）

1. **Deterministic grader**：能写代码判断的尽量不让 LLM 判断（JSON/schema/tool called/DB updated/file exists/citation exists）——快、便宜、稳定、易 debug；
2. **LLM-as-Judge**：helpfulness、instruction following、reasoning quality、tone、semantic correctness——需要 rubric 与人类校准；
3. **Human / Expert**：gold standard、ambiguous cases、calibration、高风险场景、judge 分歧仲裁。

## 七、Multi-Trial Reliability：随机系统不能只跑一次

Eval 基本单位从「Task → one run」变成「Task → Trial 1..N → **reliability distribution**」。「旧 17/20=85% → 新 20/20=100%」比「旧 fail → 新 pass」有价值得多。关心的不是 Pass/Fail，是 **Reliability**。

## 八、Harness：Eval 对象是整个系统配置

Agent 表现 ≠ 模型表现，而是 Model + Prompt + Tools + Context management + Memory + Retry + Control logic + Budget + Environment = **Evaluated System**（OpenAI 称周围这套为 harness；长程任务中 harness 差异可显著改变测得能力）。正确的表述不是「GPT-X = 82%」，而是「**系统配置 X 在 harness Y、工具集合 Z、预算 B 下 = 82%**」。

## 九、Offline + Online 双循环

- **Offline**（发布前）：Dataset → candidate → run → graders → 对比 baseline → release gate；用于 regression、benchmark、模型/提示词/架构变更。
- **Online**（发布后）：Production trace → online evaluator → 质量/异常/安全信号 → interesting trace → 人工/诊断 → **成为新的 offline case**（LangSmith、Braintrust 已收敛此生命周期）。

```text
        ┌──────── Offline Eval ◄────────┐
        │                               │
     Change                          New Case
        │                               ▲
        ▼                               │
      CI Gate                           │
        ▼                               │
   Production → Online Eval → Diagnosis
```

## 十、Diagnosis Layer 恰是行业缺口

行业工具已较成熟地解决 **Trace** 和 **Eval**，但「**Trace → Root Cause 的智能诊断协议**仍未标准化」——工具能告诉你得分低、调了什么工具、context 是什么，**为什么失败**仍靠工程师读 trace 凭经验调查。Observed Facts → First Divergence → Competing Hypotheses → Highest Information Gain Experiment → Belief Update → Causal Confirmation 这套协议，是现有 Observability/Eval 工具链中间缺失的一层（本项目 ai-application-diagnosis skill 所在位置）。

## 十一、Eval Factory 概念

从 Diagnosed Case 到 Eval 的专门流水线：是否值得 Eval？→ 抽取 Minimal Reproduction → 定义 Success Criteria → 设计 Grader → 生成正例 → 生成反例 → 生成边界变体 → 重复 Trial → **验证 Eval 本身** → 分配到 Capability / Regression / Holdout。比单纯一个 Case Management 强得多。

## 十二、本项目现状对照（2026-09-03，源自原对话评估）

| 能力 | 本项目方向 | 前沿实践 |
| --- | --- | --- |
| Full tracing | 已有 | 已成主流 |
| Context/tool/state trace | 已有 | 正在标准化 |
| Hypothesis-driven diagnosis | 正在做 | 尚未完全标准化（缺口即机会） |
| Failure case corpus | 正在构思（failure-taxonomy v1 已立） | 前沿团队已有 |
| Production failure → Eval | 已想到（rubric/ED 计划） | 明确前沿实践 |
| Failure clustering | 还应加入 | 很重要 |
| Regression suite | 应加入 | 主流最佳实践 |
| Capability suite | 应加入 | 前沿最佳实践 |
| Holdout benchmark | 应加入 | 成熟评估必需 |
| Multi-trial reliability | 应加入 | Agent eval 关键 |
| Online evaluation | 可加入 | 主流方向 |
| Eval-driven CI/CD | 可加入 | 成熟团队方向 |

## 十三、原对话给出的建议（外部建议，未裁决）

1. 体系从「Observability/Diagnosis/Case Management 三 skill」升级为五块：Infrastructure（Trace）/ Intelligence（Diagnosis）/ Knowledge（Failure Finding Registry）/ Evaluation（Eval Factory：Capability+Regression+Holdout）/ Operations（Offline Eval、CI Gate、Online Eval、Human Review）；
2. 把原设想的 Case Management skill 重写为 **`failure-to-eval` skill**：规定 Diagnosis 完成后 case 如何进入 Finding Registry、满足什么标准晋升为 Eval；
3. 问题本身的升级：从「AI 应用怎么 Debug」→「**如何设计一个能从真实失败中持续学习、持续验证、同时不因局部修复而退化的 AI 软件工程系统**」——2026 Agent 工程最前沿问题之一。

## 参考来源（原对话引用，未逐条复核）

- OpenAI · Building self-improving tax agents with Codex — https://openai.com/index/building-self-improving-tax-agents-with-codex/
- OpenAI Agents SDK · Tracing — https://openai.github.io/openai-agents-python/tracing/
- Anthropic · Demystifying evals for AI agents — https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- LangChain Docs · Evaluation concepts — https://docs.langchain.com/langsmith/evaluation-concepts
- OpenAI · A shared playbook for trustworthy third party evaluations — https://openai.com/index/trustworthy-third-party-evaluations-foundations/
- Braintrust · Score production traces — https://www.braintrust.dev/docs/evaluate/score-online
