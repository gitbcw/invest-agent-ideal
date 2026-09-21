# W7 执行计划：全部用户逐批次切换（owner 已定范围：mg/111/dyk 全部）

依据：[W7-owner-cutover.md](./W7-owner-cutover.md)（owner 执行稿）、W6 验收 Preconditions、2026-09-20 owner 裁决（全部用户；docx 最小扩法已实施 `1794252`）、[T530-ab-replay-report.md](./T530-ab-replay-report.md)（真实数据隔离 A/B 回放，2026-09-21 通过 73/73、0 阻塞）、[W7-decisions.md](./W7-decisions.md)（D1–D11 全部冻结）。
本计划为窗口日操作手册：**未经 owner 确认窗口（D11 闸门），不执行任何生产步骤。**

## 0. 已就绪的前置（2026-09-20 夜完成 + 2026-09-21 T-530 回放）

| 前置 | 状态 | 证据 |
| --- | --- | --- |
| 新灾备快照 | ✅ `2026-09-20T225642+0800`（338M/1516 文件） | `…/disaster-recovery/full/2026-09-20T225642+0800/COMPLETE` |
| 新 W0 清单（r2） | ✅ 18386 项、自检 10 组全过；**gate 与原轮零漂移**（auto 93 / ownerReview 205） | `.state/agent-space-w0-r2/`（原 W0 目录原样保留） |
| 新快照读回核对 | ✅ 1365 一致 / 0 mismatch / 12 已知缺失 / 两次扫描 0 漂移 | `w0-r2/verification/readback-results.json` |
| 新快照全量演练 | ✅ 93/93 导入（docx 已随白名单放行）、306/306 检查、回滚 9/9 | `.state/agent-space-w6/20260920T23-docx/report.json` |
| docx 白名单 | ✅ owner 裁决最小扩法，`1794252` | `tests/user-asset-legacy-formats.test.ts` |
| 演练脚本可复用 | ✅ w0-root/backup-root 参数化，r2 快照零改动复跑 | 同上 |
| 真实数据 A/B 回放（T-530） | ✅ 73/73 检查、0 阻塞；A/B 装配差异、execution/delivery、引用扫描、跨 scope 反例全过；4 项新发现已冻结为 D8–D11 | `.state/agent-space-w7-replay/20260921T3/` + [T530 报告](./T530-ab-replay-report.md) |

## 0.5 窗口日执行前人工核对清单（复验 caveat 落实；任一项不符不得继续）

对每个会执行 `--confirm` 的命令（依赖注册 / deactivate 回滚），执行人必须先人工核对并留痕：

1. **目标库身份**：终端里 `echo $DB_PATH` 与本批目标库路径逐字符一致（生产为 `/home/claude/invest-agent-mastra/data/runtime.db`，以当时部署事实为准）；不依赖脚本提示，眼见为实。
2. **scope 三元组**：`--scope`/plan 内 userId 与该库 `ai_instances` 行的 user/project/instance 三元组一致（批次用户集 B1=mg / B2=dyk / B3=111；instanceId 形如 `invest-agent-<user>`）。
3. **manifest 指纹**：`--manifest-sha256` 等于本批导入实际消费的 `import-gate.json` sha256（批次日凌晨核对阶段记录的值）；指纹不符=清单已重生成，必须先重跑 W6 演练核对再考虑注册。
4. **批次归属**：`--batch` 与当前批次一致，plan 用户全部属于该批次用户集。
5. **发布与 schema 留痕**（B1 前一次）：步骤 0 的 release id/commit、schema 快检输出原文（期望 22 张表）、**结构比对输出原文（`"pass": true`，逐表 ok）**、发布后健康检查时间，已全部记入 `W7-batch-log.md`；任一不符时不得执行任何 `--confirm`。
6. **窗口授权状态**：`W7-decisions.md` D11 已由 owner 明确解除（窗口授权记录在案）；未解除时本清单全部作废。
7. 核对结果（谁、何时、各项值）记入批次执行记录（`W7-batch-log.md`，窗口日创建）。

## 1. 批次划分（执行稿要求"失败按批次回滚，不影响其他用户"）

| 批次 | 用户 | 顺序理由 | active 任务数 |
| --- | --- | --- | --- |
| B1 | mg | 方法采用路径最完整（四因子无约束），最先验证切换语义；KP/控盘度资产链最复杂 | 7（2 paused 不动） |
| B2 | dyk | 现状本就撤回策略（空方法上下文符合用户现状），切换风险最低 | 5 |
| B3 | 111 | 唯一用户策略仍在 owner-review（split-in-progress），需要 owner 提前裁决（见 §3 D6），放最后留裁决时间 | **3**（D10：按 9-20 快照事实，monthly-review 已归档；计划表原写 4 作废） |

