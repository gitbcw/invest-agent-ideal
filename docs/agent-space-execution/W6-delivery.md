# W6 交付：隔离迁移演练

状态：**隔离演练完成，未切换生产**。全程隔离 DB、隔离项目根、受控真实内容副本；未触碰生产 DB、真实 Workspace、微信、Portal connector、scheduler 与任何生产外部写入。W4 装配模式在生产保持默认关闭。
依据：[W6-isolated-migration-rehearsal.md](./W6-isolated-migration-rehearsal.md)、W0-W5 全部已通过验收的契约、owner 放行令（"W6 只应处理 W0 自动可导入项；owner-review 项继续不得默认采用"）。

## 0. 交付物

| 交付物 | 位置 |
| --- | --- |
| 迁移演练导入器（服务层） | `src/services/agent-space/migration.ts`（经 `index.ts` 出口） |
| 演练驱动脚本（两阶段） | `scripts/agent-space/w6-rehearsal.mjs` |
| 域测试（含必测三场景） | `tests/agent-space-migration.test.ts` |
| 真实演练产物（gitignored、0700/0600） | `.state/agent-space-w6/20260920T2/`（正式证据）；`20260920T1/` 为首次运行痕迹（含 docx 拦截发现，见 §4） |

## 1. 演练设计与语义

### 门禁消费（只处理自动可导入项）

`loadW0MigrationInputs(w0Root)` 读取 W0 `import-gate.json` + `manifest.json`，**服务层不信任 gate 列表**，对 `autoImportable` 逐项重验机器规则：明确分类（data_asset/method）、`disposition=migrate-candidate`、有 hash、`backup.coverage=covered`、`readbackResult=readback-match-manifest`、`driftSinceScan=unchanged`、`blockedReasons` 空、`adoptionConstraints` 空。不满足者记入 `skipped`（带机器原因），不进入导入。`ownerReview` 桶（205 项）只导出**可发现性清单**（itemId、分类、约束、reconciliation 目标、备份位置、hash），绝不导入。

### 源 / 备份 / 副本 / 导入结果分目录

```
.state/agent-space-w6/<runTs>/
  00-source/source-manifest.json        # W0 引用、gate hash、93 项 ID、服务层拦截清单
  01-isolated-copy/                     # 93 项受控副本（<user>/<原路径>）+ stage-outcomes.json
  02-import-result/                     # import-outcomes.json（92 项逐项核对）+ owner-review-queue.json
  03-run-basis/run-basis-evidence.json  # default-load 关闭后的交互/任务装配证据
  04-rollback/pre-snapshot.db           # 导入前 DB 快照 + rollback-verification.json
  report.json / report-rollback.json    # 机器结果汇总（305 + 9 项检查）
  isolated/                             # 隔离 DB、隔离项目根、空 workspace 根
```

staging 从灾备快照根**实读字节、重算 sha256 与 W0 manifest 双核对**后才落副本；缺失/漂移逐项拦截（`backup-unreadable` / `hash-drift`）。

### 导入语义（归档态，运行采用不自动发生）

- **data_asset** → `createUserAsset`（`source='restore'`，幂等键 `w6:<itemId>`）：历史产物保持资产，永不 method 化。
- **method** → `createUserAsset` 内容底座 + `createMethod` + `addMethodVersion`（`origin='migration'`），版本一律停在 **draft 归档态**：不 approve、不 adopt、不设 current。"撤回/历史策略只归档"；任何运行采用必须走既有授权路径（approve/readopt），`historical-not-default` 等约束仍由 methods.ts 服务层强制。
- 幂等：同 idempotencyKey 重放返回原对象，零新增副作用（实测 92/92 replay）。

### 导入后逐项核对

92 项全部通过：scope 行归属、存储字节 hash 与源一致、同 scope 可读、**跨 scope 读取拒绝**、method 归档态（draft + 无 current + 无 approved）。产出即"每项有源/目标 hash、ID/version、scope、引用"的机器证据（import-outcomes.json：sourceHash/copyHash/storedHash/assetId/versionId/scope，method 项另含 methodId/methodVersionId/contentRef）。

### 旧 default-load 关闭后的 run-basis

隔离 workspace 根为空、未注册任何旧内容（等效旧 Workspace default-load 关闭，脚本检查项 `isolated-workspace-root-empty`）。在此环境下：

- **交互入口**：隔离 DB 内走 owner 授权路径 approve+adopt mg 四因子（`method_4ac44bf8…`），建 active Agent 并绑定，`assembleAndRecordRunBasis(conversation)` 解析到四因子 `mver_91e1b6f9…`，注入内容 checksum `ea02397b…` 与源字节一致；basis 全文不含旧 workspace/备份路径。
- **任务入口**：任务声明 method 依赖（pin 同一 approved 版本）后 `assembleAndRecordRunBasis(scheduled)` 装配封闭于声明依赖（恰 1 项，无夹带）。
- **采用发生在隔离 DB，仅为演示授权路径可用，不代表生产采用**。

### 回滚

导入阶段在 initDb 后、导入前落 DB 快照（WAL checkpoint 后复制，记录 sha256）；`rollback-verify` 阶段在独立进程恢复快照并逐表核对：user_assets / user_asset_versions / agent_space_methods / agent_space_method_versions / agent_space_agents / agent_space_run_basis / agent_space_run_outcomes / conversation_sessions / automation_tasks 全部归零（9/9）。

## 2. 必测三场景（机器断言，域测试 + 演练脚本双重覆盖）

