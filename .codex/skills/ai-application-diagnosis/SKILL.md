---
name: ai-application-diagnosis
description: >
  用于 AI 应用、Agent、RAG、Tool Calling、工作流编排及传统程序混合系统的
  故障诊断、问题分析、根因定位和修复决策。
  核心目标不是按照固定顺序检查模块，而是通过竞争性因果假设和最小验证实验，
  持续降低问题的不确定性。
---

# AI Application Diagnosis Skill

## 1. Purpose

本 Skill 用于处理 AI 应用中的复杂问题，包括但不限于：

* 模型输出错误、异常或不稳定
* Agent 行为不符合预期
* Tool 未调用、误调用或调用失败
* RAG 检索、引用、召回或上下文异常
* Prompt / System Prompt / History / Memory 问题
* 程序逻辑、状态管理、工作流编排问题
* 模型与程序边界上的交互问题
* 偶现问题、难以复现问题
* 多个组件共同导致的问题
* 表面看似属于某一层，但真实根因位于另一层的问题

本 Skill 的核心任务不是“尽快给出一个解释”。

核心任务是：

> 以最低合理成本，最大速度降低关于故障根因的不确定性。

---

# 2. Core Principle

面对复杂 AI 系统：

> 不预设根因。
> 不机械按照固定模块顺序排查。
> 根据当前证据建立多个竞争性因果假设，
> 选择信息增益最高的最小实验，
> 根据实验结果更新判断，
> 直到问题空间收敛。

因此：

**Debug 的基本单位不是“检查一个模块”，而是“验证一个因果假设”。**

---

# 3. Important Prior

AI 应用与传统软件存在一个重要差异：

Context、Prompt、Model Behavior、RAG、Memory、Tool Result 等因素，
是传统软件 Debug 方法容易低估的新故障域。

因此：

> 在证据不足时，可以提高 Context / Model Interaction 类问题的先验权重；
> 但不得把 “Context First” 当成固定排查流程。

Context First 是 heuristic。

Evidence First / Hypothesis Driven 才是更高层原则。

---

# 4. Mental Model

分析 AI 应用时，不要默认系统是：

Input → Program → Output

应默认它更接近：

Environment
↓
Program / Orchestration
↓
Context Construction
↓
Prompt + History + Memory + Retrieval + Tool Definitions
↓
Model
↓
Model Decision / Generation
↓
Tool / External System
↓
State Change
↓
Program
↓
Next Context
↓
Model
↓
Final Behavior

这些组件之间存在循环、反馈和交互作用。

因此一个故障不能仅仅因为“表现发生在某一层”，就被归因到这一层。

---

# 5. Fundamental Rules

## Rule 1 — Separate Facts From Interpretations

始终明确区分：

**Observed Facts**
实际日志、输入、输出、状态、trace、异常。

**Inference**
根据事实推断出的可能解释。

**Hypothesis**
可以被验证或证伪的因果解释。

禁止把推测描述成事实。

例如：

错误：
“模型没有理解工具说明。”

正确：
“模型没有产生 tool call。当前尚不能确定原因可能是工具说明、上下文、模型决策还是 orchestration。”

---

## Rule 2 — Never Diagnose From Intended Context

不要只查看：

* Prompt 模板
* 源代码中的 System Prompt
* 理论上的 message history
* 理论上的 Tool Schema

优先查看：

> **运行时模型真正收到的完整 Context。**

包括实际：

* system messages
* developer instructions
* user messages
* conversation history
* memory
* retrieved documents
* tool definitions
* tool results
* truncation 后内容
* serialization 后内容
* runtime variables

“我们打算给模型什么”与“模型实际上看到什么”是两个不同的问题。

---

## Rule 3 — Maintain Multiple Competing Hypotheses

在原因明显以前，不要只保留一个解释。

通常维护 3–7 个最有解释力的候选假设。

常见故障域包括：

**Context**
上下文缺失、污染、冲突、顺序、截断。

**Instruction**
Prompt 模糊、冲突、优先级错误。

**Model**
能力边界、随机性、策略选择、模型版本差异。

**Program / Orchestration**
条件判断、状态机、生命周期、异常处理、序列化。

**Tool / API**
Schema、调用参数、返回值、权限、失败处理。

**Data / RAG**
召回错误、排序错误、数据过期、embedding / indexing 问题。

**State / Memory**
缓存、会话状态、长期记忆、状态同步。

**Environment / Configuration**
模型版本、参数、部署配置、依赖版本、环境差异。

**Interaction / Boundary**
两个单独正常的组件，在接口或组合情况下产生错误。

不要强迫问题只能属于一个类别。

复杂问题可能存在：

A × B

甚至：

A × B × C

类型的交互因果关系。

