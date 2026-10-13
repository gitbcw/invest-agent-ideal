# T-534 兼容窗口收口报告

日期：2026-10-13。任务：T-534（T-524 W7：兼容窗口收口与旧 Workspace 历史归档）。前置事实：三批切换与产品化（T-537~T-541）done、旧右侧面板移除（T-549）archived、装配模式全量上线（T-588，2026-10-10 发版）。

## 结论

**兼容窗口收口条件满足**：自 2026-10-10 装配全量以来，旧 Workspace 作为默认装配来源的证据为零、模型驱动双写为零、`reports/daily` 判定为服务层资产链而非旧路径依赖。建议 owner 批准关闭旧运行入口（见「请示」）；旧 Workspace 物理删除不在本任务范围，需另立任务并单独授权。

## 证据

### 1. 装配模式现状（新对象为唯一默认来源）

- 生产 `.env` 当前值 `AGENT_SPACE_ASSEMBLY_MODE=on`（全量模式）。2026-10-12 巡查曾记录 `.env:38` 为 `scope:mg,dyk,111`；两次读数之间的变更时间点未单独核实。对三用户语义等价（mg/dyk/111 均覆盖），`on` 覆盖面更大（含 owner/mgreplay/未来新用户）。
- 运行依据注入持续发生（`agent_space_run_basis`，最近样本至 2026-10-13T00:22Z）：conversation 轮 basis_json ~3.3K / injection_json ~3.1K；generic_automation 轮 ~900 / ~600。三用户与 mgreplay 对照均有记录。

### 2. 模型驱动双写 = 0

- 结构性：装配轮 `fileWrites=false`，`mastra_workspace_write_file` / `mastra_workspace_edit_file` / `mastra_workspace_mkdir` 整体 `enabled:false`（`src/mastra/workspace-registry.ts:240-245`，2026-10-10 owner 裁决）。
- 观测（2026-10-10 起，两通道合计）：
  - `automation_tool_payloads`（automation 通道）：write/edit/mkdir 调用 **0**；仅 `mastra_workspace_list_files` ×8（111×6、mg×2）与 `mastra_workspace_read_file` ×2（mg），其中 error 3 条。
  - `agent_traces`（会话通道）：含 `mastra_workspace` 字样 5 条，全部为 `list_files` 读类调用（111，10-10 Portal 会话，其中 2 条 error 为流式参数分片的重复捕获）；write/edit/mkdir **0**。
- 上述 list/read 属模型对 history-only 旧目录的探索性读取（设计内读挂载），不构成写入。

### 3. 旧路径引用清单与 `reports/daily` 处置

- `reports/daily` 依赖判定：`reviews.save` 产物走 `conversation_artifacts.relative_path = reports/<kind>/<reportKey>.md`，属服务层资产库链路（user_assets），与旧 Workspace 文件路径无关。**不构成旧路径依赖，无需处置**（T524 current-state 文档遗留问题的答复）。
- 运行时代码对旧 `workspaces/` 的引用仅剩 history-only 读挂载（scoped workspace 挂载与技能发现），无默认装配来源引用。
- 旧 Workspace 目录保留未删（灾备快照含其内容，files=3315），符合 history-only 语义。

### 4. 备份恢复路径可用

- T-415 备份恢复演练（done）沉淀恢复 SOP。
- 灾备全量快照连续成功：2026-10-09 至 10-12 连续 4 天 COMPLETE（`sqlite_verification=quick_check_ok`，metadata 完整），最近一次 2026-10-12T01:11+0800。

### 5. 真实运行依据覆盖（近 7 天，agent_space_run_basis）

| 用户 | conversation | generic_automation | 最近记录 |
| --- | --- | --- | --- |
| 111 | 27 | 7 | 2026-10-13T00:22Z（会话） |
| dyk | 1 | 28 | 2026-10-12T11:10Z（automation） |
| mg | 5 | 21 | 2026-10-12T12:15Z（会话） |
| mgreplay | — | 1 | 2026-10-12T11:30Z（对照） |

覆盖说明：三用户 automation 轮 basis 连续；会话轮 111/mg 有持续记录。

## 未决与观察项（如实标注）

- **dyk 会话通道 basis 覆盖薄**（近 7 天仅 1 条）：dyk 以微信会话为主，需确认微信入口的 basis 记录口径（是否全部会话入口都落 basis），否则会话侧覆盖证据不完整。不阻塞旧入口关闭（automation 侧覆盖充分），列为观察项。
- **旧 Workspace 读挂载仍在**（list/read 可被模型调用）：history-only 设计内。关闭旧运行入口后可另行评估是否裁剪读挂载。
- `.env` 由 `scope:mg,dyk,111` 变更为 `on` 的时间与操作者未核实（见 §1），建议下次巡查顺带确认。

## 请示（owner）

1. 是否批准**关闭旧运行入口**（移除旧 Workspace 的默认挂载路径；本报告证据支持关闭）。
2. 旧 Workspace **物理删除**是否另立任务（默认不删，保留 history-only）。