批次间隔 ≥1 个交易日观察期；每批通过后再进下一批。

## 2. 每批步骤（窗口日，白天执行）

> **步骤 0（一次性，B1 前执行；D9）——发布与 schema 建立。** 生产尚无任何 `agent_space_*` 表（W1-W7 代码从未部署生产，T-530 发现 §5.1）：批次日必须先发布再导入。
>
> 0a. **发布当前 main**：白天执行 `RELEASE_COMMIT=<发布 commit> scripts/deploy-volcano.sh`（构建感知流程：rsync 源码 → 远程 npm install + build → pm2 restart mastra-portal；发布脚本自带 portal 构建失败自动恢复）。记录 release id/commit 进批次日志。
> 0b. **schema 建立核对**（发布重启后、任何导入前；目标库只读零写入）——两段：
>
> **快检（表名齐全）**：
> ```bash
> ssh claude@118.145.115.197 'cd /home/claude/invest-agent-mastra && node -e "
> const Database = require(\"better-sqlite3\");
> const db = new Database(\"data/runtime.db\", { readonly: true });
> const rows = db.prepare(\"SELECT name FROM sqlite_master WHERE type=\x27table\x27 AND name LIKE \x27agent_space%\x27 ORDER BY name\").all().map(r => r.name);
> console.log(JSON.stringify({ count: rows.length, tables: rows }, null, 1));
> "'
> ```
> 期望 **22 张表**（名单见下）。数量或名单不符 = 发布未生效或 initDb 异常，**不得继续**，先查 pm2 日志。
>
> **结构比对（权威门；T-531 复验补强项——表名存在但结构不完整的拦截）**：用部署代码自身的 initDb 在服务器临时目录生成参照库，与生产库逐表比对列名序列、非自动索引、唯一约束（migration 标记机制不存在，代码即权威）：
> ```bash
> ssh claude@118.145.115.197 'cd /home/claude/invest-agent-mastra && node scripts/agent-space/w7-verify-schema.mjs --db data/runtime.db'
> ```
> 期望 `"pass": true`（22 张表逐表 `ok`），exit 0。任何 `missing-columns` / `missing-indexes` / `missing-unique-constraints` / `unexpected-columns` = 结构不完整或残留旧结构，**不得继续**。生产库全程只读；参照库是临时文件、退出即删。红绿两面已在隔离库实测（缺列/缺索引分别被精确报出）。
> 期望表名单：agent_space_agents / agent_space_agent_asset_grants / agent_space_agent_method_bindings / agent_space_agent_skill_installations / agent_space_audit_logs / agent_space_authorizations / agent_space_commitment_fulfillments / agent_space_commitments / agent_space_facts / agent_space_lesson_versions / agent_space_lessons / agent_space_method_versions / agent_space_methods / agent_space_run_basis / agent_space_run_outcomes / agent_space_skill_releases / agent_space_skill_versions / agent_space_skills / agent_space_task_dependencies / agent_space_task_run_snapshots / agent_space_workflow_versions / agent_space_workflows。
> 0c. **发布后行为核对**：`AGENT_SPACE_ASSEMBLY_MODE` 未设置（默认 off）时新代码行为与旧一致（W4 契约"关闭时行为逐字不变"）；pm2 重启后 Portal 健康检查通过、生产巡查关键任务正常一次调度，作为发布无回归证据留痕。
> 0d. 步骤 0 全部留痕（release id/commit、schema 输出原文、健康检查时间）记入 `W7-batch-log.md`。

