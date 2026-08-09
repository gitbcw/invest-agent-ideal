# 版本快照与 AI 辅助回退执行方案

## 目标与边界

本方案是 T-194 阶段 2 的执行基线。目标是在不引入 CI/CD、多环境、蓝绿、金丝雀或自动回滚的前提下，把当前“从某个目录手工发布、现场修复”的方式收敛为可审计的版本快照、标准部署和人工门禁回退流程。

必须同时满足：

- 系统版本由 `main` 的确定提交确定，代码、系统 prompt、模板和模板 Skills 一起版本化。
- `111`、`dyk`、`mg` 的真实 Workspace 独立快照，至少保留最近 3 个已知可用发布版本。
- 默认回退只替换系统代码，不替换 `.env`、SQLite、真实 Workspace、reviews、微信状态或其他运行资产。
- Workspace 回退先生成差异清单和 AI 合并提案，逐用户、逐文件人工确认后才能应用。
- 当前异常状态在任何替换前再次备份；生产包和候选文件均校验 SHA-256。
- 回退过程和验证结果落盘，目标是系统代码 10 分钟内恢复，批准后的少量 Workspace 文件 20 分钟内恢复。

阶段 1 的每日备份仍是最终数据兜底，不因发布快照机制而停用。

## 已确认的生产形态

| 对象 | 权威位置 | 所有权 | 回退策略 |
| --- | --- | --- | --- |
| Git 系统源 | 本机仓库 `main` | 系统 | 从已验证发布快照重新部署 |
| 生产代码 | `/home/claude/invest-agent` | 系统 | 允许标准代码回退 |
| 真实 Workspace | `/home/claude/invest-agent-data/workspaces/{111,dyk,mg}` | 用户实例 | 默认保留当前；只允许受控逐文件恢复 |
| SQLite、reviews、`.state`、微信状态 | `/home/claude/invest-agent-data` 及生产 runtime | 服务运行资产 | 代码回退不触碰；仅灾难恢复时走独立流程 |
| `.env`、token、Codex auth/logs/tmp | 服务器本地 | 敏感运行资产 | 不进入版本快照，也不输出内容 |

`scripts/deploy-volcano.sh` 是普通代码发布的唯一底层入口。`package-volcano-runtime.sh` 和 `apply-volcano-runtime.sh` 只用于明确授权的数据迁移或灾难恢复，不用于日常版本回退。

## 快照模型

本机私有根目录：

```text
/Users/combo/MyFile/my-data/backups/invest-agent/releases/
  <release-id>/
    manifest.json
    source.bundle
    source.tar.gz
    workspaces/
      111/...
      dyk/...
      mg/...
    workspace-manifest.txt
    checksums.sha256
    status/
      created.json
      deployed.json
      accepted.json
  recovery-runs/
    <run-id>/
      request.json
      inventory.json
      proposal.json
      candidates/
      approval.json
      apply-log.json
      verification.json
```

发布 ID 为 `<UTC时间>-<main短SHA>`，例如 `20260727T060000Z-a1b2c3d4`。每个发布快照包含：

1. `source.bundle`：自包含的 Git 对象与发布提交引用，避免只依赖当前工作树或远端分支。
2. `source.tar.gz`：目标提交的可部署树，包含被 Git 跟踪的代码、prompt、模板和模板 Skills。
3. `workspaces/`：创建发布快照时重新从生产只读拉取并完成三方 SHA-256 校验的 `111`、`dyk`、`mg` 副本。通过硬链接从阶段 1 快照固定到发布目录，阶段 1 按日清理后仍然有效。
4. `manifest.json`：release ID、完整 commit、branch、创建时间、source-control gate 模式、`origin/main` 基线、Workspace 名单、排除项、源包和 Workspace 清单摘要、工具版本及状态。
5. `checksums.sha256`：快照内固定产物的校验值。

