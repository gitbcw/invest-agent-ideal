# W1 独立验收与返工单

日期：2026-09-20。审查提交：e85db6f。依据：W1执行稿、v3不变量、T-524 v2批准与scope语义。结论：**Fail，禁止放行W2/W3。** 增量建表和领域骨架存在，但服务安全与版本契约尚未成立。

## 实测证据

在临时DB执行现有 `node --import tsx --test --test-concurrency=1 --test-force-exit tests/agent-space-domain.test.ts`：10/10通过。另以独立调用直接测试域服务，得到以下结果；临时DB已删除，未访问生产或用户内容。没有复跑全仓700项，执行方全仓/构建结论仍是其报告。

| 条件 | 结果 | 直接证据 |
| --- | --- | --- |
| 增量建表/重复初始化 | Pass（现有隔离测试范围） | 19表、checkpoint及重复初始化测试通过 |
| 跨scope依赖写入拒绝 | Fail | A写missing-task/shared-ref后，B相同键upsert返回A的行并将agent_id改为B提交值 |
| 私有Skill安装隔离 | Fail | A发布visibility=private，B通过releaseId成功安装 |
| 内容引用有效性 | Fail | assetId/versionId不存在、checksum=fake仍可addMethodVersion；Skill同样接受 |
| 批准绑定具体版本 | Fail | 创建候选v1→修订v2→approvalRef=approval-for-v1批准objectId，v2直接active |
| 历史版本属于指定对象 | Fail（静态） | resolveMethodVersion未校验version.method_id===methodId |
| 恢复不丢新域数据 | Fail | 交付文档把DROP全域表当回滚；测试只证明可重建空表 |
| 未接运行时/未导入真实用户 | Pass（提交范围） | diff限域模型、DB、测试与文档；不代表独立验证完整远端操作 |

## R1 [P1] 任务依赖与快照必须验证真实归属

`tasks.ts upsertTaskDependency` 不校验task/agent归属，latest跳过ref校验；唯一键(task_id,kind,ref_id)冲突时直接UPDATE，没有已有行scope检查。两个scope使用相同task/ref即可跨域改写。不是仅“agent_state占位”的问题。

修复：先验证真实task、revision、agent与引用的同scope关系；所有策略均验证对象存在和授权；unsupported agent_state必须fail-closed，不能接受占位。冲突更新也检查现有scope，事务包含审计。快照同时校验run→task→scope→agent及每个依赖/版本；不同payload重放应报幂等冲突。只存引用须运行时白名单验证字段，不依赖TypeScript类型。

验收反例：不存在task、跨scope task/agent、latest跨scope ref、同键跨域upsert、伪run与外域assembly、带正文额外字段，全部拒绝且无数据/审计部分写入。

## R2 [P1] 发布版安装必须校验可见性和状态

`agents.ts installSkill` release分支只核对release存在及version一致，不检查visibility、发布状态或授权主体。实测B能安装A的private release。

修复：public只允许published且内容版本有效；private仅属主；shared没有已定义授权模型时拒绝跨用户访问。系统域写入不能仅靠调用者传domain=system/actor字符串获得权限，需可信owner上下文或显式内部受控入口。补安装、读取、停用/撤回状态及跨scope反例。无需提前做市场UI。

## R3 [P1] 方法/技能引用与采用约束要在服务层强制

`addMethodVersion`/`addSkillVersion`直接存输入引用和checksum，未核对真实资产版本、归属及校验和。`resolveMethodVersion`只查scope与status，可将同scope另一Method的正式版本配给当前Method。`adoption_note`只是自由文本，现有测试仅证明备注还在，不能证明hold阻止采用。

修复：验证引用对象/版本/scope/checksum，系统模板需要可固定内容与校验规则；解析必须检查版本所属Method。结构化保留W0采用约束，批准/绑定/解析不得绕过；历史读取与运行采用分开。补不存在版本、外域引用、错误checksum、同scope错配Method、hold/历史默认采用反例。

## R4 [P1] 批准必须绑定预览版本，草稿修订不能替换有效配置

`approveStateCandidate`没有expectedVersionId，仅批准当前指针，无法区分确认v1与修订后的v2。实测旧确认激活新版本。approve/install等仅验证approvalRef非空，不能把任意字符串视为可核验授权。

修复：显式绑定版本、作用域与操作的可信批准记录，做乐观并发校验；保留已有效版本和新草稿两个指针/等价语义，提出修订不能直接令原经验退出生效。长期状态须有conversation/task/agent实际作用域及归属校验，不能仅有user域或任意content字段。补v1批准在v2后重放拒绝、无效批准拒绝、新草稿不替换active、跨Agent状态隔离。

## R5 [P1] 恢复方案与事务原子性

