# 客户体验受阻信号自动采集机制设计

状态：**已采纳（owner 2026-09-03 裁决），进入实施**——落地任务 T-442（2026-09-02 起草）

## 一、要解决的问题

"产品好用不好用"目前没有客观信号：客户哪里卡住、哪个环节反复重来、哪些推送没送达，全靠 19:15 巡查偶然发现或客户主动抱怨。本设计把受阻信号变成自动采集、周期产出的清单，作为「好用」主线的度量底座。

## 二、定位与边界（先划清，避免与既有裁决冲突）

- **本设计是日/周级体验度量，不是即时告警**。即时告警/分诊已在 T-403 完成设计并由 owner 于 2026-08-28 裁决"共创期不做实施"（重启条件：正式上线，或再次出现客户先于我们发现的支柱场景失败）。两条线的边界：T-403 管"发现→即时触达/分诊"，本设计管"体验受阻的持续度量与排序"。
- **只读红线**：全部信号来自生产库/既有落库数据的只读查询；生产零改动、零新表、零部署。与 T-403 同哲学：生产→本机用拉不用推。
- **共创期轻量**：≤10 用户，先聚合元数据（次数、签名、客户、时间），不逐条读消息正文；挖掘类信号只做关键词与行为启发式，不做内容分析。

## 三、信号源清单（六类）

| # | 信号源 | 受阻信号定义 | 现状基础 |
| --- | --- | --- | --- |
| S1 | `automation_task_runs` | run failed / 超时 / **应跑未跑** / consecutive_failures≥2 / **手动补跑**（人工恢复本身即受阻证据） | T-403 已验证签名聚合方法（14 天 55 失败→15 签名：error_category + 标准化 error_message 前缀）；19:15 巡查已覆盖 failed 部分 |
| S2 | `push_jobs` / `weixin_delivery_attempts` | dead / failed 投递（客户没收到）。注意排除：`awaiting_user`（context_expired 挂起）是设计内行为，不计受阻 | 巡查已逐日核 push 队列；本设计只新增"按客户×通道聚合"视角 |
| S3 | `conversation_messages`（挖掘类） | 催补/抱怨关键词命中；**短窗口重复同类请求**（如 T-317 期间 mg 一天三连发催补）；会话发起后无回复即离开 | 催补关键词最小化查询巡查已在用（T-317 盯防口径）；本设计扩展为按客户×主题聚合 |
| S4 | `agent_traces` | 首字延迟>30s 的轮次、失败轮、单轮成本突增（>¥1） | trace 落库完整（first_token_ms / cost / status 均有） |
| S5 | `external_mcp_tool_calls` | 工具调用失败率、降级发生（空工具集继续作答的轮次占比） | W4 observer 收口点已恢复记录（chat + scheduled 双路径） |
| S6 | Portal 喜欢/不喜欢反馈 | 点踩（含选填反馈文本）；点赞/点踩比 | 交互 8-28 已重做（选中填充隐藏对侧+点踩弹窗）；数据已落库，落地时确认表名 |
| S7 | 诊断链关联缺口（2026-09-06 增，治理闭环 T-467） | 当日 audit trace 覆盖率 <100%（排除 2026-08-24 前历史行）；automation trace 关联 <99%（排除 error_category=expired 的模型前失败）；push/delivery origin 关联 <100%；微信通道 MCP 未解析条数（GAP-20260906-1 修复前记趋势不告警，修复后归零再出现即告警） | 基线与处置三分法（历史/n.a.白名单/新代码立案）见 [diagnostic-coverage-report-2026-09-06.md](./diagnostic-coverage-report-2026-09-06.md)；n.a. 白名单：无模型轮次的规则任务、reviews.save 定时产物、模型启动前过期失败的 run |

P2 可选扩展（首版不做）：功能绕开信号——客户在产品外完成产品内已有能力（如本地 Excel 替代复盘库），需要人工访谈交叉验证，不适合自动采集，仅留清单字段供周会人工标注。

## 四、受阻点数据模型（本机落档，不建生产表）

每条受阻点（friction point；2026-09-06 T-469 扩展语义信号字段）：

