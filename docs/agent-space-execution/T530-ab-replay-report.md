# T-530 交付：真实用户数据隔离回放与新旧装配 A/B 验证

日期：2026-09-21；任务 T-530（T-524 W7 前置）；正式证据目录 `.state/agent-space-w7-replay/20260921T3/`（gitignored、0700/0600；`20260921T1/T2` 为调试痕迹，其发现已并入本报告）。

## 结论

**回放通过：73/73 机器检查全绿、0 高风险阻塞项。** 用 mg/dyk/111 的真实历史数据（灾备快照副本）在隔离环境中完成了旧 Workspace 装配（A）与新 Agent Space 装配（B）的同任务对照回放：装配差异、run-basis、execution/delivery outcome、跨 scope 反例、未迁移引用全部有机器证据。**同时发现 4 项 T-531 必须消化的新事实，其中 1 项（生产尚无 agent_space 表，切换隐含代码发布前置）需 owner 知情后列入 T-531 批次日步骤 0。**

回放纪律：全程隔离 DB/隔离项目根/假模型网关/假投递 sender；快照 DB 以 readonly 打开只 SELECT；未连接生产 DB、未发送真实消息、未修改真实 Workspace。任何 Unknown 未写成通过；仍需真实 smoke 的结论单独列出（§6）。

## 0. 数据源与输入指纹

| 输入 | 值 |
| --- | --- |
| 灾备快照（真实数据源） | `…/disaster-recovery/full/2026-09-20T225642+0800`（runtime.db sha256 见 `00-inputs/input-facts.json`） |
| W0 清单 | `.state/agent-space-w0-r2/`，import-gate sha256 见同上 |
| 真实 liveProjectRoot 树 | 快照 `runtime-data/projects/{0561c9…,10849b…,2df517…}`（mg/111/dyk，按 scope digest 校验一致） |
| 真实任务/revision/资产行 | 快照 DB 只读提取：mg 7 / dyk 5 / 111 3 个 active 任务的当前 revision 及引用资产行，复制进隔离库 |
| 回放脚本 | `scripts/agent-space/w7-ab-replay.mjs`（复跑命令见 §7） |

复制完整性：三用户树复制后与 W0 r2 清单逐路径比对，缺失仅 mg 的 6 个 `logs_2.sqlite` WAL 组文件（W0 已知阻塞"无备份"，非复制缺陷）；反向多出的文件为 DB 资产版本字节层（快照晚于清单扫描时点的正常差异）。

## 1. A/B 装配差异（同任务同假网关对照）

回放任务：各用户真实 `migrated_scheduled-daily-review_*`（output none + delivery wechat_summary），A=装配开关 off（现生产行为），B=`AGENT_SPACE_ASSEMBLY_MODE=scope:<user>`。

| 维度 | A（旧 Workspace） | B（新 Agent Space） |
| --- | --- | --- |
| run 状态 | succeeded（3/3 用户） | succeeded（3/3 用户） |
| system 大小 | 3449 chars | 1722-1723 chars（装配段替代平台旧指令差异见 hash） |
| 技能元数据 default-load 命中 | **12 次**（6 技能 × 2：automation-task-designer / candidate-screening / fundamental-analysis / macro-analysis / risk-control / technical-analysis） | **0 次** |
| workspace 工具 | 7 个（read/write/edit/list/mkdir/grep 等） | **0 个**（injection.workspace=null 落库） |
| 技能工具（skill/skill_search/skill_read） | 3 个 | 0 个 |
| 工具面总量 | 20 | 11（file_parse/research_*/assets_version_read/portfolio_read/watchlist_read/plans_read/reviews_save/spreadsheet_*） |
| run basis | **不落库**（现生产行为） | 全部落库（entryKind=generic_automation，含 resolution+injection） |
| 旧路径泄漏 | — | system 无任何快照/清单路径（hash 级核对） |

无方法依赖任务的 B 侧装配为**显式空集**并携带机器原因：`task-declares-no-dependencies: explicit empty assembly (legacy tasks must declare dependencies before agent-space execution)`——与 W7 计划步骤 6"无方法消费者不注册=显式空集"语义一致。

### 会话与四因子消费任务（服务层装配级回放）

- mg 会话 basis：解析到 D1 采用的四因子方法（checksum `ea02397b…` 与源字节一致，版本 pin）；真实消费任务 `at_d64649ad`（scheduled 入口）装配封闭于声明依赖：恰好 1 个方法、无夹带、无旧路径。
- dyk / 111 会话 basis：方法为空（D4/D5/D6 决策预期），skipped 原因可查。

## 2. 任务运行 / execution / delivery 证据

- daily-review A/B 各 3 用户全部 succeeded；假网关以**真实 `reviews.save` 工具调用循环**满足复盘产物发布不变量（`REVIEW_ARTIFACT_NOT_PUBLISHED` 域校验在隔离库真实执行并通过）。
- execution outcome：`finishAutomationTaskRun` 咽喉点自动落库——成功轮 `execution_succeeded`（6/6），失败反例轮（mg weekly-review 模拟网关 outage）`execution_failed` 自动落库且 **basis 保留为失败证据**。
- delivery：6/6 push job（A/B 各 3）带 `origin_run_id` 入队，假 sender 消费后全部 `sent`，`delivery_succeeded` outcome 与 job 终态/归属逐条一致。

## 3. 决策 D1–D7 落库验证（隔离库）

