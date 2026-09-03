---
name: ai-native-context-debugger
description: "调试 AI Agent、自动化任务、LLM 工作流中的异常行为时使用（当 agent 行为与预期不一致、需要诊断为什么出错、或准备提出 prompt/规则/机制/代码修复时）。核心纪律：先证明错误不能由 context（上下文/状态/工具环境）解释，再修改模型或增加机制。Reconstruct the world → Explain the behavior → Intervene on the cause → Observe → Escalate only with evidence."
---

# AI-Native Context Debugger

## Purpose

用于调试 AI Agent、自动化任务、LLM 工作流中的异常行为。

本 Skill 的核心目标不是更快地产生修复方案，而是防止把 **上下文问题、状态问题、工具环境问题** 过早误判成：

* 模型能力不足
* Prompt 不够明确
* 缺少代码机制
* 缺少 Guardrail
* 缺少规则或校验

核心原则：

> **先还原模型看到的世界，再解释模型为什么这样行动，最后才决定修改什么。**

---

# Core Law

当 AI 行为与预期不一致时，在提出任何以下修改之前：

* 修改用户指令
* 增加 Prompt
* 增加系统规则
* 增加代码
* 增加状态机
* 增加 Guardrail
* 增加校验
* 增加自动化机制

必须先回答：

> **当前真实运行上下文，是否已经足以合理解释这个异常行为？**

如果答案是“是”，默认首先修复上下文，而不是修复模型。

---

# Mental Model

传统软件调试常问：

> 哪段逻辑没有写对？

AI 应用调试首先应问：

> **模型当时到底看到了什么，以至于它认为这个动作是合理的？**

LLM 的实际输入不是只有用户 Prompt。

真正影响行为的是：

**Effective Context**

包括但不限于：

* 用户真实意图
* System / Developer Instructions
* 当前任务定义
* 动态注入 Prompt
* 已绑定文件或资产
* 文件内容与文件名
* Memory
* 历史状态
* Previous Run State
* Tool 描述
* Tool 返回值
* 当前可用工具
* 输出目标
* 保存通道
* 隐式配置
* 系统自动注入的信息

调试 AI 行为时，应分析 **Effective Context**，而不是只分析用户说了什么。

---

# Debugging Protocol

## 1. Freeze the Case

首先固定三个东西：

**Expected Behavior**

用户真正希望发生什么？

**Observed Behavior**

实际上发生了什么？

**Runtime Facts**

这次执行中能够确认的客观事实是什么？

不要立即提出方案。

---

## 2. Reconstruct Effective Context

还原模型执行这一动作时实际拥有的信息。

重点寻找：

* 用户意图与系统信息是否冲突
* 当前状态是否已经过期
* 是否注入了错误资产
* 是否存在旧文件、旧任务、旧 Memory
* Tool 是否暗示了错误目标
* 保存目标是否被预先锁定
* 某个具体信息是否比用户自然语言更明确、更强
* 模型是否实际上没有选择权

不要把“系统本来想表达什么”和“模型实际看到什么”混在一起。

---

## 3. Behavior Rationality Test

问：

> **假设我是这个模型，只看到上述 Effective Context，我现在这个错误行为是否可以被合理推导出来？**

### 如果可以

优先判断为：

**Context / State / Orchestration Problem**

暂时不要判断为模型能力问题。

### 如果不可以

再继续调查：

* 模型是否没有理解明确指令
* Tool 是否使用错误
* 推理是否失败
* 是否存在随机性或可靠性问题

---

# 4. Find the Causal Variable

不要问：

> “系统还缺什么？”

先问：

> **“现有系统里什么东西不应该存在、已经错误、已经过期或者正在误导模型？”**

寻找能够解释行为的最小因果变量。

例如：

```text
User intent:
追加到当月工作簿

Runtime context:
绑定 8 月文件
禁止替换任务对象
保存目标仍然是 8 月资产

Observed behavior:
9 月数据写进 8 月文件
```

此时优先因果模型是：

```text
stale asset binding
        ↓
incorrect effective context
        ↓
model selects August workbook
```

而不是：

```text
model does not understand "current month"
```

---

# 5. Causal Commitment

一旦某个原因已经被证据充分确认，将其明确记录为：

## CONFIRMED CAUSE

后续所有方案必须与该原因保持一致。

例如：

```text
CONFIRMED CAUSE

The stale August asset binding conflicts with the user's
current-month instruction and is sufficient to explain
the observed file selection.
```

从这一刻开始：

**不得因为出现一个新的、看起来不错的解决方案，就悄悄更换问题定义。**

如果后续要推翻 Confirmed Cause，必须指出：

> 出现了什么新的证据？

没有新证据，不得重置诊断。

---

# 6. Minimal Causal Intervention

找到原因后，首先设计：

> **只改变这个因果变量，其他条件尽量保持不变的实验。**

目标不是“最小代码改动”。

目标是：

**最小因果干预。**

例如：

```text
Before

User instruction
+ stale August asset binding
+ current tools
→ wrong workbook


Intervention

User instruction
- stale August asset binding
+ current tools
→ observe again
```

如果行为恢复：

问题已经得到非常强的因果验证。

此时不要继续增加机制。

---

# 7. Prefer Subtraction Before Addition

对于 AI 应用故障，默认检查顺序是：

**Remove → Correct → Isolate → Simplify → Add**

先检查能否：