1. **冻结清单**：批次日凌晨新灾备快照 + `w0-rehearsal` staging 段重核对（hash 漂移=该项拦截，机器规则执行）；记录本批 manifest hash。
2. **导入前快照**：生产 DB `sqlite-online-backup`（WAL 安全点）落批次目录，记录 sha256。
3. **写入新对象**：`w6-rehearsal.mjs` 的导入器按 scope 过滤只导本批用户 93 项中该用户份额（幂等键 `w6:<itemId>`，重跑零新增）；全部 draft 归档态，不改任何既有行。
4. **Agent 与技能初始化**：`createAgent`（active，幂等键约定 `w7:<userId>:agent`——scope 回滚按 `w6:*|w7:*` 键识别批次 Agent）+ `applyDefaultSkillManifest`（one-time init，幂等）。
5. **授权采用（§3 决策点执行）**：仅 [W7-decisions.md](./W7-decisions.md) 中已冻结的 decided 项走 approve/adopt；其余保持归档。**该批用户涉及决策未全部冻结前，不得执行步骤 8。**
6. **任务依赖注册**：`w7-register-task-deps.mjs`（本计划交付）把已冻结批准的方法 pin 到有方法消费者的 active 任务；无方法消费者的任务不注册（空装配=显式空集，方法论指令明示"未装配不可引用"）。confirm 必须携带 `--target isolated|production --w0-root --manifest-sha256 --batch`（目标库身份护栏；production 拒绝 NODE_ENV=test；plan 用户必须属于批次用户集）。
7. **smoke（每批三件，机器采证）**：① 会话一条真实消息→basis 落库含采用方法、回复正常；② 手动触发 daily-review→run basis+outcome+交付链正常；③ 跨 scope 读拒绝抽查。采证用 `scripts/agent-space/w7-smoke.mjs --scope <userId>`（只读，输出 basis/outcome/delivery 事实链与隔离抽查 JSON；R1 接缝后 execution/delivery outcome 由终态咽喉点与投递接缝自动产生，无需人工写入）。
8. **切换 resolver**：生产 env `AGENT_SPACE_ASSEMBLY_MODE=scope:<本批用户>` → 白天重启 `mastra-portal`（装配在进程内读 env）。切换后旧 liveProjectRoot 文件原样留在磁盘（服务层/审计/回滚仍可用），但**模型边界不再挂载**：T-530 实测 B 侧 workspace 工具=0、技能元数据=0（D8 预期）。旧容器（legacy workspace）保持 history-only 不变。
9. **观察与证据**：采集本批真实 run-basis/audit/任务交付（W5 outcome 事实源核对）；检查旧 default-load 计数归零路径、无双写、无未迁移引用报警。
10. **失败回滚（R2：scope 隔离补偿，禁止整库恢复作默认）**：首选 `AGENT_SPACE_ASSEMBLY_MODE` 移除该 scope/置 off + 白天重启（零数据操作，立即生效）；如需数据级停用本批对象，用 `scripts/agent-space/w7-rollback-scope.mjs --scope <userId> --level deactivate --target production --confirm`（前向补偿：仅停用本 scope 的 w6:* 对象/Agent/依赖，不覆盖窗口期间任何写入）。**整库快照恢复不作批次回滚手段**——仅 owner 明确批准的维护窗口内、阻断相关写入、核对快照后变更清单后另行执行；W6 隔离整库 rollback 证据不适用于生产。

### 发布/回滚边界（D11 要求显式化）

| 层 | 前滚动作 | 回滚动作 | 边界事实 |
| --- | --- | --- | --- |
| 代码 | 步骤 0 发布 main（deploy-volcano.sh，构建感知） | `RELEASE_OPERATION=rollback` 走 `.deploy` 存档恢复上一构建 + pm2 restart | 发布脚本自带构建失败自动恢复 portal；schema 为增量建表（`CREATE TABLE IF NOT EXISTS`），**代码回退不删表、旧代码不读新表，残留空表无害**；`AGENT_SPACE_ASSEMBLY_MODE` 未设置时新代码行为与旧一致（W4 契约"关闭时行为逐字不变"），因此"已发布未切换"是安全驻留态 |
| resolver | 步骤 8 设置 scope env + 白天重启 | 移除该 scope/置 off + 白天重启（零数据操作） | env 是唯一开关；切换/回退均不动数据 |
| 数据（w6/w7 对象） | 步骤 3-6 导入/注册（幂等键 `w6:*`/`w7:*`，重跑零新增） | `w7-rollback-scope.mjs --level deactivate`（前向补偿，仅本批对象；批次 Agent/依赖/方法按幂等键与注册元数据识别，非批次对象不动——W7 验收 R2 诱饵测试覆盖） | 导入只新增行不改既有行；deactivate 不删除数据（停用态可审计） |
| 整库快照 | 步骤 2 导入前快照（留档） | **不作批次回滚手段**；仅 owner 批准的维护窗口内、阻断写入、核对变更清单后另行执行 | 窗口期间其他用户写入会被整库恢复覆盖（R2 结论） |

## 3. 授权决策点（已全部冻结，2026-09-21）

冻结状态与依据见 [W7-decisions.md](./W7-decisions.md)（唯一权威记录；下表为冻结结论概览）。

