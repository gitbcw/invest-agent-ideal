# Mastra 备份快照迁移验证计划

状态：本地验证阶段，未触碰生产源

## 1. 目的与边界

本计划用于在迁移分支通过隔离冷启动和人工验收后，先对生产备份快照做本地迁移演练。当前只复制快照到临时 source/target 目录并验证迁移逻辑，不把真实生产数据直接迁移到任何现有服务。

正式目标是：Mastra runtime + Portal 使用独立服务配置和服务-owned 持久层；用户可见的投资业务数据保持完整、可追溯、可回滚。Workspace 不再作为 Agent 的运行环境，但在业务数据完成逐域迁移前，不能整体删除。

## 2. 不迁移的数据

以下数据不从备份快照导入本地 target，也不进入后续新端口服务：

- 主用户在测试期产生的临时积累，除非用户逐项确认其为真实业务数据。
- ACP/Codex/Hermes/Claude CLI 的执行状态、session、认证文件和模型配置。
- `chat_history` 等已被 canonical conversation log 替代的旧状态。
- 派生的行情缓存、过期推送、失败重试临时状态和可重新计算的指标缓存。
- 任何生产 secret、API key、微信 token 或 `.codex/auth.json`。

服务-owned 表（用户身份、助手注册、conversation log、traces、scheduler、push、automation、assets、audit、alert runtime）不迁入 Workspace；若正式部署采用已有服务数据库，则执行 schema compatibility check，不做表级复制。

## 3. 迁移对象与目标

| 域 | 当前来源 | Mastra 目标 | 策略 |
| --- | --- | --- | --- |
| 用户与助手 | `users`, `ai_instances` | Mastra service SQLite | 保留原 ID，校验唯一性和 scope |
| 对话与审计 | `conversation_sessions/messages`, `agent_traces` | service SQLite | 只追加导入，保留 `trace_id/run_id/task_id` |
| 持仓/自选/计划 | `portfolio`, `watchlist`, `stock_plans` 或 Workspace `config/portfolio.yaml` | service backend + 可选 Workspace 导出 | 先导出快照，再幂等导入 |
| 投资画像/方法 | `investment_profiles`, `methodology_profiles` 或 `config/strategy.yaml`, `knowledge/methods/` | service profile/method 表 + versioned assets | 字段映射后双读比对 |
| 日计划/观点/方法变更 | `daily_plans`, `review_viewpoints`, `method_change_candidates` 或 Workspace JSONL/YAML | service state/event tables | 按业务日期/事件 ID 去重 |
| 交易动作/记忆 | `trade_actions`, `memory/behavior_events.jsonl` | append-only service events | 不覆盖既有事件，只追加缺失事件 |
| 报告与附件 | `conversation_artifacts`, `user_assets`, `reviews/`, `attachments/` | asset index + 独立受控字节根 | 先复制字节，再登记索引和 checksum |
| 调度配置 | `config/schedules.yaml`, `config/watch.yaml` | scheduler settings/rules | 暂停调度后导入，启用前 dry-run |

权威归属以 [table-ownership.md](/Users/combo/MyFile/projects/invest-agent-ideal-mastra/docs/table-ownership.md) 为准；若 SQLite 与 Workspace 同时存在，以当前生产运行路径的最新、可校验版本为源，不允许静默覆盖。

## 4. 执行阶段

当前只执行 Phase 0-3 的本地备份快照验证和迁移分支重构配套测试。部署包、新服务器、正式端口和内测用户切换全部后置，不能作为当前阶段的交付物。

### Phase 0：选择备份快照

1. 选择已完成且可校验的灾备快照；不在线读取生产数据库。
2. 记录快照 `COMPLETE`、SQLite `quick_check` 和 manifest checksum。
3. 生成本地迁移批次 ID；所有日志绑定该 ID。

### Phase 1：本地复制与 dry-run

1. 将快照复制到新的临时目录；源目录只读，禁止直接作为任何 `*_ROOT` 或 `DB_PATH`。
2. 执行 schema compatibility、外键、唯一键、scope、文件 checksum、日期格式和敏感字段检查。
3. 对每个域生成 `source-count / target-count / missing / conflict / skipped` 报告。
4. dry-run 只生成映射和差异报告，不写正式目标。

### Phase 2：临时 target 分域导入

按依赖顺序执行：用户/助手 → profile/method → portfolio/watchlist/plans → daily/review/memory → assets/artifacts → scheduler rules。每个域独立事务、独立 checkpoint、独立校验；任一域失败立即停止后续域。

导入要求：

- 所有写入具备幂等键，重复执行不会产生第二份业务记录。
- 不删除源记录，不在迁移期间修改旧服务表。
- 文件先复制并校验 checksum，再写索引记录；索引失败时删除临时目标文件。
- 对用户可见字段保留原始时间、来源和版本；舍弃字段必须进入报告。

### Phase 3：临时 target 双读与新端口准备

1. 新 Mastra backend 读取目标数据，旧路径只读作为对照。
2. 运行固定样本集，对每个域比较数量、主键、关键字段、权限 scope 和展示摘要。
3. 观察至少一个完整业务周期；scheduler/push 保持关闭或只运行 dry-run。
4. 形成切换检查单和回滚命令，未达到阈值不得切换端口。

### Phase 4：部署新服务器端口（未来发布门槛，当前不执行）

仅在 Mastra 重构完成、业务域迁移验证通过、独立验收完成且用户明确批准后执行：将代码和已验证的 target 数据根部署到新的服务器端口；内测用户从新 Portal 登录并重新微信扫码。当前阶段不构建部署包、不连接新服务器、不执行端口切换。

## 5. 验收标准

- 源快照在演练前后 checksum 不变；生产数据库、真实 Workspace 和微信状态没有写入。
- 所有迁移域 `missing=0`、`conflict=0`；明确标记的舍弃字段有用户确认或文档依据。
- 重复执行 dry-run 和导入不会增加记录或文件版本。
- 关键 API 按用户、助手、项目三层 scope 读取结果一致。
- 对话、审计、trace 关联保持完整，Mastra 新回合写入 `agent_backend=mastra`。
- scheduler、push、automation 在恢复前完成只读/模拟验证。
- 回滚可在不改写源数据的情况下恢复旧服务读写；回滚演练只使用快照副本。

## 6. 回滚方案

切换前保留旧服务数据库和 Workspace 原样不动。发生失败时：停止 Mastra 写入和 worker，恢复旧服务端口和配置，保留 Mastra 目标目录作为证据，不反向写入旧源。若目标索引或资产不一致，删除整个临时/新目标批次，而不是逐文件猜测修复。生产回滚必须另有运维批准和备份确认。

## 7. 当前暂停门

本地备份迁移 smoke 通过后，继续完成 Mastra runtime/Portal 重构和业务域迁移验证。新服务器、部署包、端口、内测用户范围、Portal 登录方式和重新微信扫码安排都属于未来发布阶段。任何生产源写入、旧端口替换或 scheduler/push 恢复都不属于当前本地验证。

## Executor Prompt

使用本计划只对备份快照执行本地迁移验证。先复制 source/target，运行 dry-run 和幂等导入，再做双读校验；同时继续完成迁移分支的 Mastra-native 重构。不得准备部署包，不得连接新服务器，不得触碰生产源、真实 Workspace 或微信状态。

## Reviewer Prompt

独立对照本计划检查来源、映射、计数、checksum、scope、幂等、回滚和暂停门证据。没有完整证据时，不批准正式端口切换或生产数据迁移。