| 场景 | 断言 | 证据 |
| --- | --- | --- |
| mg 四因子与 KP 独立；KP 任务只拿 KP 绑定；缺失模拟账本不推断空仓 | 四因子以独立 method 导入（无采用约束）；旧 KP V1.0 留在 owner-review（约束 historical-not-default，不导入，库中 mg method 恰为四因子一个）；模拟账本资产不在迁移集 → 依赖注册显式 `AGENT_SPACE_NOT_FOUND`（含 assetId），任务**不产生任何 run basis**——不存在"空仓"降级语义；任务装配封闭于声明依赖 | domain 测试组 4；report.json `S1 *` 检查 6 项 |
| 111 日复盘模板与策略独立；一次性回测不变成长久方法 | 111 自动桶 24 项全部以 data_asset 导入，`listMigrationMethods(111)` 为空（无任何 method 化）；T-337 一次性回测产物 objectType=asset 且无 methodId；策略源留在 owner-review 且双 reconciliation 目标（`methods/strategy-rules.md` + `workflows/daily-review.md`）各自保留 | domain 测试组 1/3；report.json `S2 *` 检查 |
| dyk 核心模型恢复可发现；撤回旧策略只归档；采用范围仍可阻塞 | 核心模型（fundamental.md）不导入，但 owner-review-queue 可查（restore-candidate 约束、目标 `methods/core-company-qualification.md`、备份路径、hash）——可发现性未丢失；dyk strategy-rules.md 导入为 draft 归档（origin=migration）；归档 draft pin 为任务依赖被拒（`only formal versions resolve`） | domain 测试组 5；report.json `S3 *` 检查 3 项 |

对照面：四因子（无约束）走 owner 授权 approve+adopt 后可正常绑定与装配——**归档不阻塞授权采用路径，只有带约束对象被永久阻塞**。

## 3. 真实演练结果（20260920T2，正式证据）

```
备份快照：/Users/combo/MyFile/my-data/backups/invest-agent/disaster-recovery/full/2026-09-20T010005+0800（01:05 时点）
import 阶段：305/305 检查通过 —— 93 项门禁重验全过、93 项 staged（hash 双核对）、
             92 项导入（mg 45 / 111 24 / dyk 23）、92 项核对全绿、205 项 owner-review 可发现
rollback 阶段：9/9 检查通过 —— 快照恢复后 9 张表全部归零
```

method 归档导入 2 项：`mg:…methods/控盘度综合评分.md`、`dyk:…methods/strategy-rules.md`（111 无 method 项）。

## 4. 如实上报的边界与发现

1. **docx 格式边界拦截（1 项）**：`mg:…attachments/2026-08-17/att_c6a99f7e….docx` 被 user-assets 服务格式白名单拒绝（`ASSET_UNSUPPORTED_FORMAT`）。演练按纪律**不擅自扩产品白名单**（涉及上传面行为），该项以 `format-unsupported-by-asset-service` 显式拦截并保留在 skipped 清单。是否为 W7 扩白名单属 owner 裁决。
2. **备份时点**：本次演练消费 01:05 快照并以逐项字节重校验补偿时点差（93/93 hash 一致，无漂移）。W0 REVIEW 已约定 W7 正式迁移前须以**新备份 + 新清单**重跑；演练脚本可直接复用。
3. **run-basis 演示段有状态**：approve/adopt/seed 发生在隔离 DB，重跑演练须使用全新 run 目录（T1 痕迹即在已演示库上重跑所致，非导入器缺陷；导入段本身幂等）。
4. **未做（W5 遗留边界不变）**：generic runner 上游端到端驱动、scheduled 生产 task 注册对齐、任务创建用户授权门面、共享可见性授权模型、owner token 生产注入。这些是生产切换（W7）前置，不是本演练范围。
5. 本报告全部证据产生于隔离环境，**不是生产切换**；`.state/agent-space-w6/` 已 gitignored 并限权（目录 0700、文件 0600）。

## 5. 验证命令与结果

```
node --import tsx --test --test-concurrency=1 --test-force-exit tests/agent-space-migration.test.ts   # 6/6
node --import tsx --test --test-concurrency=1 --test-force-exit tests/agent-space-domain.test.ts      # 34/34
npm test    # 730/730（~49s 自终止）
npm run build && npx tsc --noEmit   # 0 错误
```

Schema 无变更（复用 W1-W5 全部表与服务）；新增代码仅 `migration.ts`（服务层导入器）、`w6-rehearsal.mjs`（脚本）、域测试文件，不触碰任何生产路径与既有行为。

## 6. 复跑说明

```
RUN=.state/agent-space-w6/<新runTs> && mkdir -p $RUN/isolated/{workspaces,projects,templates}
DB_PATH=$RUN/isolated/w6.db WORKSPACE_ROOT=$RUN/isolated/workspaces \
RUNTIME_DATA_ROOT=$RUN/isolated/runtime MASTRA_PROJECTS_ROOT=$RUN/isolated/projects \
SYSTEM_SKILLS_TEMPLATE_ROOT=$RUN/isolated/templates NODE_ENV=test WORKSPACE_BACKEND=mastra \
node --import tsx scripts/agent-space/w6-rehearsal.mjs \
  --w0-root .state/agent-space-w0 \
  --backup-root <灾备快照根> --out-root $RUN --phase import
# 回滚验证（独立进程、同 env + --w0-root/--out-root/--snapshot $RUN/04-rollback/pre-snapshot.db --phase rollback-verify）
```
