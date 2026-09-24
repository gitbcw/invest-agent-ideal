# T-537 P0 基线：111 隔离本地验证环境与产品化实施契约

状态：**执行完成，环境与契约可供 T-538~T-541 直接使用。**
日期：2026-09-21。前置：[正式设计](../agent-space-user-product-design.md)、[需求确认书](../agent-space-user-product-requirements-confirmation.md)、T-536。

## 1. 111 隔离副本：来源与校验记录

### 1.1 来源与零写入证明

- 来源：生产 `claude@118.145.115.197:/home/claude/invest-agent-mastra/data/runtime.db`（WAL 模式，74.2MB）。
- 导出方式：SSH 到生产，以 `readonly: true` 连接打开 runtime.db，用 SQLite backup API 生成一致性快照到 `/tmp`（backup 只写目标文件），容器用 tar 打包；全程源库零写入，未触碰生产 `.env`、微信状态、resolver。
- 拉取时间：2026-09-21T13:45Z（见 `.state/agent-space-p0/pull-manifest.json` 的 `pulledAt`）。
- 权威校验记录：`.state/agent-space-p0/pull-manifest.json`（源 sha256、逐表行数对照、逐资产字节校验）。

### 1.2 筛选策略（copy-then-prune）

全量快照拉回本地后，在**本地副本**上筛选至仅 111 scope：

- scope = `{ userId: "111", projectId: "invest-agent", instanceId: "invest-agent-111" }`；
- 带 `user_id` 列的表删除非 111 行；`ai_instances` 按 `owner_user_id` 保留 111；`agent_space` 系统域（`user_id IS NULL`）行保留；无 scope 列的全局表（`ai_projects`、`schema_migrations` 等）原样保留；
- 删除在外键关闭下进行，删后 `foreign_key_check` 复核剩余 111 行引用完整性（通过）；
- 隔离约定两条：① `automation_tasks.next_run_at` 置 NULL（冻结未来调度，98 条历史 runs 全保留）；② 实测 OFFLINE 模式下 runtime 启动会整体跳过 scheduler（见 §2.2），调度冻结有双保险。
- 筛选完成后 `VACUUM`，全量快照从 incoming/ 删除，本地仅存 111 筛选副本（12.7MB）。

### 1.3 校验结果

- 行数对照：83/83 张 scoped 表一致（源侧计数基准 = 快照文件本身，消除 live 库写入时间差）。
- 资产字节校验：69/69 个 `user_asset_versions` 通过（storagePath 精确形态 + size + sha256 与 DB checksum 逐一比对，字节文件在容器 `assets/` 下）。
- 111 容器：`data/projects/10849b69cdfa1b7a8c581a7b`（scopeDigest(111 scope) 前 24 hex），2.7MB，含 methods/、skills/、assets/、automations/、deliveries/、reports/ 等真实形态。
- 111 数据形态摘要（对 T-538~T-541 直接相关）：会话 78 / 消息 715 / 资产 64 / 资产版本 69 / 自动化任务 7（3 active）/ 运行历史 98 / agent_space：agents 1、run_basis 4、run_outcomes 6、audit 13；**methods 0、skills 0（W7 技能面空集，设计内）**。

## 2. 隔离本地验证环境

### 2.1 组件与端口

| 组件 | 端口 | 说明 |
| --- | --- | --- |
| runtime（`src/index.ts`） | 23660 | 独立 DB / 容器根 / 数据根；单 scope connector 固定 111 |
| Portal（`apps/portal/server.ts`） | 3110 | Next.js + relay 同进程，独立 portal.db |
| Portal relay | 3210 | runtime 内嵌 connector 反向连接 |

测试身份：Portal `primary / User@2026`（seed 时经 `PORTAL_DEFAULT_ASSISTANT_ID=invest-agent-111` 绑定 111 scope）；`admin / Admin@2026`。

### 2.2 隔离开关清单（`scripts/agent-space/p0/start-isolated.mjs`）