| # | 决策 | 冻结结论 | 影响面 |
| --- | --- | --- | --- |
| D1 | mg 四因子 `methods/控盘度综合评分.md` approve+adopt | **采用**（无约束、156 次真实读取、任务消费者 at_d64649ad） | B1 切换后 mg 方法上下文保留 |
| D2 | mg strategy-rules（hold-ambiguity） | **保持 owner-review**（W0 已裁决 hold） | mg 策略上下文维持现状受限 |
| D3 | mg 旧 KP V1.0（historical-not-default） | **保持**（历史定位，服务层永久阻塞） | 无 |
| D4 | dyk 撤回策略 strategy-rules | **保持归档**（撤回语义） | dyk 空方法上下文=用户现状 |
| D5 | dyk 核心模型 fundamental（restore-candidate） | **继续留 owner-review 队列**；dyk 空方法上下文为其现状预期 | B2 切换后不恢复六维模型（恢复留作后续独立裁决） |
| D6 | 111 strategy-rules（split-in-progress） | **选 b：接受 B3 切换后无方法上下文**（日复盘主要由任务模板驱动）；策略继续留 owner-review，拆分裁决留作 W7 后独立工作 | B3 按计划执行 |
| D7 | 205 项 owner-review 其余项 | **W7 不处理**（继续留可发现队列）；是否逐项裁决为 W7 后独立工作 | 无 |
| D8 | 切换后默认技能面空集 | **接受**：按方法绑定与任务模板运行；默认技能发布属 owner 后续独立治理 | 三用户切换后技能元数据/技能工具归零为预期（T-530 实测 A=12 命中/7 工具 → B=0/0） |
| D9 | 生产 schema 前置 | **批次日步骤 0**：发布当前 main → 22 张 agent_space 表核对通过 → 才允许导入/注册/resolver | 见 §2 步骤 0 |
| D10 | 111 active 任务数 | **按事实 3 个执行**（monthly 已归档；计划表原 4 作废） | B3 批次对象以导入时生产核对为准 |
| D11 | 生产窗口授权 | **暂缓**：手册/schema 核对/发布回滚边界修订回传后，owner 明确授权前禁止生产 `--confirm`、resolver 切换、真实消息、真实用户写入 | 全局闸门，覆盖步骤 0 起的全部生产动作 |

## 4. 旧入口退出（兼容窗口，非本计划一次完成）

切换后持续检查（执行稿要求）：旧 default-load（SKILL.md 元数据入口）读取计数、双写（导入后旧 workspace 写入）、未迁移引用（任务 revision 引用旧路径）。三项持续为零且 owner 明确批准后，才移除旧运行入口；**物理删除历史不是默认目标，需另行授权**。

## 5. 本轮新增工程资产

| 资产 | 位置 | 用途 |
| --- | --- | --- |
| 任务依赖注册脚本 | `scripts/agent-space/w7-register-task-deps.mjs` | 窗口日步骤 6；目标库身份护栏（target/manifest 指纹/批次）；affected 前后清单；幂等 |
| scope 补偿回滚脚本 | `scripts/agent-space/w7-rollback-scope.mjs` | 窗口日步骤 10；switch-only（默认零操作）与 deactivate（前向停用本批对象）两级 |
| smoke 采证脚本 | `scripts/agent-space/w7-smoke.mjs` | 窗口日步骤 7；basis/outcome/delivery 事实链与隔离抽查一次成证（只读） |
| W5 outcome 运行链接缝 | `automation-tasks.ts finishAutomationTaskRun` + `push-queue.ts syncAutomationDelivery` | execution outcome 随 run 真实终态自动落库（所有入口单咽喉点）；delivery outcome 随投递终态+origin_run_id 自动落库 |
| generic runner 上游端到端测试 | `tests/agent-space-generic-e2e.test.ts` | 装配 on 下从 `runGenericAutomationTaskNow`（真实上游生命周期）驱动到模型边界；断言 execution_succeeded/failed 与 delivery_succeeded 自动产生 |
| 真实数据 A/B 回放脚本（T-530） | `scripts/agent-space/w7-ab-replay.mjs` | 批次前可复跑的隔离 A/B 验证（快照副本+假网关）；护栏：外部设 AGENT_SPACE_ASSEMBLY_MODE 拒跑、快照零写入 |
| 生产 schema 结构核验脚本（T-531 复验补强） | `scripts/agent-space/w7-verify-schema.mjs` | 步骤 0b 权威门：部署代码 initDb 生成参照库与生产库只读逐表比对（列/索引/唯一约束）；stdout 纯 JSON；红绿两面已实测 |
| T-530 回放报告 | `T530-ab-replay-report.md` | 切换前输入：A/B 装配差异、execution/delivery 证据、引用扫描、4 项新发现（D8–D11 依据） |
| 决策冻结记录 | `W7-decisions.md` | D1–D11 状态与依据；pending 决策阻塞对应批次 resolver；D11 为窗口全局闸门 |

## 6. 窗口日不做的事

- 不删除/不改动旧 Workspace 任何文件（history-only 过渡）。
- 不动生产 `.env`/微信/调度配置（除步骤 0 的发布与步骤 8 的装配开关 env 一项）。
- 不迁移 keep-authoritative DB 权威资产（资产绑定链继续走既有 automation 表）。
- 晚间不做生产操作（白天偏好）；**D11 生效中：owner 明确窗口授权前，本计划任何生产步骤（含步骤 0 的发布）均不执行**。
