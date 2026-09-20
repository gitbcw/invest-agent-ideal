# W1 交付：新对象契约与数据库基础

状态：本地实现与隔离 DB 验证完成（含 R1-R5、R6-R8、R9 四轮返工）；未导入任何真实用户内容、未接线运行时、未改 Portal/调度/生产配置。
依据：[W1-domain-contracts.md](./W1-domain-contracts.md)、[v3 总纲](../agent-space-workspace-exit-design-v3.md) §5-W1、[W0 验收第三次结论](./W0-acceptance-review.md)、[W1 验收返工单](./W1-acceptance-review.md)（R1-R5、R6-R8、R9 前三轮均已修复；R9 第四轮补齐业务幂等回放、完整绑定与主体校验）。

## 0. R1-R5 返工摘要（相对首版 e85db6f）

| 验收问题 | 修复 | 反例测试 |
| --- | --- | --- |
| R1 B 覆盖 A 任务依赖 / latest 跳过 ref 校验 / 快照弱校验 | `upsertTaskDependency` 验证 task/agent/ref 真实归属（所有 policy）；唯一键冲突更新前核对已有行 scope；快照校验 run→task→scope→agent 全链 + 逐条装配引用 + 载荷白名单 + 同 run 异载荷幂等冲突；agent_state fail-closed（W1 无注册面不接受占位） | "task dependencies verify real ownership" + "run snapshots validate chain" 两组共 16 条断言 |
| R2 B 安装 A 私有发布 | `assertReleaseInstallableBy`：public=跨用户可装（须 published）；private=仅属主；shared=授权模型未定义前 fail-closed；撤回后不可装；系统域写操作（upsert/版本/发布/批准）须 owner 令牌（settings/env 服务侧配置，非调用方自报） | "skills — refs, publish visibility" 组 |
| R3 假资产/假 checksum 可登记 | `addMethodVersion`/`addSkillVersion` 在服务层核对 user_asset_versions 行存在、同 scope、checksum 与库值一致（系统模板核对模板根文件字节）；`resolveMethodVersion` 校验版本属于指定 Method；W0 约束结构化为 `adoption_constraints` 列并强制（hold 默认采用须 owner 决策；historical-not-default 永不成为 current 且拒绝运行 pin/绑定） | "method content refs" + "structured adoption constraints" + resolve 错配反例 |
| R4 修订后旧确认激活新版本 | `approveStateCandidate` 增 `expectedVersionId`（乐观并发：绑定用户确认的预览版本，过期确认报 `IDEMPOTENCY_CONFLICT`）；active 对象修订走 `draft_version_id` 独立指针，原有效版本不退出；lesson/workflow 必须挂真实会话/任务/Agent（owner_kind/owner_id 校验）且内容字段白名单 | "state candidates" 组：v1 确认在 v2 后重放拒绝、修订不退有效版、归属/白名单反例 |
| R5 DROP 当回滚 + 非原子写 | 本文档 §6 重写：DROP 仅测试夹具重置；真实恢复=验证备份/定向前向修复。全部写操作（含审计）同事务，测试用审计失败触发器证明零半成品；幂等键同 key 不同内容一律 `IDEMPOTENCY_CONFLICT` | "audit failure rolls back" + 幂等冲突 + "upgrade with existing data" |
| approvalRef 任意字符串 | ~~`verifyApprovalRef` 仅验消息存在~~ → R6 升级为绑定式授权凭证（见下） | — |
| R6 消息存在≠用户批准 | 新增 `agent_space_authorizations` 授权登记表：`registerUserAuthorization` 核验来源消息（同 scope、role=user、status=sent）并绑定主体/scope/操作/对象/版本/附加字段（extraBinding 计入自然键）；`verifyAuthorization` 只认 `authorization:<id>`（绑定全匹配，同绑定重放幂等、跨对象/动作/版本拒绝）或 `owner-decision:<ref>`+令牌；assistant/failed/superseded 消息不能登记；裸 `conversation:` 不再是凭证 | "R6: message existence is not authorization" 组 + 直接复现 |
| R7 初始草稿修订指针矛盾 | `reviseStateCandidate` 区分两态：首次草稿（从未批准）修订直接替换 `current_version_id`（旧确认随之失效）；active 修订走 `draft_version_id` 且同时只允许一个待批准；新增 `discardStateRevision`（撤销/拒绝待批准修订，不动对象状态与有效版本）；approve 的可批准指针口径与实际指针一致（draft=current、active=draft） | "R7: initial-draft revision" 组：批准 v2 成功、旧确认冲突、连续修订拒绝、discard 后 active 保留 |
| R9 授权消耗非原子/重试被消耗态拒绝 | `verifyAuthorization` 的核验+消耗移入各业务事务内（better-sqlite3 环境事务：授权消耗、业务变更、审计原子提交，失败整体回滚、凭证不失耗）；`revoked` 拒绝；`registerUserAuthorization` 登记与登记审计同事务 | "R9: authorization consumption is atomic" 组 + 直接复现（注入审计失败→回滚→凭证 active→重试成功） |
| R9 第四轮：业务幂等回放不完整（install 重放新增行/审计；重放以 IMMUTABLE/VERSION_INVALID 收口） | 每条成功授权操作与稳定结果关联：凭证行新增 `result_json`（消耗同事务写入 `recordAuthorizationOutcome`）；五条授权写路径（方法批准/技能批准/安装升级/状态批准/承诺激活）重放一律返回既有结果、零副作用、不重复转换——安装重放返回原安装行（即使已被后续升级 superseded，不降级当前安装），状态/承诺回放不恢复后来停用/暂停的对象；owner-decision 无凭证行，由业务行 `approval_ref` 同依据匹配兜底回放；消费后业务校验失败（如约束挡采用）随事务回滚凭证 | "R9: install/approve/activate replays return recorded outcomes" 组（行数/审计/安装行 id/不降级逐项断言）+ "revoked … returns the recorded outcome" 组 + 直接复现 17 项 |
| R9 第四轮：extraBinding 仅比对调用方子集 / 主体未校验 | extraBinding 规范化（键排序稳定序列化，键序无关）且按**完整键集合**比较（缺/多/改键均拒绝）；登记主体校验：`subjectUser` 必须等于 scope 本人（可信 scope 派生，冒名登记拒绝且零残留）；自然键查重用规范化形态 | "R9: extraBinding full-key comparison, canonical dedupe, subject validation" 组 + 直接复现 |
| R8 快照接受未解析草稿/伪依据 | 装配条目必须携带具体已解析正式 versionId（null 拒绝；latest/current 是解析策略非延迟）；类别必须与所在数组一致；checksum 由服务端从版本行读取盖章（调用方提供值必须与实际一致）；method 复用 `resolveMethodVersion`（含"未采纳 current 的 hold/split 约束版本不得 pin"绕过拦截）；校验 assembly.agent 与顶层 agentId 一致、run.revision 归属 | "R8: snapshots reject..." 组：draft/null/伪 checksum/类别错位/双 Agent 不一致/hold 绕过全拒绝、正常装配盖章成功 |

