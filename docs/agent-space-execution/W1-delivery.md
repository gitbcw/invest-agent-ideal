# W1 交付：新对象契约与数据库基础

状态：本地实现与隔离 DB 验证完成；未导入任何真实用户内容、未接线运行时、未改 Portal/调度/生产配置。
依据：[W1-domain-contracts.md](./W1-domain-contracts.md)、[v3 总纲](../agent-space-workspace-exit-design-v3.md) §5-W1、[W0 验收第三次结论](./W0-acceptance-review.md)。

## 1. 代码位置

| 内容 | 位置 |
| --- | --- |
| 建表迁移（幂等，checkpoint `agent_space_v1`） | `src/db/index.ts` `ensureAgentSpaceTables()`（在 `initDb()` 内调用，全部 `CREATE TABLE IF NOT EXISTS` + 部分唯一索引） |
| Drizzle 类型镜像 | `src/db/schema.ts`（`agent_space_*` 19 张） |
| 域服务 | `src/services/agent-space/`：`core.ts`（scope/错误/审计/幂等原语）、`methods.ts`、`skills.ts`、`agents.ts`、`tasks.ts`（依赖+快照）、`state.ts`（T-524 四对象）、`index.ts`（出口） |
| 隔离测试 | `tests/agent-space-domain.test.ts`（10 组，临时目录 DB，不碰生产/本地 data） |

## 2. Schema 映射（表 → 契约对象）

| 契约对象 | 表 | 关键约束 |
| --- | --- | --- |
| Method 体系 | `agent_space_methods` | scope 三列 NOT NULL + UNIQUE(name)；status draft/active/retired；`current_version_id` 只指向 approved 版本 |
| Method 正式版本 | `agent_space_method_versions` | 引用 `user_asset_versions`（assetId/versionId/checksum），**不复制正文**；draft→approved 后不可变（UPDATE 守卫 `AND status='draft'`）；`adoption_note` 承载 W0 阻塞语义（hold/historical-not-default 等） |
| Skill（系统/用户分域） | `agent_space_skills` | `domain` system 行 scope 三列为 NULL（物理分域）；UNIQUE(domain, scope, slug) |
| Skill 私有版本 | `agent_space_skill_versions` | 引用 user_asset 版本或 system_template 路径+checksum；draft→approved 不可变 |
| SkillRelease 发布 | `agent_space_skill_releases` | 冻结 (version_id, content_checksum)；发布后私有修改不联动；visibility public/shared/private |
| Agent | `agent_space_agents` | scope + UNIQUE(name)；幂等键 |
| AgentSkillInstallation | `agent_space_agent_skill_installations` | append-only 台账：每 (agent, skill) 最新 installed 行为当前；升级必须带 approval_ref |
| AgentMethodBinding | `agent_space_agent_method_bindings` | policy pinned/current；pinned 必须是 approved/superseded 正式版本 |
| AgentAssetGrant | `agent_space_agent_asset_grants` | 引用既有 `user_assets`（跨 scope 资产拒绝）；首版 permission=read |
| TaskDependency | `agent_space_task_dependencies` | kind skill/method/asset_input/asset_output/agent_state；pinned 引用经同 scope 正式版本校验；UNIQUE(task,kind,ref) |
| TaskRunSnapshot | `agent_space_task_run_snapshots` | **不可变 append-only**：UNIQUE(run_id)；assembly_json 只含引用（对象 id/version/checksum），无正文；assembly_hash=sha256 |
| T-524 AgentFact | `agent_space_facts` | 只引用既有 trace/message/run/delivery/audit 记录；自然键幂等（表达式唯一索引） |
| T-524 AgentLesson(+versions) | `agent_space_lessons` / `agent_space_lesson_versions` | status draft/active/superseded/expired/rejected/disabled；evidence_state 与批准分离；批准绑定具体版本 |
| T-524 AgentWorkflow(+versions) | `agent_space_workflows` / `agent_space_workflow_versions` | 与 lesson 同构（工作说明，非编排引擎） |
| T-524 AgentCommitment | `agent_space_commitments` | proposed→active↔paused→cancelled/completed；active 需 authorization_ref + 同 scope 执行器存在；recurring 不因履约完成而 completed |
| T-524 履约 | `agent_space_commitment_fulfillments` | pending/running/satisfied/failed_needs_attention/skipped；绑定约定版本号 + run/产物/投递引用；UNIQUE(commitment, due_at) |
| 统一审计 | `agent_space_audit_logs` | 所有生命周期变更（含 from/to 状态、批准依据、W0 约束）落审计行 |

事实源复用（不复制）：user_assets/user_asset_versions（内容底座）、automation_tasks/runs（执行器与运行事实）、agent_traces/audit（证据引用）、review-memory（继续独立）。

## 3. 状态转换（服务层校验）