D1 采用生效（approve+adopt+bind+pin）；D2/D3 mg strategy 与旧 KP 不在运行对象、owner-review 可发现；D4 dyk 策略 draft 归档未采用；D5 dyk 核心模型未导入但队列可发现；D6 111 无方法。全部与 [W7-decisions.md](./W7-decisions.md) 冻结结论一致（`02-new-side/03-decisions/decisions.json`）。

## 4. 未迁移引用扫描（真实 revision 双侧比对）

- **路径引用：三用户 0 条。** 真实任务 revision 的 inputs/output/delivery/instruction 中没有任何 `methods/`、`reports/` 等旧路径引用。
- **mg 标题引用 7 条全部有归属**：《控盘度综合评分》《控盘度操盘文档 V1.1》《2026-08-25 持仓与关注股日复盘明细》已导入或 DB 资产；《行业复盘》走 DB 资产绑定（keep-authoritative 链，切换不动）；《日复盘模板配置》《YYYY-MM月…》《个股明细》旧侧本就无文件（模板语义在任务配置/rollover 模式里，非文件对象）——**无任何"切换后失去可达性"的引用**。
- **资产引用**：mg 2 个 assetId（at_60d62fcb / at_d64649ad 的 update 目标）在隔离库行+字节双可解析（真实资产链字节读取通过）；dyk/111 引用为空。
- 跨 scope 反例：三用户导入资产跨 scope 读取拒绝、同 scope 可读、跨 scope basis 读取拒绝，全部通过。

## 5. 新发现（T-531 输入，按影响排序）

1. **[高｜批次日步骤缺失] 生产尚无任何 agent_space 表。** 快照 DB（9-20 22:56 生产副本）中 `agent_space_*` 全部不存在——W1-W7 代码从未部署生产。W7 执行计划 §2 步骤 3-6 使用的导入器/服务在生产上不存在，**批次日必须先发布当前 main（rsync dist + pm2 restart）并确认生产 initDb 建表成功**，才能执行导入。该"步骤 0"未写入计划；建议 T-531 领取时补入批次核对清单（连同发布后 `w7-smoke` 前置核对）。
2. **[中｜计划数字过时] 111 active 任务为 3 个而非计划表的 4 个。** 快照显示 `migrated_scheduled-monthly-review_9e574769` 已 archived（W7 计划 §1 表按 9-20 01:05 旧快照写的 4）。批次语义不变（B3 仍按 3 任务执行），计划表数字需在 T-531 更正。
3. **[中｜owner 知情点] 切换后技能面为空集是设计内但需知情。** A 侧每轮注入 6 条技能元数据 + 3 个技能文件工具；B 侧 0/0。原因：默认技能清单依赖 owner 治理的系统默认发布（W3-R2：空清单也记录完成），而生产从未发布过任何默认 release——切换后三用户技能面为空，直到 owner 显式发布默认技能。daily-review 类任务由模板驱动不受影响（本轮已证），交互轮的技能上下文补偿依赖已采用方法（仅 mg 有）。若 owner 认为需要技能面，需在窗口前另行决策发布默认技能，不阻塞 T-531。
4. **[低｜回放边界] 复盘产物不变量无法用"纯 JSON 假模型"回放。** daily/weekly/monthly review 任务必须真实调用 `reviews.save` 且服务端回读 artifact 后 run 才成功（`REVIEW_ARTIFACT_NOT_PUBLISHED:daily:<date>`）。本轮假网关以两步工具调用循环覆盖；真实模型的产物质量与格式仍属 smoke 范围（§6）。

## 6. 仍需真实 smoke 的结论（不得由本轮回放替代）

1. 会话入口全链路（Portal 真实消息 → basis → 回复）——本轮会话 basis 为服务层驱动。
2. 真实模型输出质量/格式（本轮为假网关固定响应 + 单工具循环）。
3. 真实微信投递终态（本轮 sender 为注入假函数）。
4. 调度器自然触发（本轮为 manual 触发 generic runner）。
5. mg `at_d64649ad` 全链路模型运行（本轮为装配级 basis 验证；output update 工作簿链需真实模型输出）。
6. 生产 DB 资产绑定链与生产 liveProjectRoot 的物理一致性（本轮基于 9-20 快照副本；批次日按计划重跑 W6 演练核对）。

## 7. 复跑与证据

```
RUN=.state/agent-space-w7-replay/<新runTs> && mkdir -p $RUN/isolated/{workspaces,projects,templates,runtime}
DB_PATH=$PWD/$RUN/isolated/w7ab.db WORKSPACE_ROOT=$PWD/$RUN/isolated/workspaces \
RUNTIME_DATA_ROOT=$PWD/$RUN/isolated/runtime MASTRA_PROJECTS_ROOT=$PWD/$RUN/isolated/projects \
SYSTEM_SKILLS_TEMPLATE_ROOT=$PWD/$RUN/isolated/templates NODE_ENV=test WORKSPACE_BACKEND=mastra \
node --import tsx scripts/agent-space/w7-ab-replay.mjs \
  --w0-root .state/agent-space-w0-r2 \
  --backup-root /Users/combo/MyFile/my-data/backups/invest-agent/disaster-recovery/full/2026-09-20T225642+0800 \
  --out-root $PWD/$RUN
```

产物结构：`00-inputs`（指纹）/`01-old-side`（旧侧清点+技能元数据）/`02-new-side`（导入+决策落库）/`03-runs`（run-evidence：system 只存 hash/字符数/标记位，不落正文）/`04-references`（引用扫描）/`report.json`（73 项检查与 A/B 汇总）。脚本护栏：外部设置 `AGENT_SPACE_ASSEMBLY_MODE` 时拒绝启动（A/B 由脚本逐轮控制）；快照目录零写入。
