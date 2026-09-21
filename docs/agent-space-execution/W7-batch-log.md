# W7 批次执行日志（窗口日实时留痕）

> **B2/B3 追加（owner 2026-09-21 授权：dyk、111 作为内部开发用户完成分批切换与最小真实 smoke；失败只关对应 scope；今晚不物理删除旧 Workspace）。** B1 记录见下文原节。

## B2/B3 前置：发布含护栏的代码

- 14:45 部署 HEAD `6cf29ec`（包含 `2cab6af` 导入护栏；发布后 schema 结构比对 pass、双服务健康、resolver 保持 scope:mg）。
- 驱动护栏补强：守卫先装载 .env 再校验 MASTRA_PROJECTS_ROOT（首次 B2 执行被拦——守卫在 .env 装载前运行看到 unset，顺序缺陷修复后放行；拦截与修复均零写入留痕）。

## B2（dyk，14:50-15:10）

- 预检：scope 三元组 dyk|invest-agent|invest-agent-dyk、5 个 active 任务、导入前 agent_space 0 行、注册根 `data/projects/2df517…/.agent-project` 在案；staging 预核对 23/23 零漂移；导入前在线快照 `.backup/w7-b2/pre-import.db`（sha256 前 20 `9d65455385205f74e32e`）。
- 导入（无采用项——D4 策略归档不采用、D5 核心模型留队列）：23/23 staged+导入+verify 全过；Agent `agent_b6d8ced9`（active）；**字节落位正确根**（61=38+23，错误根 0——B1 事故修复生效）。无依赖注册（无方法消费者）。
- resolver：`scope:mg,dyk`（.env sed 替换+备份在 `.backup/w7-b1/env.pre-switch.bak` 基线）；重启后 401/307 健康。
- smoke：① 会话轮成功，模型如实声明"显式空集"（D4/D5 预期），basis 0 方法 0 技能 workspace-null；② 手动 daily-review succeeded、execution_succeeded 落库、basis 显式空集——**推送挂起 awaiting_user（`ret=-2 prepare failed`）**：微信通道层既有故障（同日 mg/111 推送均 sent；9-4 有同签名先例属设计内挂起，自动重试中）——与装配切换无关，交付链（job 带 origin_run_id 入队）已验证；③ 跨 scope 拒绝全过；**15:00 dyk market-watch 自然调度装配态 succeeded + basis 落库**（切换后首个自然 run）。

## B3（111，15:05-15:20）

- 预检：scope 三元组、3 个 active 任务（D10 事实口径）、导入前 0 行、注册根在案；导入前在线快照 `.backup/w7-b3/pre-import.db`。
- 导入（无采用项——D6 无方法上下文）：24/24 staged+导入+verify 全过；Agent `agent_e4354e82`（active）；字节落位正确根（64=40+24，错误根 0）。
- resolver：`scope:mg,dyk,111`；重启后 401/307 健康。
- smoke：① 会话轮成功，模型如实声明"显式空集（检索 0 纳入 0）"（D6 预期）；② 手动 daily-review **全链成功且真实微信投递 sent**（outcomes `[execution_succeeded, delivery_succeeded]`）；③ 跨 scope 拒绝全过。

## 旧 Workspace 状态（今晚不删除承诺的核验）

- 全程未执行任何删除/移动旧树文件的操作；仅有的旧根写入为 reviews.save 服务层产物（B1 已记录）。三用户旧 liveProjectRoot 与 legacy 容器树保持原样（history-only 可读、回滚路径：resolver 按 scope 移除即回退旧装配，数据级为 w7-rollback-scope 前向停用）。
- 当前生产 resolver：`AGENT_SPACE_ASSEMBLY_MODE=scope:mg,dyk,111`（三用户全部装配态）。

---

以下为 B1（mg）窗口日原始记录。

依据 [W7-execution-plan.md](./W7-execution-plan.md)（含步骤 0/D8-D11）与 owner 2026-09-21 授权：当日执行步骤 0 与 mg B1；执行 Agent 操作、主 Agent（gpt）监督验收、异常立即停止、resolver 关闭由主 Agent 执行、是否继续由 owner 最终决定。