## 1. 代码位置

| 内容 | 位置 |
| --- | --- |
| 建表迁移（幂等，checkpoint `agent_space_v1`；R3/R4/R9 增量列经 ensureColumn 演进） | `src/db/index.ts` `ensureAgentSpaceTables()` |
| Drizzle 类型镜像 | `src/db/schema.ts`（`agent_space_*` 20 张） |
| 域服务 | `src/services/agent-space/`：`core.ts`（scope/错误/审计/幂等冲突/owner 授权/可核对批准/授权结果记录/字段白名单）、`methods.ts`、`skills.ts`、`agents.ts`、`tasks.ts`、`state.ts`、`index.ts` |
| 隔离测试 | `tests/agent-space-domain.test.ts`（22 组；fixture 以真实事实源行种子：会话消息、资产版本、任务/修订/运行） |

## 2. Schema 映射（表 → 契约对象）

| 契约对象 | 表 | 关键约束 |
| --- | --- | --- |
| Method 体系 | `agent_space_methods` | scope 三列 NOT NULL + UNIQUE(name)；status draft/active/retired |
| Method 正式版本 | `agent_space_method_versions` | 引用 user_asset 版本且服务层核对存在/scope/checksum；draft→approved 不可变；`adoption_constraints`（JSON 数组）承载 W0 结构化约束 |
| Skill（分域） | `agent_space_skills` | domain system 行 scope 列 NULL；系统域写须 owner 令牌 |
| Skill 私有版本 | `agent_space_skill_versions` | 引用校验同上（系统模板核对模板根字节与 checksum） |
| SkillRelease | `agent_space_skill_releases` | 冻结 (version_id, checksum)；visibility public/shared/private；retired 不可装 |
| Agent / 安装 / 绑定 / 授权 | `agent_space_agents` / `_agent_skill_installations` / `_agent_method_bindings` / `_agent_asset_grants` | 安装 append-only 且升级须可核对批准；pinned 拒绝 historical-not-default；授权引用同 scope 真实资产 |
| TaskDependency | `agent_space_task_dependencies` | task/agent/ref 全部真实归属校验；agent_state fail-closed |
| TaskRunSnapshot | `agent_space_task_run_snapshots` | append-only；UNIQUE(run_id)；装配白名单字段+全链校验；同 run 异载荷冲突 |
| T-524 Fact / Lesson(+v) / Workflow(+v) / Commitment / 履约 | `agent_space_facts` / `_lessons` `_lesson_versions` / `_workflows` `_workflow_versions` / `_commitments` / `_commitment_fulfillments` | fact 自然键幂等；lesson/workflow 挂 owner(conversation/task/agent)+内容白名单；批准绑 expectedVersionId；修订走 draft_version_id；承诺激活须可核对授权+同 scope 执行器 |
| 可信授权登记（R6） | `agent_space_authorizations` | 批准凭证绑定主体/scope/操作/对象/版本/extraBinding（规范化形态计入唯一自然键）；来源消息 role=user 且 status=sent；主体=scope 本人；`result_json` 记录成功操作的稳定结果供幂等回放 |
| 统一审计 | `agent_space_audit_logs` | 与业务写同事务；记录 from/to、批准依据形态、W0 约束 |