* 删除错误 Context
* 删除过期 State
* 删除冲突 Instruction
* 解除错误绑定
* 隔离污染 Memory
* 修正 Tool 返回
* 简化上下文

只有这些仍无法解决时，才考虑：

* Prompt clarification
* 新规则
* 示例
* Guardrail
* Validation
* Deterministic mechanism
* 新代码

“增加东西”不是默认动作。

---

# 8. Clean-Context Test Before Declaring Model Failure

不得仅凭一个受污染、冲突或高度约束的运行结果得出：

> “模型不可靠。”

在判断 Capability Defect 之前，应尽量完成：

## Clean Context Test

移除已经确认的错误或冲突信号，在合理、完整且没有明显污染的上下文中重新观察模型。

只有在干净上下文下仍然稳定失败，才有充分理由讨论：

* Prompt 是否确实表达不足
* 模型能力是否不足
* Tool 是否需要增强
* 是否需要确定性机制

---

# 9. Do Not Patch the User to Compensate for System Errors

如果用户原始意图已经清晰：

不要因为系统上下文错误，就要求用户写得更机械、更冗长。

例如：

用户已经说：

> “追加到当月工作簿。”

如果系统却绑定旧月份文件：

错误首先属于系统上下文。

不要自动把用户指令改成：

> “请寻找 YYYY-MM 文件，如果不存在则……”

除非已经有证据证明，在干净上下文下模型仍然不能正确理解原始意图。

---

# 10. Distinguish Problem Classes

AI 行为异常至少应先区分以下几种类型：

### Context Defect

模型收到错误、冲突、多余或误导信息。

首选：修 Context。

### State Defect

历史状态、旧资产、Memory、缓存或任务状态错误延续。

首选：修 State。

### Tool / Environment Defect

Tool schema、返回结果、权限、保存目标或环境让模型形成错误判断。

首选：修 Tool / Environment。

### Instruction Conflict

不同层级指令互相矛盾。

首选：消除冲突，而不是增加更多规则参与竞争。

### Capability Defect

上下文清晰、状态正确、工具充分，模型仍然不知道怎样完成任务。

此时才考虑 Prompt、示例、工具增强或更强模型。

### Reliability Defect

模型明确具备能力，但在相同合理条件下存在不可接受的概率性失败。

此时才有充分理由考虑 deterministic mechanism、validation 或 guardrail。

不要在没有区分这些类别之前直接进入解决方案设计。

---

# Anti-Patterns

发现以下思考时，应主动停止：

### “Agent 犯错了，所以要加机制”

未证明。

### “为了保险，最好再加一层校验”

保险不是根因分析。

### “把用户 Prompt 写得更详细就好了”

先证明用户原始意图确实存在歧义。

### “做一个通用 Prompt 规则避免以后再发生”

先确认问题确实属于缺少规则，而不是已有错误上下文。

### “模型不可靠，所以服务端必须接管”

必须先通过 Clean Context Test。

### “这个方案以后更稳”

不要用一个更大的未来问题替换当前已经明确的问题。

### “用户刚刚反驳了，所以之前诊断一定错了”

用户反馈是新输入，不自动等于新证据。

重新检查事实；没有新事实，不应随意推翻 Confirmed Cause。

---

# Solution Gate

在输出任何修复方案前，必须能够完成以下陈述：

```text
Observed behavior:
...

Expected behavior:
...

Effective context:
...

The behavior is / is not explainable from this context because:
...

Confirmed or leading causal variable:
...

Minimal causal intervention:
...

What evidence would falsify this diagnosis:
...
```

如果这些还无法回答：

**继续诊断，不要急着设计机制。**

---

# Solution Evaluation

对于每个候选方案，只问一个核心问题：

> **它是否直接作用于已经确认的因果变量？**

如果答案是否定的，该方案默认降级。

例如：

```text
Confirmed cause:
stale asset binding
```

候选：

```text
Add rollover mechanism
→ does not directly remove confirmed cause

Add three prompt sentences
→ does not directly remove confirmed cause

Add global prompt rule
→ does not directly remove confirmed cause

Remove stale asset binding
→ directly intervenes on confirmed cause
```

优先最后一个。

除非存在额外证据说明它不足。

---

# Escalation Rule

只有当最小因果干预失败后，才上升一个层级。

推荐顺序：

```text
Context
↓
State
↓
Tool / Environment
↓
Instruction clarity
↓
Model capability
↓
Reliability mechanism
↓
Application code / deterministic control
```

不得因为更高层方案更“工程化”或看起来更可靠，就跳过低层原因。

---

# Debug Output Format

默认输出应简洁，并使用以下结构：

## Diagnosis

**Expected:**
...

**Observed:**
...

**Effective context:**
...

**Causal explanation:**
...

**Confidence:** confirmed / likely / uncertain

## Minimal Intervention

...

## Why not add more yet

...

## Verification

只改变上述因果变量后重新运行。

如果成功：停止。

如果失败：把失败视为新证据，再进入下一轮诊断。

---

# Operating Principle

始终记住：

> **AI Agent 的错误行为，很多时候不是因为它没有遵守世界，而是因为系统给了它一个错误的世界。**

因此：

> **不要首先问怎样让模型更听话。**

首先问：

> **我们到底让模型看见了什么？**

最终工作方式：

> **Reconstruct the world → Explain the behavior → Intervene on the cause → Observe → Escalate only with evidence.**

也就是：

> **先还原世界，再解释行为；先修改原因，再增加机制。**