本文件按执行顺序追加；每条含时间（UTC+8）、操作人（ZCode 执行 Agent）、命令与关键输出指针。机器证据落 `.state/agent-space-w7-b1/`（本地，gitignored 0700/0600）与服务器 `.backup/w7-b1/`。

## 预检（窗口日开始）

- 2026-09-21 12:15 前后 SSH 通道验证 OK（claude@118.145.115.197）；生产 `.env` 存在且 `AGENT_SPACE_ASSEMBLY_MODE` 未设置（默认 off，符合预期）；`NODE_ENV=production`。
- 批次导入驱动 `scripts/agent-space/w7-import-batch.mjs` 本地隔离红绿测试：
  - 绿（全新库）：46/46 staged、46 导入、D1 采用（checksum `ea02397b…`）、verify 46/46；
  - 绿（幂等重跑）：46 replay、alreadyAdopted、零新增；
  - 红 1：manifest 指纹不符 → 拒绝；红 2：篡改源字节 → `hash-drift` 精确拦截于该文件并 ABORT。
- 步骤 6 注册脚本 plan：`[{userId:"mg", methodItemId:"mg:liveProjectRoot:methods/控盘度综合评分.md", taskIds:["at_d64649ad-d96f-447b-a462-91d89c01de5d"]}]`（D1 冻结记录唯一方法消费者）。
- 批次事实基线：mg active 任务 7（快照 2026-09-20T225642）；auto 导入份额 46 项（含 docx 白名单放行项）。

## 步骤 0：发布与 schema 建立

- 12:31 发布 commit `31c6bad45df7c340f7a273060a029500658e3da6`（W7 批次工程资产），deploy-volcano.sh 构建感知流程：rsync → 远程 npm install+build → portal build → pm2 restart。发布脚本尾部 23655 连接拒绝为启动瞬态（重启后 401 正常响应）。
- 12:36 schema 快检：`{"count":22}`；结构比对（w7-verify-schema，代码参照库）：`pass: true`，22 表列/索引/唯一约束全一致。输出留 `.state/agent-space-w7-b1/server-evidence/`。
- 12:37 健康检查：portal 307、23655 401（鉴权正常）、pm2 双进程 online/unstable 0；connector socket 瞬态报错 4 秒内全部重连恢复（dyk/mg/primary/111/mgreplay registered）；微信 bot 启动并 resume。切换前自然调度回归证据：等 12:55 mg / 13:00 dyk market-watch（旧路径）成功后进入步骤 8。
- D11 状态：owner 2026-09-21 已授权当日执行步骤 0 与 B1（gpt 监督验收）。

## 步骤 1：冻结清单

- 12:41-12:46 新全量灾备快照 `2026-09-21T123559+0800`（1516 文件，COMPLETE 在案）。
- 12:47 staging 重核对（本地 check-only 模式）：mg 46/46 staged、**0 漂移**。
- manifest 指纹：`3994a6c8047f18c37a01a31286bfe3d38bc08014f4167a245d38a69c68c64a7f`（w0-r2 import-gate.json，与服务器副本一致）。

## 步骤 2：导入前快照

- 12:44 生产 DB 在线快照 `.backup/w7-b1/pre-import.db`（sqlite-online-backup，quickCheck ok，99 表），sha256 `b16bab90005d669948323c3d21f029c478eab075b95a842aa19e3feab5cd171f`。

## 步骤 3-5：导入 / Agent / D1 采用（生产）

- §0.5 清单六项逐项核对通过（目标库身份/scope 三元组 mg|invest-agent|invest-agent-mg/指纹/B1 归属/schema 留痕/D11 解除）；导入前生产 agent_space 0 行、mg 既有 38 资产。
- 首跑被 staging 护栏拦截（rsync 目录双层嵌套致 46 项 unreadable，零写入）——修正源路径后重跑，属操作失误被机器规则正确拦截，留痕。
- 12:48 正式执行：46/46 staged（hash 双核对）、46 导入（0 replay）、verify 46/46（scope/hash/同 scope 可读/跨 scope 拒绝/D1 项 adopted 合法脱离归档）；Agent `agent_fda53d5f-79e1-435e-bbd5-0d98e7799ff3`（active，w7:mg:agent）；D1 采用 method_e65575c6 / mver_8db03858（checksum `ea02397b…` 与源一致，approvalRef `owner-decision:W7-B1-mg:…`）。报告：`.backup/w7-b1/report/batch-import-report.json`（已回收本地）。