只有满足以下条件的快照才能标记 `known-good`：从规范仓库的干净 `main` 创建，普通模式下 `HEAD` 与在线刷新的 `origin/main` 一致，或紧急模式下本地 `main` 严格领先 `origin/main` 且记录精确确认；本地 `npm run verify` 通过、生产发布成功、发布后最小验收通过。保留策略仅自动清理超出保留数且状态为 `known-good` 的旧版本；`candidate`、失败、正在用于 recovery 或人工 pin 的版本不自动删除。默认保留 3 个 known-good。

## 命令接口

阶段 2 实现以下薄脚本，复用现有发布和备份逻辑：

```bash
# 1. 在发布前创建系统 + Workspace 一致性快照
npm run release:snapshot -- create

# 仅紧急未推送发布：必须是本地 main 严格领先 origin/main
npm run release:snapshot -- create --confirm=release-unpushed-main-v1

# 2. 从指定快照的干净源树标准发布；不会替换运行数据
npm run release:deploy -- <release-id>

# 3. 发布后验收通过，再把快照标为 known-good
npm run release:snapshot -- accept <release-id> --confirm=mark-known-good-v1

# 4. 默认代码回退；显式确认目标后仍只走普通代码发布
npm run release:rollback -- <release-id> --confirm=rollback-code-v1

# 5. 只读生成 Workspace 差异库存，供 AI 产出可审计提案
npm run release:workspace-rollback -- plan <release-id>

# 6. 校验并应用已经人工批准的逐文件提案
npm run release:workspace-rollback -- apply <run-id> \
  --approval=<absolute-approval-json> \
  --confirm=apply-approved-workspace-files-v1 \
  --target=production
```

所有生产命令必须拒绝：非规范仓库、脏工作树、非 `main` 分支、本地落后或分叉历史、未经确认的未推送提交、不在私有快照根下的路径、符号链接逃逸、未知用户、目录/通配符资产、hash 不匹配、快照不完整、未记录当前状态备份、错误确认短语。日志不得包含文件正文、token 或凭证。

## 标准发布流程

1. 在规范仓库的干净 `main` 记录完整 commit，在线刷新 `origin/main`；普通发布确认 `HEAD == origin/main`，紧急未推送发布确认 `origin/main` 是 `HEAD` 的严格祖先并提供精确确认短语。
2. 执行 `release:snapshot create`。脚本先完成 source-control gate，再运行 `npm run verify`，同步生产 Workspace，验证远端前后与本地 SHA-256 一致，固定发布快照并校验所有产物。
3. 从快照解包到临时干净目录，执行现有 `scripts/deploy-volcano.sh`。禁止从调用者当前脏工作树发布。
4. 执行当前生产手册中的健康、PM2、MCP、Workspace 预检、微信 listener、push job 和只读 ACP 单点验收。
5. 将验收摘要写入 `status/accepted.json`，人工确认后标记 `known-good`。
6. 清理策略保证至少保留最近 3 个 known-good 发布快照。

## 代码回退流程

```text
选定 known-good
  -> 校验 manifest 与 checksums
  -> 创建“当前异常态”证据（commit/远端文件清单/Workspace 新快照）
  -> 从目标 source.tar.gz 建立临时干净发布目录
  -> 调用 deploy-volcano.sh
  -> 健康与只读链路验收
  -> 写入 recovery run
```

代码回退不需要 AI 合并，因为系统版本由 Git 确定。若健康检查失败，停止继续处理 Workspace，保留日志并从回退前证据或另一个 known-good 版本再次部署。

## Workspace AI 辅助回退

### 只读盘点

`release:workspace-rollback -- plan` 再创建一个当前生产 Workspace 快照，以它和目标发布快照比较，生成 `inventory.json`。每条差异至少记录：用户、相对路径、文件类型、当前 hash、目标 hash、变更类型和允许动作。

分类规则：