禁止把DROP agent_space全表当通用回滚：一旦产生新域数据就会丢失用户资产语义、批准和审计。当前“DROP后initDb”测试只证明空表重建，不能证明恢复。保留新增兼容表回退代码，数据恢复用验证备份或定向前向修复；文档区分空fixture重置与真实恢复。

多处先写对象、后独立写审计（如createMethod、upsertSkill、状态批准/修订、任务依赖）缺少共同事务。审计失败时已改变状态但调用报错。补原子事务与失败注入，证明失败无半成品，重试不重复版本/事件；幂等键相同但内容不同必须拒绝。旧库升级测试应保留非空旧域与新域记录并验证，不只数表。

## 派发与复验

> 留在W1，定向修复R1–R5；不接运行时、不导入真实资产、不动生产。将上述反例变成可失败的隔离测试，再修服务。更新W1-delivery撤回“全scope/批准/不可变均强制”和DROP回滚的过度结论。交付窄提交、变更映射、反例测试、必要类型/构建检查及数据保全恢复证据，再由主reviewer复验。不能把这些W1服务契约缺口留给W4/W5补齐。

## 第二次验收：dc6c794（2026-09-20）

结论：**Partial，W1仍不放行。** 已改进真实task/asset归属、release可见性、事务与恢复说明；本轮重跑域测试15/15通过，但下面三个独立反例仍成立。未复跑全仓705项/构建，不把执行方报告冒充独立证据。

### R6 [P1] 消息存在不等于用户批准

`core.ts verifyApprovalRef`只检查message_id和scope，未检查role/status，也无被批准对象、版本、动作和范围的授权绑定。实测在隔离库插入role=assistant、正文“并未取得用户批准”的消息，以其conversation:msg批准具体Lesson成功。同一消息还可用于另一对象。

expectedVersionId解决调用时版本竞争，不证明用户批准过它。修复为可信授权记录或受控授权上下文，至少绑定主体、scope、操作、objectId、versionId/内容摘要及依据；批准服务验证该绑定。消息只能是来源证据，不能拿任意消息ID充当凭证。不要求关键词匹配或让模型宣称“已同意”；明确指令仍可由可信入口在同一操作登记批准，不能新增统一二次确认。

验收：assistant/failed消息、无关用户消息、同依据跨对象/动作/版本重放均拒绝；合法具体授权成功；同一合法操作幂等重放符合既定契约。系统owner通道也须保留具体目标与操作审计，不将令牌传入模型。

### R7 [P1] 初始草稿修订的指针相互矛盾

`state.ts reviseStateCandidate`无论draft还是active均只更新draft_version_id；但approveStateCandidate在status=draft时只允许current_version_id。实测：创建v1 draft→修订v2→批准v2被IDEMPOTENCY_CONFLICT拒绝；批准v1却成功active，draft_version_id仍指向v2。

修复：区分首次草稿与有效版本的待批准修订，确保待批准版本指针唯一、正确；初始草稿修订后旧确认失效；active修订期间旧有效版本保留。覆盖lesson/workflow、连续修订、批准/拒绝/撤销待批准修订；拒绝修订不得停用原active。状态图、API与实际指针一致。

### R8 [P1] 快照仍可登记未解析草稿与伪版本依据

`tasks.ts verifyAssemblyEntry`允许versionId=null，随后只验证Method对象存在；未检查checksum、versionPolicy必填语义及分类一致性。实测创建没有任何版本的draft Method后，传入 `{objectType:'method', versionId:null, versionPolicy:'pinned', contentChecksum:'fabricated'}` 成功创建run快照。

修复：运行快照必须接受实际解析后的不可变正式版本；latest/current是解析策略，落快照仍需具体versionId。核对checksum或由服务生成；校验skills/methods/assets数组类别、agentId与assembly.agent一致，以及task/run revision关联。受hold等采用约束的版本不能通过pin绕过默认采用路径；复用统一运行可用性校验，历史读取另行保留。

验收：draft/null pinned version/伪checksum/类别错位/双Agent不一致均拒绝且不落快照；正式版本与真实校验和成功；不同装配重放继续拒绝。agent_state保持fail-closed直到后续注册，不用占位通过。

### 本轮验证与保留结论

- 直接域调用反例均在独立临时目录DB运行，已清理临时DB及探针；未修改产品代码、用户资产或生产。
- 既有15组测试通过，包括原始跨域写入和私有安装拒绝、引用校验、审计失败回滚。保留这些已完成修复，不要求推倒重写。
- R5恢复文档已区分fixture reset和真实备份/前向修复；src/db/index.ts的ensureAgentSpaceTables上方仍有DROP回滚旧注释，随本轮同步修正即可。
- 公共发布安装与task dependency验证目前采用不同路径（后者对user-domain Skill直接assertRowScope），W3/W4接入前要统一发布授权读取；不以此轮未接runtime声称市场全链可用。