---

# 6. First Diagnostic Question

遇到问题后，优先判断：

> 在尽可能冻结运行条件之后，问题是否稳定复现？

尽可能冻结：

* model/version
* temperature 等参数
* system prompt
* complete history
* retrieval result
* tool definitions
* tool outputs
* application state
* code version
* configuration
* external dependency responses

如果能够稳定复现：

优先寻找确定性因果链和边界条件。

如果不能稳定复现：

优先调查：

* 模型随机性
* Retrieval 波动
* 并发
* timing
* external API
* state
* cache
* 非确定性数据
* context 构造变化

不要把“不稳定”简单归因于“LLM 本来就随机”。

---

# 7. Diagnosis Loop

每次问题分析执行以下循环。

## Step A — Normalize the Symptom

首先把用户描述的问题转化为可观察事件。

不要使用：

“Agent 很笨。”
“模型没理解。”
“AI 不稳定。”

转换成：

“在条件 X 下，期望产生 ToolCall A，但实际产生文本输出 B。”

或者：

“相同输入运行 10 次，其中 3 次没有进入步骤 Y。”

问题必须尽量可以观察和验证。

---

## Step B — Locate the First Divergence

不要首先寻找“最终哪里坏了”。

寻找：

> **实际执行轨迹第一次偏离预期轨迹的位置。**

First Divergence 往往比最终异常位置更接近真正根因。

例如：

Final failure：
JSON parser error

实际 First Divergence：
模型输出开始出现 Markdown code fence。

或者：

Final failure：
Agent 没有完成任务。

First Divergence：
RAG 返回了错误版本文档。

---

## Step C — Generate Competing Hypotheses

根据现有证据建立候选解释。

每个假设至少包含：

Hypothesis：
可能发生了什么。

Mechanism：
它为什么能够产生当前现象。

Supporting Evidence：
目前哪些证据支持它。

Contradicting Evidence：
哪些证据不支持它。

Unknown：
目前缺少什么信息。

不要为了完整而生成大量低质量假设。

优先保留真正能够解释现象的少量竞争假设。

---

## Step D — Choose the Highest-Value Experiment

不要问：

“按照流程下一步应该检查什么？”

要问：

> “现在做哪个最小实验，能够一次最大程度区分这些假设？”

实验优先级考虑：

1. Information Gain
2. Cost
3. Speed
4. Reversibility
5. Risk
6. Ability to eliminate multiple hypotheses

优先做：

**低成本 + 高区分度 + 可逆**

的实验。

避免同时改变多个变量。

否则即使问题消失，也无法知道真正原因。

---

## Step E — Update Beliefs

每次实验结束以后，明确更新：

* 哪些假设变强
* 哪些假设变弱
* 哪些假设已经被排除
* 是否出现新的假设
* 当前最大的不确定性是什么
* 下一项最有价值的实验是什么

不要因为第一个实验符合预期就立刻宣布找到根因。

---

## Step F — Confirm Causality

只有满足足够因果证据以后才能称为 Root Cause。

优先寻找：

**Reproduction**
能够稳定制造问题。

**Intervention**
改变候选原因后，问题随之发生变化。

**Counterfactual**
恢复原条件以后，问题重新出现。

理想形式：

A 存在 → Failure

移除 A → Failure 消失

恢复 A → Failure 再现

这是比“看起来像原因”更强的证据。

---

# 8. Fast Path

Hypothesis Driven 不意味着所有问题都必须复杂分析。

如果存在明确直接证据，例如：

* syntax error
* stack trace 明确指向 null pointer
* API 明确返回 authentication failure
* Tool schema validation 明确失败
* database constraint 明确失败

可以直接进入对应路径。

但仍然需要问：

> 这个直接错误是 Root Cause，还是上游 AI 行为产生的结果？

例如：

JSON parser exception

可能只是直接故障。

真正 Root Cause 可能是：

Prompt 没有定义结构化输出契约。

---

# 9. Boundary-First Heuristic

AI 应用中应特别关注系统边界。

高风险边界包括：

Prompt → Model

Model → Parser

Model → Tool Call

Tool Result → Context

RAG → Context

Memory → Context

Program State → Prompt

Model Decision → Workflow State

External API → Agent

很多复杂 Bug 并不属于任何一个组件。

它属于：

> **两个组件之间隐含契约不一致。**

如果每个组件单独测试正常，而系统组合后失败，
优先检查 boundary / contract。

---

# 10. Issue Management Protocol

每个重要问题建立一个 Diagnosis Record。

记录：

## Symptom

观察到了什么。

## Expected Behavior

本来应该发生什么。

## Reproduction

如何重现。

## Runtime Snapshot

当时实际的模型、context、state、tools、data、config。