```
id: FP-YYYYMMDD-NN
信号源: S1~S7
信号性质: program | semantic（semantic=程序层成功/无程序信号但用户结果受损）
来源四类（semantic 必填其一）: user_feedback | manual_finding | eval_failure | repeat_fix
类别: 任务失败漏跑 | 投递未达 | 催补抱怨 | 延迟异常 | 工具降级 | 主动反馈 | 语义失败
程序层状态: succeeded | failed | partial | unknown（semantic 信号的关键区分字段）
证据: 签名/关键词/trace id 列表（只存指针，不复制正文）
影响客户: mg / dyk / 111 / all
频次: 窗口内次数（周级聚合）
首次发现 / 最近发生: 时间戳
状态: open → acknowledged → fixed → verified（复用巡查验证）
关联: 修复 commit / BC-xxx / EV-xxx（转评估样例时回填）
taxonomy_ref: failure-taxonomy 分类号；未入表的新类写「ED-P1 增补建议」
rubric_ref: 关联评分记录（week + sample_ref，来自 eval-rubric-scores）
```

落档位置：`data/friction-reports/`（周清单 + 周期性聚合 JSON，本机仓库外运行数据，同 patrol-reports 惯例）。

## 五、采集与产出节奏（owner 2026-09-02 裁决定稿；调度载体同日二次裁决：弃 ZCode 自动化，改 Mac 本机 hermes）

- **调度载体**：全部使用 Mac 本机 `hermes cron`（ZCode 自动化的派发宿主在 Windows、与项目环境错位，2026-09-02 全部下线）；任务总结经 Deliver 自动推送 owner QQ。hermes 侧 personal-os MCP 已启用（任务登记与 ZCode 会话同库，已验证）。
- **日级（每日 19:15，hermes 任务「生产三用户巡查（受阻信号版）」dba0e947676b）**：巡查报告「受阻信号聚合」节（S1~S6 纯 SQL 聚合，隐私边界=只计数与签名，不摘录正文），同时落结构化受阻点 `data/friction-reports/YYYY-MM-DD.json`（跨日签名去重、open/verified 状态流转、全零也落空数组）。2026-09-02 12:50 已手动触发验证跑通（22 分钟完整产出，报告+JSON+任务登记+QQ 推送全链）。
- **周级（每周两次；hermes 任务「受阻点周清单」周一早 08:30 `65230bd55a71` / 周四晚 20:00 `e9661f953d81`；稳定 4 周后由 owner 裁决是否降为每周一次）**：汇总窗口内日级 JSON → `data/friction-reports/friction-weekly-<日期>.md`：open 总表、新增/verified/复发统计、Top 3-5 排序（影响客户权重 × 频次 × 复发）、ED-P1 错误分析候选 2-3 例（附 trace_id/报告路径）；总结推送 owner QQ，清单文件落档。
- **月级视图**：复发率（同签名关了又开）+ 受阻点存量趋势——"好用是否在变好"的趋势指标，并入周清单的跨周对比段（FP-P2）。

## 六、消费方（回答 T-442 立项时的开放问题）

1. **owner 周度排优先级**：周清单即「好用」主线的输入，替代拍脑袋决定先修什么。
2. **评估深化线（联动）**：高频/复发受阻点 → 评估线 P1 错误分析输入 → 转评估 candidate 样例（见 evaluation-deepening-plan.md）。受阻点清单是 production-to-eval 飞轮的原料入口。
3. **19:15 巡查**：open 受阻点状态变化并入巡查核对项（fixed 后连续 N 天无复发 → verified）。

## 七、分阶段落地

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| FP-P0 | 日级聚合挂靠巡查（S1~S6 六类 SQL + friction-reports JSON 落档） | **已上线 2026-09-02**（SQL 已在生产库只读 dry-run 验证；首跑当晚 19:15） |
| FP-P1 | 周级清单（周一早独立自动化 + 周四晚巡查兼任） | **已配置 2026-09-02**，随 FP-P0 数据积累自动运转 |
| FP-P2 | 月级趋势视图 + 功能绕开信号（人工标注字段） | 视 P1 使用价值决定 |
| FP-P3 | 语义信号层（signal_kind/程序层状态/来源四类/taxonomy_ref 字段 + rubric 关联必填 + Diagnosis Record 移交格式） | **格式已定 2026-09-06（T-469）**；采集随巡查/周评自然运转，走通案例 BC-20260904-001 |

## 八、语义受阻信号与 Diagnosis Record 移交（2026-09-06 增补，T-469 最小实现）

### 8.1 要解决的问题

S1~S7 全部是程序性信号：run 失败、投递失败、延迟、成本、工具失败、点踩、关联缺口。**「程序成功但用户结果不对」**（内容空转、表格错绑、来源冒用、跨日错发）不会触发任何一类。本节把语义失败纳入 FP 台账并给出移交格式，不改生产、不加部署。

### 8.2 rubric 评分记录与运行 ID 关联（必填字段规范，两份 rubric 同此口径）