## 3. 状态转换（服务层校验）

```
Method:      draft ──approve(ref, 约束检查)──▶ active ──retire──▶ retired
             版本: draft ──approve──▶ approved ──被新版本采用──▶ superseded / retired
             约束: hold-ambiguity 默认采用须 owner-decision；historical-not-default 不成为 current 且拒绝运行 pin/绑定；split-in-progress 同 hold
Skill 私有:  draft ──approve──▶ approved（→superseded）；release: approved ──publish──▶ frozen(public/shared/private) ──retire──▶ 不可装
             安装: release 按 visibility 判定（private 属主/shared fail-closed/public+published）；升级须可核对 approvalRef
Agent:       draft ──▶ active ⇄ disabled
Lesson/Workflow: draft ──approve(expectedVersionId, ref)──▶ active ──revise──▶ 保持 active + draft_version_id
                 ──▶ superseded | expired | rejected | disabled（终态）
Commitment:  proposed ──activate(可核对授权 + 执行器同 scope)──▶ active ⇄ paused ──▶ cancelled；one_shot→completed；recurring 跨期 active
Fulfillment: pending → running → satisfied | failed_needs_attention | skipped（run 引用校验同 scope）
```

批准凭证契约（R6/R9 后）：`authorization:<id>`——由可信入口 `registerUserAuthorization` 登记（来源消息必须同 scope、role=user、status=sent；绑定主体/scope/操作/objectId/versionId/extraBinding，主体必须等于 scope 本人，extraBinding 以键排序规范化形态计入幂等自然键），核验时按完整键集合比对绑定（缺/多/改键均拒绝，键序无关）、跨对象/动作/版本重放拒绝；或 `owner-decision:<ref>` + owner 令牌（目标绑定入审计）。裸消息 id、assistant/failed/superseded 消息、任意字符串一律不是凭证。核验与消耗在业务事务内执行（R9）：失败整体回滚、凭证不失耗；成功操作把稳定结果记入凭证 `result_json`（与消耗同事务），**同请求重放直接返回既有结果、零副作用**（不重复审计/版本/安装，不重新执行状态转换，不恢复后来停用/暂停的对象，不把后续安装降回旧版本）；`revoked` 凭证即使绑定匹配也拒绝；consumed 无结果记录按 fail-closed 拒绝。owner-decision 无凭证行，重放由业务行 `approval_ref` 同依据匹配兜底，换目标/版本仍拒绝。