```
Method:      draft ──approve(ref)──▶ active ──retire──▶ retired
             版本: draft ──approve──▶ approved ──被新版本采用──▶ superseded / retired
Skill 私有:  draft ──approve──▶ approved（→superseded）；release: approved ──publish──▶ frozen(public/shared/private)
Agent:       draft ──▶ active ⇄ disabled
Installation: installed ──upgrade(须 approval_ref)──▶ 新行 installed（旧行 superseded）
Lesson/Workflow: draft ──approve(ref, 绑定版本)──▶ active ──revise──▶ draft(新版本)
                 active/draft ──▶ superseded | expired | rejected | disabled（终态不可再转）
Commitment:  proposed ──activate(authorization_ref + 执行器就绪)──▶ active ⇄ paused ──▶ cancelled
             one_shot active ──▶ completed；recurring 跨期保持 active
Fulfillment: pending → running → satisfied | failed_needs_attention | skipped
```

拒绝规则（服务层强制）：跨 scope 读写/批准/安装/绑定/授权/快照读取全部 `AGENT_SPACE_SCOPE_MISMATCH`；draft 不可安装/发布/解析为运行版本；无 approval_ref 不得批准/安装升级；approved 版本与 run 快照无更新路径（幂等重放返回既有行）；系统域对象不得携带用户 scope。

## 4. API 列表（`src/services/agent-space/`）

- core: `assertScopeValid` / `assertRowScope` / `recordAgentSpaceAudit` / `findByIdempotencyKey`
- methods: `createMethod` `addMethodVersion` `approveMethodVersion` `retireMethod` `resolveMethodVersion`（默认只解析当前采用版本；pin 可固定正式历史版本）`getMethod(Version)`
- skills: `upsertSkill` `addSkillVersion` `approveSkillVersion` `publishSkillRelease` `listPublicSkillReleases`（只回 public+published）`getSkill(Version)`
- agents: `createAgent` `setAgentStatus` `installSkill` `listInstalledSkills` `bindMethod` `grantAsset` `listAssetGrants`
- tasks: `upsertTaskDependency` `listTaskDependencies` `recordTaskRunSnapshot`（幂等）`getTaskRunSnapshot`
- state: `recordAgentFact` `createStateCandidate` `approveStateCandidate` `reviseStateCandidate` `transitionStateCandidate` `listEffectiveState`（active 且未过期；draft/终态排除）`createCommitment` `activateCommitment` `transitionCommitment` `recordFulfillment`

## 5. 验证证据

```
NODE_ENV=test DB_PATH=<tmp> node --import tsx --test --test-concurrency=1 --test-force-exit tests/agent-space-domain.test.ts
# → tests 10 / pass 10 / fail 0
npm test   # 全仓
# → tests 700 / pass 700 / fail 0（含新增 10 组，~50s，自终止）
npm run build   # → 0 错误
npx tsc --noEmit # → 0 错误
```

隔离测试覆盖矩阵：建表幂等重放（可重复升级）；模拟回滚（DROP 域）+ 前向修复（重放 initDb）；跨 scope 读写/批准/安装/绑定/授权/快照拒绝；draft 不可安装/发布/解析；批准绑定版本且不改证据状态；发布后私有修改不联动 release；shared 不进 public 市场；安装固定版本、升级需显式批准；方法 pin 只接受正式版本（含 superseded 可重现）；快照幂等、只含引用无正文、表达 Agent/Skill/Method/资产/状态五类依赖；fact 自然键幂等；周期承诺跨期保持 active、暂停期拒绝履约、重激活；承诺激活需授权依据+执行器就绪；每步变更落带 scope 的审计行、W0 约束进审计。

## 6. 恢复说明（rollback / forward fix）

- 全部为增量新表，不改任何既有表/列/数据；旧代码路径不读 `agent_space_*`。
- 回滚：停服后 `DROP TABLE agent_space_*`（19 张；如需保审计证据先导出 `agent_space_audit_logs`）。因域内无既有数据依赖，回滚无连带影响。
- 前向修复：迁移幂等（`CREATE TABLE IF NOT EXISTS` + `schema_migrations` checkpoint INSERT OR REPLACE），重跑 `initDb()` 即恢复域结构；已验证（测试 2）。
- 生产部署注意：遵循 db-migration 流程——先备份 DB，发布走 release 通道；本域无 backfill。

## 7. 待决项（未自行扩展）

- 对象文本→运行注入的接线（W4/W5）：`resolveMethodVersion`/`listEffectiveState` 是契约形态，尚未接入运行时装配。
- `agent_state` 依赖的 ref 校验在 W1 是占位（T-524 状态对象注册后由 W5 补全）。
- 快照不可变目前由服务层+UNIQUE(run_id) 保证；是否加 SQLite 触发器硬拒 UPDATE 留给 W5（运行写入方落地时）决定。
- Portal 信息架构、市场审核策略、发布协作对象（v3 §8 未冻结项）。
- W0 的 205 项 owner-review 候选进入 W2 时的逐项裁决流程（含 adoption_note 的呈现位置）。