下一次仅围绕R6–R8及关联回归提交。尤其补真实初始草稿分支和“存在但非授权的消息”，不能只增加不存在messageId的拒绝测试。通过后再判定W2/W3放行。

## 第三次验收：2b7058c（2026-09-20）

结论：**Partial；R7/R8定向修复及授权绑定机制有进展，剩授权事务/重放问题阻止W1放行。** 重跑18组域测试通过；未独立复跑全仓708项和build。登记接口当前没有接模型/服务工具，后续可信确认入口接线仍须独立验收，不能把来源消息role/status校验解释为自然语言意图已验证。

### R9 [P1] 授权先消耗、业务后失败，且consumed重放被直接拒绝

代码：core.ts verifyAuthorization先要求status===active，然后更新status=consumed；注释却声称consumed可重放。state.ts approveStateCandidate在业务事务开始前调用它。授权登记registerUserAuthorization也先INSERT再独立写审计，未处于同一事务。

独立临时DB反例（已执行、清理）：创建合法user/sent来源、Agent、Lesson草稿及精确绑定凭证；为lesson.approved审计注入RAISE(ABORT)；调用批准。

实际结果：

```text
firstFailure: review audit failure
authorization: status=consumed, consumed_at非空
lesson: status=draft
移除故障后原请求重试：AGENT_SPACE_APPROVAL_REQUIRED: authorization is consumed
```

因此上次要求的“审计失败零半成品、合法操作可重试”被新增凭证破坏。成功操作重试也会撞同一个consumed拒绝条件；只修改该if还不够，因为业务层对已批准状态也可能拒绝。

修复要求：

1. 分离纯核验与消费，或让核验/消费/对象变更/审计在同一事务内；任何失败不能提前耗掉凭证。登记与登记审计同样原子化。
2. 定义完整操作的幂等回放：相同绑定且已成功的请求返回原操作结果，不重复写审计/版本/安装；不同绑定仍拒绝。不能只让verify函数通过而在后续生命周期判定失败。
3. revoked/expired/不匹配等失效凭证仍拒绝。extraBinding需规范化并按完整键值集合比较，不能把“完全一致”实现为仅比对调用方提供的子集。
4. 补授权主体校验或明确从可信身份上下文派生subjectUser，避免将未校验的调用参数记作批准人。

定向复验矩阵（所有使用verifyAuthorization的写路径：方法批准、技能批准、安装/升级、状态批准、承诺激活）：成功后同请求重放无副作用；消费前后业务校验失败；审计失败后修复重试；登记审计失败；同凭证换目标/动作/版本/extraBinding拒绝；合法回放不得恢复后来被停用/撤回的对象。授权状态与业务状态须一起验证。

保留本轮已验证进展，不重新扩展schema/市场/运行时工作。提交R9定向修复和上述矩阵结果后复验；仍不派发W2/W3。

## 第四次验收：cfc30ff（2026-09-20）

结论：**R9部分通过，W1仍不放行。此次不新增要求，补完原R9即可。**

复验：重跑20组域测试通过；审查本次diff与五条调用路径。授权登记/业务事务原子化已有修复，Lesson审计失败后凭证回滚、移除故障重试成功有测试证明。全仓710项与build仍为执行方报告，本轮不重复运行。

### 尚未满足原R9第2条：完整业务操作幂等

现有测试832行起、884行起，明确把成功后重放返回VERSION_INVALID/IMMUTABLE作为通过标准。这与本报告上一轮“相同绑定且已成功请求返回原操作结果，不重复写审计/版本/安装”直接不符。凭证核验通过但业务报错不是所要求的幂等成功。

更具体的遗漏：agents.ts installSkill接收consumed凭证后，仍无条件把当前installation改为superseded并插入新installation、新审计。故静态路径显示重复请求会制造新安装记录；不是只换了一个无害错误码。原R9要求覆盖五条路径，当前新增用例只验证部分路径。

必须完成：每次成功授权操作与稳定结果/操作记录关联；同请求回放返回既有结果，不重新执行状态转换。历史回放不得恢复后来被停用的对象，也不得把后续安装降回旧版本。更新测试为实际成功回放及DB行数、版本、审计无变化断言，不再断言期待错误。

### 尚未满足原R9第3/4条：完整绑定与批准主体

core.ts verifyAuthorization仍仅遍历调用方extraBinding的键；缺省或省略键可跳过授权记录中已有约束。登记仍直接保存subjectUser，未核对同scope身份或从可信身份派生；JSON.stringify顺序也仍直接进入自然键。补规范化完整键集合比较和主体校验，并验证键顺序无关、缺/多/改键拒绝、冒名主体拒绝。

