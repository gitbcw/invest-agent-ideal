# W7 执行计划：全部用户逐批次切换（owner 已定范围：mg/111/dyk 全部）

依据：[W7-owner-cutover.md](./W7-owner-cutover.md)（owner 执行稿）、W6 验收 Preconditions、2026-09-20 owner 裁决（全部用户；docx 最小扩法已实施 `1794252`）。
本计划为窗口日操作手册草案：**未经 owner 确认窗口与逐项授权决策，不执行任何生产步骤**。

## 0. 已就绪的前置（2026-09-20 夜完成）

| 前置 | 状态 | 证据 |
| --- | --- | --- |
| 新灾备快照 | ✅ `2026-09-20T225642+0800`（338M/1516 文件） | `…/disaster-recovery/full/2026-09-20T225642+0800/COMPLETE` |
| 新 W0 清单（r2） | ✅ 18386 项、自检 10 组全过；**gate 与原轮零漂移**（auto 93 / ownerReview 205） | `.state/agent-space-w0-r2/`（原 W0 目录原样保留） |
| 新快照读回核对 | ✅ 1365 一致 / 0 mismatch / 12 已知缺失 / 两次扫描 0 漂移 | `w0-r2/verification/readback-results.json` |
| 新快照全量演练 | ✅ 93/93 导入（docx 已随白名单放行）、306/306 检查、回滚 9/9 | `.state/agent-space-w6/20260920T23-docx/report.json` |
| docx 白名单 | ✅ owner 裁决最小扩法，`1794252` | `tests/user-asset-legacy-formats.test.ts` |
| 演练脚本可复用 | ✅ w0-root/backup-root 参数化，r2 快照零改动复跑 | 同上 |

## 1. 批次划分（执行稿要求"失败按批次回滚，不影响其他用户"）

| 批次 | 用户 | 顺序理由 | active 任务数 |
| --- | --- | --- | --- |
| B1 | mg | 方法采用路径最完整（四因子无约束），最先验证切换语义；KP/控盘度资产链最复杂 | 7（2 paused 不动） |
| B2 | dyk | 现状本就撤回策略（空方法上下文符合用户现状），切换风险最低 | 5 |
| B3 | 111 | 唯一用户策略仍在 owner-review（split-in-progress），需要 owner 提前裁决（见 §3），放最后留裁决时间 | 4 |

批次间隔 ≥1 个交易日观察期；每批通过后再进下一批。

## 2. 每批步骤（窗口日，白天执行）

1. **冻结清单**：批次日凌晨新灾备快照 + `w0-rehearsal` staging 段重核对（hash 漂移=该项拦截，机器规则执行）；记录本批 manifest hash。
2. **导入前快照**：生产 DB `sqlite-online-backup`（WAL 安全点）落批次目录，记录 sha256。
3. **写入新对象**：`w6-rehearsal.mjs` 的导入器按 scope 过滤只导本批用户 93 项中该用户份额（幂等键 `w6:<itemId>`，重跑零新增）；全部 draft 归档态，不改任何既有行。
4. **Agent 与技能初始化**：`createAgent`（active）+ `applyDefaultSkillManifest`（one-time init，幂等）。
5. **授权采用（§3 决策点执行）**：仅 owner 批准项走 approve/adopt；其余保持归档。
6. **任务依赖注册**：`w7-register-task-deps.mjs`（本计划交付）把 §3 批准的方法 pin 到有方法消费者的 active 任务；无方法消费者的任务不注册（空装配=显式空集，方法论指令明示"未装配不可引用"）。
7. **smoke（每批三件）**：① 会话一条真实消息→basis 落库含采用方法、回复正常；② 手动触发 daily-review→run basis+outcome+交付链正常；③ 跨 scope 读拒绝抽查。
8. **切换 resolver**：生产 env `AGENT_SPACE_ASSEMBLY_MODE=scope:<本批用户>` → 白天重启 `mastra-portal`（装配在进程内读 env）。旧 Workspace 在切换后仍可读（history-only 过渡），仅不再默认装配。
9. **观察与证据**：采集本批真实 run-basis/audit/任务交付（W5 outcome 事实源核对）；检查旧 default-load 计数归零路径、无双写、无未迁移引用报警。
10. **失败回滚**：开关回 `off`+重启（即时生效、对象保留不动）；必要时恢复步骤 2 快照（W6 已验证对象级清零流程）。

## 3. 授权决策点（owner 逐项，窗口日前必须定）

| # | 决策 | 建议 | 影响面 |
| --- | --- | --- | --- |
| D1 | mg 四因子 `methods/控盘度综合评分.md` approve+adopt | 建议**采用**：无约束、156 次真实读取、任务消费者 at_d64649ad | B1 切换后 mg 方法上下文（不采用则空） |
| D2 | mg strategy-rules（hold-ambiguity） | 建议**保持 owner-review**（W0 已裁决 hold） | mg 策略上下文维持现状受限 |
| D3 | mg 旧 KP V1.0（historical-not-default） | **保持**（历史定位，服务层永久阻塞） | 无 |
| D4 | dyk 撤回策略 strategy-rules | **保持归档**（撤回语义） | dyk 空方法上下文=用户现状 |
| D5 | dyk 核心模型 fundamental（restore-candidate） | 窗口日前 owner 裁决：恢复采用 or 继续留队列 | dyk 切换后是否恢复六维模型 |
| D6 | 111 strategy-rules（split-in-progress） | 三选一：a) 先裁决策略/模板拆分再切 B3；b) 接受 B3 切换后 111 无方法上下文（日复盘主要由任务模板驱动）；c) B3 延后 | B3 时点 |
| D7 | 205 项 owner-review 其余项 | W7 **不处理**（继续留可发现队列）；是否逐项裁决为 W7 后独立工作 | 无 |

## 4. 旧入口退出（兼容窗口，非本计划一次完成）

切换后持续检查（执行稿要求）：旧 default-load（SKILL.md 元数据入口）读取计数、双写（导入后旧 workspace 写入）、未迁移引用（任务 revision 引用旧路径）。三项持续为零且 owner 明确批准后，才移除旧运行入口；**物理删除历史不是默认目标，需另行授权**。

## 5. 本轮新增工程资产

| 资产 | 位置 | 用途 |
| --- | --- | --- |
| 任务依赖注册脚本 | `scripts/agent-space/w7-register-task-deps.mjs` | 窗口日步骤 6；按 §3 批准项把方法 pin 到任务（幂等） |
| generic runner 上游端到端测试 | `tests/agent-space-migration.test.ts` 新组 | 补 W4 遗留：装配 on 下从 `runGenericAutomationTaskNow`（真实上游生命周期）驱动到 handleMessage 模型边界 |

## 6. 窗口日不做的事

- 不删除/不改动旧 Workspace 任何文件（history-only 过渡）。
- 不动生产 `.env`/微信/调度配置（除步骤 8 的装配开关 env 一项）。
- 不迁移 keep-authoritative DB 权威资产（资产绑定链继续走既有 automation 表）。
- 晚间不做生产操作（白天偏好）；窗口未定前本计划不执行。