## First Divergence

执行轨迹第一次偏离预期的位置。

## Current Hypotheses

当前竞争性解释。

## Evidence

支持和反对各假设的事实。

## Experiments

已经执行过哪些鉴别实验。

## Current Best Explanation

当前最有可能的因果解释。

## Confidence

使用：

Low / Medium / High

避免没有数据支持的虚假精确概率。

## Next Best Experiment

当前信息增益最高的下一步。

## Root Cause

只有确认因果以后填写。

## Fix

最终修复。

## Prevention

以后如何降低同类问题发生概率。

## Observability Improvement

以后如何让同类问题更容易发现和定位。

---

# 11. Fixing Strategy

找到根因之后，不要只问：

“怎么修？”

需要分别考虑：

**Mitigation**
如何马上减少影响。

**Correction**
如何修掉当前问题。

**Prevention**
如何避免以后再次发生。

**Detection**
以后如何更早发现。

**Diagnosis Cost Reduction**
以后怎样让类似问题更容易定位。

好的 Debug 不只是修复一个 Bug。

它应该让：

> 下一次类似 Bug 更容易被理解。

---

# 12. Observability Requirements

如果系统缺少以下信息，应主动指出诊断能力不足：

* 完整模型输入
* 完整模型原始输出
* model/version
* prompt version
* retrieval result
* tool call
* raw tool result
* state transition
* latency
* retry
* token usage
* exception
* trace id
* code/config version

如果某一个关键变量不可观察：

不要假装知道发生了什么。

明确说明：

> 当前存在 observability gap。

并优先考虑补充可观察性是否比继续猜测更有价值。

---

# 13. Anti-Patterns

避免以下行为：

### Premature Root Cause

看到一个合理解释就宣布找到根因。

### Context-First Dogma

无论什么问题都机械先检查 Prompt / Context。

### Code-First Dogma

看到异常就默认程序错误。

### Model-Blaming

无法解释的问题全部归因于“模型随机”。

### Prompt-Blaming

所有 AI 行为问题都通过修改 Prompt 解决。

### Shotgun Debugging

一次修改多个参数然后重新运行。

### Fix Before Understand

还不知道为什么失败，就开始大规模重构。

### Log Interpretation Without Raw Data

只看摘要日志，不看原始输入输出。

### Component Isolation Bias

每个组件单独正常，就认为整个系统必然正常。

### Storytelling

根据有限证据构造一个听起来合理但没有实验支持的故事。

---

# 14. Agent Response Protocol

当被要求分析一个 AI 应用问题时，默认输出以下结构：

## Current Assessment

一句话描述当前问题空间。

## Known Facts

只列已经观察到的事实。

## First Divergence

如果已经能够确定，指出最早异常点。

## Competing Hypotheses

给出少量最重要的竞争性因果假设。

对每个假设说明：

* 为什么能够解释现象
* 当前支持证据
* 当前反对证据

## Highest-Value Next Experiment

只推荐当前最值得执行的实验。

说明：

* 操作
* 它可以区分哪些假设
* 不同结果分别意味着什么

## Current Confidence

说明当前判断置信度。

## Immediate Mitigation

只有存在必要且低风险的临时缓解措施时提供。

不得为了显得有答案而强行给出 Root Cause。

---

# 15. Asking Questions

不要一开始连续向用户索取大量信息。

首先利用已有：

* logs
* traces
* code
* prompts
* screenshots
* runtime data
* reproduction steps

形成初步问题空间。

如果必须向用户询问信息：

> 优先只问那个最能降低当前不确定性的关键问题。

问题的价值应以：

“回答以后能够排除多少候选解释”

来衡量。

---

# 16. Definition of Done

问题不能因为：

“现在似乎正常了”

就关闭。

理想关闭条件是：

1. 症状被清楚定义
2. First Divergence 被定位
3. Root Cause 有因果证据支持
4. Fix 已验证
5. Regression 已检查
6. 必要的 Prevention 已完成
7. 必要的 Observability Gap 已补充
8. Diagnosis Record 已留下足够信息供未来复用

---

# 17. Meta Principle

面对复杂 AI 应用时，始终记住：

> 我们管理的不是问题本身，而是关于问题的不确定性。

因此每一个分析动作都应该回答：

> 这个动作会不会显著减少我们对系统发生了什么的不确定性？

如果不会：

它很可能不是现在最值得做的事情。

---

# 18. Final Decision Rule

当多个调查方向同时存在时，不要问：

> “按照标准 Debug 流程，下一步是什么？”

而要问：

> **“基于当前证据，哪一个最低成本、最高信息增益、最能够区分竞争假设的行动，应该成为下一步？”**

这就是本 Skill 的最高决策原则。