### 本轮返工清单（沿用R9，不另开R10）

- 保留已通过的原子回滚修复。
- 方法批准、技能批准、安装/升级、状态批准、承诺激活逐一验证成功后幂等回放；对失败注入后重试、撤销凭证、对象后续停用/升级也验证结果。
- 注册审计失败必须无凭证残留，修复故障后可以登记成功。
- 完整绑定与主体校验按上段实现；交付文档不得把IMMUTABLE/VERSION_INVALID标为幂等成功。

这些要求均来自上一轮R9，不需要增加产品范围、生产测试或新授权流程。完成后再放行W2/W3。

## 第五次验收：33f2be9（2026-09-20）

结论：**Partial；普通authorization凭证回放已有实质修复，owner-decision旁路仍违反R9，W1暂不放行。**

独立重跑22组域测试通过；审查result_json写入、回放分支、extraBinding完整比较及subjectUser校验。保留普通凭证的结果回放、升级后不降级、暂停后不恢复等已通过用例。全仓712项/build属于执行方报告，本轮未重复运行。

### 原R9剩余阻塞：owner通道没有稳定操作结果

`state.ts activateCommitment`的owner-decision回放只在当前状态不是proposed/paused时检查业务行authorization_ref。若对象已经paused，直接重新UPDATE为active。业务行当前状态不是持久的幂等操作记录，不能替代普通凭证result_json。

独立临时DB实测（已清理）：

1. 建立真实同scope task及recurring commitment。
2. 用合法owner令牌及 `owner-decision:review` 激活。
3. 调用transitionCommitment暂停。
4. 原封不动重放第2步。

结果：`before.status=paused` → `after.status=active`；`commitment.activated`审计增加为2条。应保持paused，返回原操作结果且无新增审计。现有测试只覆盖普通authorization的暂停回放，owner只测方法批准与安装，遗漏此分支。

### 定向修复要求（仍为R9，不新增编号）

- 让owner决定也绑定完整操作并保存持久结果，可复用授权/操作记录；或提供同等可靠的独立台账。不要仅靠可变业务行approval_ref识别历史操作。
- owner同请求回放必须与普通凭证一致：返回原结果，无转换；后来暂停、停用、升级不被恢复。同决定ID改变对象/版本/动作/影响参数应冲突。
- 补owner通道五条路径矩阵，特别是commitment暂停后回放，以及state批准后再修订/停用后的旧请求回放。
- 核对完整操作指纹包含影响结果的参数：方法`adopt`、安装`releaseId`目前不在extraBinding中。相同version可以有不同release；仅钉version不能表示选择了哪项发布。初次执行或重放均不得静默接受这些参数变化。

只补owner回放和完整操作指纹，并保留现有普通凭证测试。此次没有要求扩大市场、运行时或迁移范围；修复后再审W1放行。

## 第六次验收：e386551（2026-09-20，W1阶段收口）

结论：**Pass with caveats，W1本地领域基础验收通过，允许进入W2/W3；不授权生产启用或真实迁移。** 原R9阻塞已解决。

本轮验证：

- 重跑agent-space-domain.test.ts：23/23通过，包括普通凭证与owner五路径回放、完整绑定、失败回滚及主体校验。
- 审查owner-decision稳定操作记录创建/读取、事务内result_json记录，以及五路径删除可变业务行回放兜底的diff。method.adopt与installation.releaseId已纳入绑定。
- 独立临时DB重演原owner反例：激活→暂停→相同请求回放；状态保持paused，审计总行数不变，owner操作result_json存在。临时数据已清理。
- `npx tsc --noEmit`通过。全仓713项及build为执行方报告，本轮未重复运行。

保留边界（非本轮放行阻塞）：

1. 这是服务领域基础，不是运行时、市场端到端或生产迁移验收。可信授权登记入口尚待实际接线审查；禁止直接向模型暴露登记能力或owner令牌。
2. shared跨用户与agent_state依赖目前fail-closed，后续阶段按既定设计实现，不得改成默认放行。
3. W0待裁决/无备份/历史内容继续保留门禁；W1通过不改变任何方法采用许可。
4. 已知小型文档残留：core.ts recordAuthorizationOutcome注释仍写owner无凭证行、methods批准输入注释仍提conversation旧形态，后续在所属文件编辑时同步，不阻断进入W2/W3。

派发约束：W2负责方法与资产路径；W3负责技能目录/发布/安装。可在独立分支并行，但共享core.ts、db/index.ts、schema.ts及统一域测试的修改须先明确一名负责人或串行整合，不各自覆盖。两者仍只做本地/隔离实现，不部署、不导入mg/111/dyk、不接管旧Workspace。交付后分别验收，再启动W4。