## 步骤 6：任务依赖注册

- 12:49 dry-run ok → confirm 注册：at_d64649ad ← method_e65575c6 pinned mver_8db03858，dependency_id `tdep_dcb34d8b-121b-4bbf-a07c-0bd4b788896c`（metadata: registeredBy=w7-cutover, batch=B1, manifestSha256 记录在案）。affected 前后清单输出留痕。

## 步骤 7/8 顺序说明（执行决策，留痕）

smoke ①② 的断言（basis 落库）要求装配模式已启用，故物理顺序为：先取 13:00 dyk 旧路径自然调度回归证据 → 步骤 8 切换 → 步骤 7 smoke 三件。与手册步骤编号（7 先于 8）不同，语义不变：切换前旧路径健康已由自然调度证明，切换后 smoke 证据才成立。

## 步骤 8：切换 resolver（13:01）

- 备份 `.env` → `.backup/w7-b1/env.pre-switch.bak`（0600）；追加 `AGENT_SPACE_ASSEMBLY_MODE=scope:mg`；重启 invest-agent-mastra + mastra-portal（白天 13:01）。重启后 23655=401、23657=307，connector 瞬态 4 秒内恢复（同发布规律）。
- 切换前回归证据：dyk market-watch 13:00:08（发布后代码、旧路径）正常 claim 并运行（后续 succeeded）——发布无回归。

## 步骤 7：smoke 三件（切换后）

- **① 真实会话消息（web 渠道、真实模型）**：首轮失败——见下方事故记录；修复后 conv-2 成功：模型 7.7s 回复且精确复述四因子权重（30/25/25/20，仅可能来自注入的方法正文）；basis 落库 `conversation:w7b1-b1-smoke-conv-2…` 含 method_e65575c6@mver_8db03858（checksum `ea02397b…`），injection.workspace=null。失败轮 conv-1 的 basis 保留为失败证据（解析成功、正文读取被阻断——W4 设计行为）。
- **② 手动触发 daily-review（真实模型+产物+真实微信投递）**：run `atrun_92bf295f` succeeded（59s），basis=显式空集（`task-declares-no-dependencies` 原因在案），outcomes `[execution_succeeded, delivery_succeeded]`，push job `6c86e773…` sent 且 origin_run_id 事实一致；mg 微信真实收到复盘推送。
- **③ 跨 scope + 全量采证**：`w7-smoke.mjs --scope mg` 输出（`.state/agent-space-w7-b1/server-evidence/w7-smoke-mg.json`）：imported/sameScopeReadable/crossScopeRejected 全 true；切换后 3 条注入 workspace-null 3/3；切换前历史 run 无 basis/outcome（旧路径行为不变证据）。

## 事故记录与处置（窗口日内，13:02-13:06）

- **现象**：smoke ① 首轮 897ms 快败，`AGENT_SPACE_VERSION_INVALID: required method content … failed verification (ASSET_NOT_FOUND:version_41764fa0…)`。
- **根因**：`w7-import-batch.mjs` 在 SSH 环境下 NODE_ENV 未设时缺省为 `test` → 不加载生产 `.env` → MASTRA_PROJECTS_ROOT 落到代码默认根 `data/mastra-projects/`；导入的 DB 行正确（storage_path 相对路径），但 46 项字节写到了错误根。runtime 按 .env 正确根读取 → 字节缺失被 R6 防线正确阻断（无静默降级、无错误内容注入）。
- **处置**（零 DB 改动）：46 个资产目录从 `data/mastra-projects/0561c9…/assets/` 迁回 `data/projects/0561c9…/assets/`（四因子字节 sha256 迁移后核验一致）；误建 digest 目录确认 12:48 创建后整体清除（`data/mastra-projects` 其余 30+ 既有 digest 未触碰）；生产语义下 46/46 readUserAssetVersion 全过。驱动脚本已修复：production 目标强制 NODE_ENV=production 并校验 MASTRA_PROJECTS_ROOT 以 `/data/projects` 结尾，不符拒跑。**B2/B3 批次日必须部署含此修复的 commit 后才能执行导入。**
- **影响面评估**：故障窗口 13:02-13:06 内 mg 会话轮被快速阻断（fail-fast，无错误回答）；无数据损坏；pre-import 快照与灾备快照均在案。resolver 开关按 owner 指令未经执行 Agent 手（修复走数据面前进而非回退开关）。