- 路径类：`DB_PATH` / `MASTRA_PROJECTS_ROOT` / `RUNTIME_DATA_ROOT` / `WORKSPACE_ROOT` 全部指向 `.state/agent-space-p0/` 下。
- 假投递：`INVEST_AGENT_OFFLINE_MODE=true` —— push 出口统一返回失败记录（`offline mode blocks external delivery`），不触碰任何微信状态；同时 runtime **跳过 scheduler 启动**与微信自启（实测日志确认），调度冻结因此是双保险。
- connector 放行：`INVEST_AGENT_PORTAL_CONNECTOR_IN_OFFLINE_MODE=true` + `PORTAL_CONNECTOR_AUTO_START=true` + 单 scope（`PORTAL_USER_ID=111` 等），relay 指向隔离 3210。
- token 类全部为 `p0-isolated-*` 本地值，与生产无共享；所有覆盖变量先 export 再起进程（dotenv 不覆盖已存在的 process.env），本地 `.env` 仅补模型网关等非路径配置——**未复制任何生产密钥、会话 token 或微信状态**。

### 2.3 可重复启动

```bash
# 1) 生成/刷新隔离副本（约 4 分钟；幂等，源零写入）
node scripts/agent-space/p0/pull-111-copy.mjs
# 2) 启动隔离环境（首次自动 seed Portal 测试身份）
node scripts/agent-space/p0/start-isolated.mjs
# 3) 自检（14 项）
node scripts/agent-space/p0/verify-isolated.mjs
```

浏览器验收入口：http://127.0.0.1:3110（primary / User@2026）。

### 2.4 自检结果（2026-09-21 实测）

14/14 通过：runtime 健康、111 会话（API 20 条）、对象形态可读（含 agent_space 装配态）、方法/Skill 空集如实呈现、容器字节 sha256 一致、**跨 scope 查询 0 行**、无 pending 推送残留、Portal 登录、会话 15 条、资产 64 条、自动化 3 条（经 connector 全链路）。

### 2.5 环境边界（重要）

- 本环境证明 111 隔离副本上的代码与交互契约；不证明生产迁移、真实微信送达、长期运行质量。
- 模型网关走本地 `.env` 的真实 key（运行对话/自动化需要）；市场数据上游为真实只读 API。这两类外部调用不代表生产通道。
- 失败反例（needs_attention 任务、失败 run、失败投递）按需在隔离库构造，构造脚本属于 T-539 契约范围。

## 3. 与任务验收标准对照

| T-537 验收项 | 结果 |
| --- | --- |
| 隔离环境可重复启动 | ✅ pull → start → verify 三脚本幂等，实测通过 |
| 111 真实对象形态可读 | ✅ §1.3 + verify 14/14 |
| 跨 scope 不可见 | ✅ primary scope 查询 0 行 |
| 假投递 | ✅ OFFLINE 模式挡出口，无微信状态触碰 |
| 差距清单明确 | ✅ 见 [T537-gap-analysis.md](./T537-gap-analysis.md) |
| 各后续任务可执行契约 | ✅ 见 [contracts/](./contracts/) T-538~T-541 |

## 4. 产物索引

| 产物 | 位置 |
| --- | --- |
| 拉取脚本（生产只读导出+筛选+校验） | `scripts/agent-space/p0/pull-111-copy.mjs` |
| 隔离环境启动 | `scripts/agent-space/p0/start-isolated.mjs` |
| 环境自检 | `scripts/agent-space/p0/verify-isolated.mjs` |
| 隔离副本与校验清单 | `.state/agent-space-p0/`（gitignore；runtime.db / projects/ / pull-manifest.json / portal.db） |
| 差距清单 | [T537-gap-analysis.md](./T537-gap-analysis.md) |
| 实施契约 | [contracts/T538-workspace-methods-skills-gui-contract.md](./contracts/T538-workspace-methods-skills-gui-contract.md) 等 4 份 |