- `.sandbox-token`、`.codex/auth.json`、Codex logs/tmp 等敏感或运行文件：永不进入盘点或候选。
- SQLite、图片、压缩包和其他二进制：AI 不合并，默认 `keep-current`；只有明确的整文件恢复批准才可处理。
- `AGENTS.md`、`.codex/skills/**`、`config/**`、`memory/**` 及文本产物：允许 AI 比较，但默认仍为 `keep-current`。
- 报告和历史产物：默认保留当前，除非其损坏且用户明确要求恢复目标文件。
- 符号链接：只记录，不自动跟随或恢复。

### AI 提案契约

AI 只能读取两个已脱敏快照和 `inventory.json`，输出 `proposal.json` 与 `candidates/`，不得直接连接生产或执行写入。每个文件只能选择：

- `keep-current`：保留用户最新状态。
- `restore-target`：恢复到目标快照，必须说明当前变化为何属于故障或不兼容。
- `merge-candidate`：生成候选文件，必须分别列出保留的用户调整、跟随回退的系统相关内容和不确定项。
- `manual-review`：证据不足，不提出替换。

提案必须包含输入 hash、候选 hash、理由、风险和验证方式。任何 hash 在批准后变化都会使批准失效。

### 人工门禁与应用

人工批准文件必须逐用户、逐相对路径列出允许动作和期望 hash，不能批准目录或 `*`。应用脚本依次执行：

1. 重新读取生产文件 hash，确认仍与提案输入一致。
2. 在 Workspace 外创建当下文件备份和 manifest。
3. 校验目标或候选文件 hash。
4. 以同目录临时文件 + 原子 rename 替换单个文件。
5. 重新运行该用户 Workspace 预检和针对性只读验收。
6. 写入 `apply-log.json` 与 `verification.json`；任一步失败立即停止，不批量继续。

人工拒绝或没有批准的条目一律保持当前版本。真实 Workspace 不存在“整体恢复”快捷命令。

## 实现顺序

1. 实现发布快照脚本、manifest schema、校验和保留策略，并用临时 Git 仓库和本地 Workspace fixture 做 smoke test。
2. 实现从快照临时目录调用普通部署脚本的包装器；用 fake SSH/rsync 做离线验证，不连接生产。
3. 实现代码回退包装器和 recovery audit，验证默认不触碰 Workspace/SQLite/`.env`。
4. 实现 Workspace 只读 inventory、AI proposal schema validator、逐文件批准应用器；只在隔离 fixture 演示 merge。
5. 更新火山云生产手册和 `package.json` 命令。
6. 在用户授权的维护窗口做一次真实演示：创建快照 -> 发布无害版本 -> 代码回退 -> 生成 Workspace 对比 -> 不应用或只应用隔离测试文件 -> 完成验收。

## 验收记录

离线自动验收必须覆盖：

- 脏 worktree、非 `main`、失败测试不能创建可发布快照。
- 快照包含目标 commit 的 tracked prompt/Skills，且不包含凭证或生产运行数据。
- 三个 allowlist Workspace 均存在且 hash 清单一致，其他目录不进入快照。
- 篡改 source、Workspace 或 manifest 后校验失败。
- 只保留最近 3 个 known-good，pin/候选/recovery 使用中的版本不被删。
- 代码回退只调用普通部署路径，保护 `.env`、SQLite、Workspace、reviews 和状态目录。
- AI proposal 无 hash、越权路径、目录、通配符、未知动作或未知用户时被拒绝。
- 未确认不能应用；输入漂移、候选篡改、备份失败时不能应用。
- 隔离 fixture 可演示 `keep-current`、`restore-target`、`merge-candidate` 和拒绝分支，并生成完整审计记录。

生产人工验收必须记录总耗时、目标 release ID、回退前后 commit、健康检查、三个 Workspace 预检、MCP/ACP 只读结果和是否发生 Workspace 写入。任务只有在用户完成一次维护窗口演示并确认“够简单、丢失可控”后才能申报完成。