## 4. API 列表（`src/services/agent-space/`）

- core：`assertScopeValid`/`assertRowScope`/`recordAgentSpaceAudit`/`findByIdempotencyKey`/`assertIdempotencyConsistent`/`registerUserAuthorization`（主体校验+规范化绑定）/`verifyAuthorization`（完整键集合比对+幂等回放）/`recordAuthorizationOutcome`/`canonicalExtraBindingJson`/`requireOwnerAuthorization`/`assertOnlyFields`
- methods：`createMethod` `addMethodVersion`（引用真实性+约束校验）`approveMethodVersion`（约束+owner 通道）`retireMethod` `resolveMethodVersion`（归属+运行约束）`getMethod(Version)` `parseAdoptionConstraints`
- skills：`upsertSkill` `addSkillVersion`（async；引用校验）`approveSkillVersion` `publishSkillRelease` `retireSkillRelease` `assertReleaseInstallableBy` `getSkillReleaseForInstaller` `listPublicSkillReleases` `getSkill(Version)`
- agents：`createAgent` `setAgentStatus` `installSkill` `listInstalledSkills` `bindMethod` `grantAsset` `listAssetGrants`
- tasks：`upsertTaskDependency` `listTaskDependencies` `recordTaskRunSnapshot`（幂等+冲突）`getTaskRunSnapshot`
- state：`recordAgentFact` `createStateCandidate`（owner 绑定+内容白名单）`approveStateCandidate`（expectedVersionId）`reviseStateCandidate`（草稿态替换指针/active 态挂待批准）`discardStateRevision`（撤销待批准修订）`transitionStateCandidate` `listEffectiveState` `createCommitment` `activateCommitment` `transitionCommitment` `recordFulfillment`

## 5. 验证证据

```
node --import tsx --test --test-concurrency=1 --test-force-exit tests/agent-space-domain.test.ts   # 22/22
npm test    # 712/712（~47s 自终止）
npm run build && npx tsc --noEmit   # 0 错误
```

覆盖：建表幂等重放；带数据升级重放（旧域+新域行保留）；夹具重置（非恢复语义）；R1-R5 全部反例（见 §0 表）；审计失败注入回滚（业务与授权登记两类）；幂等冲突；scope 拒绝矩阵；快照引用-only 断言；五条授权写路径的成功回放（行数/审计/安装行 id/不降级/不复活逐项断言）、revoked 拒绝、完整键集合比对、冒名主体拒绝、登记审计失败零残留。

## 6. 恢复说明（R5 修正后）

- **测试夹具重置**（仅隔离/测试库）：`DROP TABLE agent_space_*` 后重跑 `initDb()` 重建空结构——测试 3 证明的是这一点，不证明数据恢复。
- **真实数据恢复**：域内一旦产生真实数据（W6 之后），回退代码版本不会删表（增量表向后兼容，旧代码不读即无影响）；数据级问题用**验证过的备份**恢复（项目 DR 通道，T-415 SOP），或**定向前向修复**（新增服务层修复函数 + checkpoint，不改写审计历史）。
- **升级**：`ensureAgentSpaceTables()` 幂等；R3/R4 增量列经 `ensureColumn` 对已初始化的 W1 隔离库演进（测试 2 证明带数据重放安全）。
- 生产部署：遵循 db-migration 流程（先备份 DB、release 通道发布、本域无 backfill）。

## 7. 待决项

- 运行时装配接线（W4/W5）；`agent_state` 依赖/装配条目在 W5 注册面落地后由 fail-closed 改为真实校验。
- shared 可见性的授权模型（市场审核策略未冻结，v3 §8）；owner 令牌的生产注入方式（settings 键由运维写入）。
- 快照不可变当前=服务层无更新路径+UNIQUE(run_id)+幂等冲突；W5 落地写入方时决定是否加 SQLite 触发器硬拒 UPDATE。
- Portal 信息架构、W0 的 205 项 owner-review 候选进入 W2 的逐项裁决流程。
- `registerUserAuthorization` 的可信调用入口在 W4/W5 接入运行时确认层（当前仅服务层直调；模型不可达）。
- 公共发布安装与 task dependency 的发布授权读取统一（验收遗留注记，W3/W4 处理）。