评分记录（`data/eval-rubric-scores/*.jsonl`）自 2026-W36 起已实际携带 `trace`（atrun_*）字段；本节将其定为**必填规范**，两份 rubric 文档的记录格式节均指向此处：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `trace` | ✅ | 运行 ID（atrun_* / portal-* / wx-*），评分样本必须可回链诊断链 |
| `sample_ref` | ✅ | push_job id 或 asset version id（产出实体指针） |
| `delivery` | ✅ | 采样时顺带核对的投递状态 |
| `hard_gate_fail` | ✅ | 命中即转 ED-P1 候选并核对受阻点登记 |
| `linked_fp` | ✅（可 null） | 关联受阻点；无则 null，硬门槛命中时必须建 |
| `taxonomy_ref` | ✅（评分 fail 时） | 失败归类；未入表新类写「ED-P1 增补建议」 |

### 8.3 语义信号的四个来源与统一出口

| 来源 | 进入方式 | 说明 |
| --- | --- | --- |
| 用户反馈（user_feedback） | S6 点踩/选填文本、S3 催补关键词、owner 会话转述 | 只记元数据与指针，不摘正文 |
| 人工发现（manual_finding） | 19:15 巡查人工段、owner/agent 复盘 | 本设计走通案例即此源 |
| 评估失败（eval_failure） | rubric 硬门槛命中或维度 fail；回放资产失败 | 经 `rubric_ref`/EV 编号关联 |
| 重复修复（repeat_fix） | 同签名/同 taxonomy_ref 关了又开（≥2 次） | 月级复发率视图的语义子集 |

统一出口：全部落 FP 条目（`信号性质=semantic` + `程序层状态` + 来源四类 + taxonomy_ref），随日级 JSON/周清单流转，**不另建平行台账**。

### 8.4 移交格式：语义失败 → Diagnosis Record

触发条件（满足其一）：① 硬门槛命中（H1~H5/W 类）；② 同型 semantic FP 累计 ≥2；③ S 级 ≥S2 的单次语义失败。移交即按 ai-application-diagnosis skill（`.codex/skills/ai-application-diagnosis/SKILL.md`，仓库根相对路径）§10 的 15 字段起草，FP 条目提供前六个字段的初值：

| Diagnosis Record 字段 | FP/诊断链初值来源 |
| --- | --- |
| Symptom / Expected Behavior | FP 类别 + 关联 BC/任务契约 |
| Reproduction / Runtime Snapshot | FP 证据指针（trace/run/push id）→ Platform 运行诊断视图单 ID 解析 |
| First Divergence / Evidence | 诊断链缺失计数 + trace 工具载荷（T-459 落盘） |
| Current Hypotheses 起 | taxonomy_ref 给归因先验 |
| 其余字段 | 按诊断流程补齐，不预填 |

### 8.5 走通案例：BC-20260904-001（空壳简报照推）

完整立案见 [bad-cases/BC-20260904-001-empty-summary-push.md](./bad-cases/BC-20260904-001-empty-summary-push.md)。六问全答：

1. **谁受阻**：dyk / 盯盘简报（`migrated_scheduled-market-watch_88b950f3`）/ 9-4 11:00 窗微信推送。
2. **程序层是否成功**：是——run `atrun_d19bf8ff…` succeeded、push `7188852f…` sent、trace 齐全（这正是 S1~S7 零感知的原因）。
3. **用户实际影响**：盘中窗口收到 13 字符元话语，无任何行情/持仓实质，误报「没推送」。
4. **taxonomy 归类**：M3 邻接（模型行为漂移-内容空转）；正式入表建议留 ED-P1 周一初稿（分类法禁静默改写）。
5. **是否已有回归样例**：无确定性样例；盯盘 rubric W3/W4/W5 可检测本型（周采样、非阻塞）。修复（服务层 summary 质量下限）后登记 EV-038。
6. **裁决**：待 owner——服务层质量下限 vs 仅提示词约束；未修复前 S3+巡查人工段观察复发。

本案例同时验证了移交链路的可行性：FP 字段 → 诊断链单 ID 解析 → BC 立案 → 修复后 EV 回填，全程显式 ID，无时间邻近推断。

## 九、裁决记录（owner 2026-09-02）

1. 周清单**落档即可，不推微信**；频率**每周两次**（周一早、周四晚），稳定 4 周后可降为每周一次；
2. S3 隐私边界 = **只统计关键词命中次数与签名，不摘录正文**；
3. FP-P0 当日上线（已执行：巡查 prompt 注入受阻信号聚合 + JSON 落档，2026-09-02 19:15 首跑生效）。