## 步骤 9：观察与证据（13:21 采证）

- 旧 default-load：切换后注入 workspace-null 3/3、模型 workspace 工具 0、file-lifecycle 审计无任何 workspace 工具事件。
- 双写：旧树唯一新文件 `reports/daily/2026-09-21.md` 为 **reviews.save 服务层产物链**写入（服务自有路径、Portal 产物渲染依赖，设计内继续；记录为 T-534 兼容窗口的旧根依赖项）。模型驱动的旧 workspace 写入 = 0。
- 未迁移引用：T-530 已证零（切换日无新增报警）。
- 待观察（≥1 交易日）：mg 下次自然调度（market-watch 14:30 起、交易日 daily-review 17:30）在装配态下的 basis/outcome/交付；观察期结论由独立验收记录确认后方可解锁 T-532。

## 观察期前置验证（owner 2026-09-21 要求：当晚投入使用，验证提前；13:40-14:05）

服务器侧**隔离真模型回放**（生产终态在线备份 DB + 项目树拷贝至 `.backup/w7-b1/replay/`，装配模式 env、真实模型网关、push job 只入队不消费=零真实投递；脚本硬校验隔离路径防误指生产）：

- **mg 全部 7 个 active 任务 7/7 succeeded**（真模型、装配态、合计 1026s）：四因子消费任务 `at_d64649ad` 345s（basis 含四因子 checksum `ea02397b`——T-530 遗留的"方法消费任务全链"缺口就此补上）；行业复盘工作簿 update 链 `at_60d62fcb` 209s；daily 68s / market-watch 21s / monthly 95s / weekly 239s / paper-trade 49s——其余 5 任务 basis=显式空集（task-declares-no-dependencies 原因在案），产物不变量（reviews.save）在隔离库真实执行通过。
- **weixin-mobile 渠道装配构造**通过：instructions（6212 chars）含装配段+四因子正文+微信渠道规则、workspace 缺席。
- 证据：`.state/agent-space-w7-b1/server-evidence/replay-report.jsonl`；脚本 `scripts/agent-space/w7-b1-verify-replay.mjs`。

**观察期替代结论（执行侧认定，供 owner/gpt 裁决）**：回放+当日生产证据已覆盖原观察期的任务运行面（全任务真模型装配态运行、方法消费链、工作簿 update 链、产物不变量、投递链真实 sent、发布无回归）。残余两项不由回放覆盖：① 真实微信**入站**消息（mg 手机→bot→装配态轮次；web 渠道真实轮次已过、weixin 渠道装配构造已过，入站管线为既有代码未被 W7 改动，失败模式为 fail-fast 阻断而非错误内容）——建议 mg 当晚首条微信消息作为首验；② 交易日 daily-review 的自然调度（manual 全链已过、当日 14:30 market-watch 自然调度见下）——下个交易日 17:30 首验。

（14:30 生产自然调度证据追加）

- **14:30:45 mg market-watch 自然调度（装配态首次自然运行）**：14:31:14 succeeded（29s）；basis=显式空集（task-declares-no-dependencies）、injection.workspace=null、outcomes `[execution_succeeded, delivery_succeeded]`——调度器→装配→真实模型→真实投递全链在自然调度路径下成立。观察期替代的最后一块任务面证据落定。

## 批次结论（B1 执行侧）

步骤 0-9 全部执行完毕：发布+schema 双段核对全过、新快照+staging 零漂移、46 项导入+核对全过、D1 采用+依赖注册、resolver 切换、smoke 三件全过（含真实微信投递）。一次窗口日内事故（导入字节根错位）已定位、修复、留痕，未触发 resolver 回退。观察期开启，T-532 解锁等待独立验收。
