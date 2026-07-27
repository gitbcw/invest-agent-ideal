# T-194 晚间维护窗口演示与任务收尾交接

## 1. 交接目的

本文供接手 Agent 在 2026-07-27 北京时间 20:00 以后完成 T-194「数据备份与版本回退机制」的生产维护窗口演示和任务收尾。

阶段 1 已完成并在运行：Mac mini 使用 Bash 脚本配合 macOS `launchd`，每天 01:00 从生产只读备份 `111`、`dyk`、`mg` 三个真实 Workspace，保留最近 3 个成功自然日。

阶段 2 的设计、脚本、操作手册和离线验收已经完成。剩余工作不是继续开发功能，而是：

1. 安全地把 T-194 改动收敛到 `main`，不夹带当前工作树中的其他任务。
2. 在晚间维护窗口做一次真实的发布、代码回退、恢复到最新版本和 Workspace 只读对比。
3. 记录分钟级恢复证据，由用户完成 human gate。
4. 通过 Personal OS MCP 申报 T-194 完成。

## 2. 当前状态与可信来源

执行前必须完整阅读：

- `AGENTS.md`
- `CLAUDE.md`
- `.codex/skills/volcano-ops/SKILL.md`
- `.codex/skills/volcano-ops/references/server-deployment.md`
- `docs/version-snapshot-and-assisted-rollback-plan.md`
- `docs/workspace-backup-operations.md`
- 本文

Personal OS 任务：`T-194`，当前状态应为 `doing`。

截至本文编写时：

- 当前分支：`main`
- 当前 HEAD：`6e7e1fa feat: publish durable HTML reports`
- 工作树不是干净状态。
- 除 T-194 外，还存在 conversation history、resource mutation consistency、Portal concurrency 等其他任务的修改和未跟踪文件。
- 不得 `git reset --hard`、`git checkout -- .`、整仓 `git add -A`、擅自 stash 或删除这些修改。

T-194 主要文件：

```text
.codex/skills/volcano-ops/references/server-deployment.md
docs/README.md
docs/version-snapshot-and-assisted-rollback-plan.md
docs/workspace-backup-operations.md
docs/t194-maintenance-window-handoff.md
package.json
scripts/deploy-volcano.sh
scripts/backup-volcano-workspaces.sh
scripts/install-volcano-workspace-backup-launchagent.sh
scripts/volcano-workspace-backup-smoke.sh
scripts/release-snapshot.mjs
scripts/release-deploy.mjs
scripts/workspace-rollback.mjs
scripts/release-snapshot-smoke.mjs
```

共享文件可能包含其他任务的并发修改。提交前必须逐文件审阅 diff；若同一文件混入无法可靠区分的其他改动，停止并向用户报告，不得猜测归属。

## 3. 授权与禁止事项

用户已授权把生产演示安排在今晚 20:00 以后。该授权覆盖本文规定的：

- 精确提交 T-194 变更到本地 `main`。
- 创建生产发布快照。
- 使用标准代码发布路径部署演示版本。
- 回退到已知正常版本，然后恢复到最新 `main`。
- 对生产 Workspace 做只读快照、校验、预检和差异盘点。

该授权不覆盖：

- push GitHub、创建 PR 或向外部仓库写入。
- 替换或恢复生产 `.env`、SQLite、reviews、`.state`、微信状态或完整运行时数据。
- 应用任何真实 Workspace 差异提案。
- 向真实用户发送测试微信、创建规则、触发主动推送或修改投资数据。
- 清理其他任务的工作树修改。

Workspace 演示必须停在只读 `inventory.json`。即使 inventory 有差异，也只能报告，不生成生产 approval，不执行 `--target=production`。

## 4. 执行前门禁

以下条件缺一不可；不满足时停止，不进入发布：

1. 当前时间已过北京时间 20:00。
2. 确认只有一个执行者。检查是否已有名为“T-194 晚间生产回退演示”的 Codex automation 或另一个 Agent 在运行，避免重复发布。
3. SSH、rsync、npm、Node、Git 和 PM2 生产访问可用。
4. 阶段 1 最新备份成功，`launchd` 最近退出码为 0，错误日志为空。
5. `npm run release:snapshot:smoke`、`npm run backup:workspaces:smoke`、`npm run verify` 全部通过。
6. 当前没有 scheduler 任务命中维护时段，没有无法解释的 active push job。
7. 生产健康、PM2、Portal/relay、三个微信 listener 在演示前处于正常基线。
8. 所有 T-194 变更可以与其他未提交修改精确隔离。

建议先记录：

```bash
date '+%Y-%m-%dT%H:%M:%S%z'
git status --short
git branch --show-current
git rev-parse HEAD
launchctl print "gui/$(id -u)/com.invest-agent.volcano-workspace-backup" \
  | rg 'state =|runs =|last exit code|pid ='
tail -n 20 "$HOME/Library/Logs/com.invest-agent.volcano-workspace-backup.out"
wc -c "$HOME/Library/Logs/com.invest-agent.volcano-workspace-backup.err"
```

禁止打印 `.env`、token、`.sandbox-token`、Codex auth 或微信凭证内容。

## 5. Git 收敛方案

### 5.1 为什么分成两个提交

真实回退演示需要两个不同的可发布版本：

- 版本 A：T-194 机制实现，作为第一个 known-good。
- 版本 B：只新增本文这份交接文档，作为无业务逻辑变化的演示发布版本。

先部署 B，再回退 A，可以证明版本确实发生切换；最后重新部署 B，使生产回到最新 `main`。版本 B 只有文档变化，不引入用户业务风险。

### 5.2 提交 A：机制实现

提交 A 应包含 T-194 机制和既有操作文档，但不包含：

```text
docs/t194-maintenance-window-handoff.md
docs/README.md
```

`docs/README.md` 的 T-194 导航和本文一起留到提交 B，使 A、B 之间形成纯文档差异。

执行者必须先逐文件审阅。确认共享文件中的所有待提交 hunks 都属于 T-194 后，按精确路径暂存；禁止整仓暂存。建议提交信息：

```text
feat: add production backup and assisted rollback workflow
```

提交后检查：

```bash
git show --stat --oneline HEAD
git diff --cached --check
git status --short
```

其他任务的未提交文件继续留在工作树中是正常的。不要为了让当前工作树干净而处理它们。

### 5.3 提交 B：交接文档

只暂存并提交：

```text
docs/t194-maintenance-window-handoff.md
docs/README.md 中两行 T-194 导航
```

当前 `docs/README.md` 还可能包含 `custom-formula-historical-screening-research.md` 等其他任务的导航修改。提交 B 只能暂存 T-194 对应的独立 hunk，不得把其他导航改动带入。

建议提交信息：

```text
docs: add T-194 maintenance handoff
```

记录：

```bash
RELEASE_A_COMMIT=<提交 A 完整 SHA>
RELEASE_B_COMMIT=<提交 B 完整 SHA>
```

如果无法形成这两个精确提交，停止。不要用临时演示代码或修改业务逻辑制造版本差异。

## 6. 使用临时干净 clone

当前主工作树会继续保留其他任务的未提交修改，因此所有发布快照命令必须在临时干净 clone 中执行。

使用 `mktemp -d` 创建临时根，clone 本地仓库，不要复用带用户修改的当前目录。clone 后确认：

```bash
git branch --show-current   # 必须为 main
git status --porcelain     # 必须为空
git rev-parse HEAD         # 必须等于 RELEASE_B_COMMIT
npm ci
```

临时 clone 只用于构建和发布，生产快照仍写入私有固定目录：

```text
/Users/combo/MyFile/my-data/backups/invest-agent/releases
```

临时目录在所有证据记录完成后才可删除。

## 7. 维护窗口演示

### 7.1 创建并发布版本 A

在临时 clone 中把本地 `main` 指向提交 A。`git reset --hard` 只允许在这个新建且确认路径无误的临时 clone 内使用，禁止在原工作树运行：

```bash
git reset --hard "$RELEASE_A_COMMIT"
git branch --show-current
git status --porcelain
git rev-parse HEAD
```

确认分支仍为 `main`、状态为空、HEAD 等于 A 后执行：

```bash
npm run release:snapshot -- create
npm run release:deploy -- <release-a-id>
```

记录快照耗时、发布耗时、release ID 和完整 commit。发布后执行第 8 节验收。全部通过后，人工确认 A 为 known-good：

```bash
npm run release:snapshot -- accept <release-a-id> \
  --confirm=mark-known-good-v1
```

### 7.2 创建并发布版本 B

将临时 clone 的 `main` 更新到提交 B，确认工作树干净：

```bash
git reset --hard "$RELEASE_B_COMMIT"
git branch --show-current
git status --porcelain
git rev-parse HEAD
```

随后执行：

```bash
npm run release:snapshot -- create
npm run release:deploy -- <release-b-id>
```

执行第 8 节最小验收。此时不要先把 B 标为 known-good，先进行回退演示。

### 7.3 从 B 回退到 A

开始计时，然后执行：

```bash
npm run release:rollback -- <release-a-id> \
  --confirm=rollback-code-v1
```

脚本应先只读抓取一次当前三个 Workspace，再从 A 的不可变快照临时目录重新走普通代码发布。记录：

- 回退开始和结束时间。
- 总耗时，目标为 10 分钟内恢复系统代码。
- 生产 `.deploy/release.json` 的 release ID、commit 和 operation；只读取元数据，不读取秘密。
- 回退前 Workspace backup label。
- recovery run 路径。

执行第 8 节完整验收。任何关键项失败时停止，不继续 Workspace 对比，也不把失败版本标为 known-good。

### 7.4 生成 Workspace 只读对比

A 回退验收通过后执行：

```bash
npm run release:workspace-rollback -- plan <release-a-id>
```

检查生成的 `inventory.json`，只记录：

- run ID。
- 差异总数。
- 各用户差异数量。
- 是否出现敏感、越权、符号链接或未知用户条目。

不要在聊天或日志中粘贴用户文件正文。预期这次演示通常为 0 差异；如果有差异，默认全部 `keep-current`，只报告原因和风险。本次维护窗口禁止执行 Workspace `apply`。

### 7.5 恢复到最新版本 B

为避免生产最终落后于 `main`，完成 A 的回退验收和只读对比后，重新部署 B：

```bash
npm run release:deploy -- <release-b-id>
```

再次执行第 8 节验收。全部通过后标记 B 为 known-good：

```bash
npm run release:snapshot -- accept <release-b-id> \
  --confirm=mark-known-good-v1
```

最终状态必须是：生产 release ID 指向 B，生产 commit 等于 `RELEASE_B_COMMIT`，A 和 B 都有完整审计证据，真实 Workspace 未发生写入。

## 8. 每次发布/回退后的验收

以 `.codex/skills/volcano-ops/references/server-deployment.md` 为权威操作手册，至少逐项确认：

1. `curl http://127.0.0.1:22655/health` 正常。
2. `pm2 list` 中 `invest-agent` 为 `online`。
3. Portal `/api/health` 正常，connector/relay 没有冲突。
4. `npm run smoke:mcp-service-tools` 通过。
5. `111`、`dyk`、`mg` 三个 Workspace preflight 无 blocker；`template_updates` 可以存在。
6. 三个微信实例仍为 connected，listener 已恢复。
7. active push job 为 0，或每个 active job 都有明确来源且未被本次演示误触发。
8. 从本次 PM2 uptime 开始没有新 `ERROR`、ACP `ENOENT` 或 scope 回退。
9. 用已授权测试账号完成一次主进程只读 ACP 单点验收；不得输出持仓明细，不得写入投资状态，不得发送测试微信。
10. `.env`、SQLite、reviews、`.state`、真实 Workspace 和微信状态未被代码发布替换。

`pushReady=false` 不等于 listener 故障。若只是缺少真实用户最新入站 conversation，按当前手册记录，不得为变成 true 主动发消息。

## 9. 立即停止条件

出现以下任一情况，停止后续步骤，保持或恢复到最近一次已验证版本并报告：

- 当前时间早于 20:00，或发现用户仍在活跃使用且维护窗口不合适。
- 工作树变更无法与其他任务可靠隔离。
- 快照校验、SHA-256、Git bundle 或 Workspace 内容摘要不一致。
- 发现快照包含 `.sandbox-token`、`.codex/auth.json` 或其他凭证。
- 生产健康、PM2、Portal、MCP 或 listener 验收失败。
- active push job 或 scheduler 状态无法解释。
- 任何命令试图替换 `.env`、SQLite、reviews、`.state` 或 Workspace。
- 生产 Workspace 与提案输入发生漂移。
- 需要扩大到数据恢复、完整运行时替换或真实 Workspace apply。

不要为了“完成演示”绕过确认短语、修改脚本门禁或现场手改生产。

## 10. 证据包

维护窗口结束后，应有以下证据：

```text
提交 A/B 完整 SHA
release A/B ID
release A/B manifest.json 与 checksums.sha256 校验结果
release A/B status/created.json、deployed.json、accepted.json
代码回退 recovery run/request.json 与 deployment.json
Workspace 对比 recovery run/request.json 与 inventory.json
每一步开始/结束时间和耗时
健康、PM2、Portal、MCP、preflight、listener、push job、ACP 只读验收摘要
最终生产 release ID 与 commit
明确声明 Workspace apply 次数为 0
```

证据摘要只写状态、计数、hash、路径和结论，不复制用户投资内容或秘密。

## 11. Personal OS 收尾

### 11.1 追加执行报告

通过 `personal-os` MCP 的 `task_report` 向 `T-194` 追加维护窗口证据，至少包含：

- A/B commit 和 release ID。
- 发布、回退、最终恢复的耗时。
- 所有验收项结论。
- Workspace inventory 差异计数和 `apply=0`。
- 最终生产版本。
- 是否满足系统代码 10 分钟恢复目标。
- 遗留风险或偏差。

### 11.2 用户 human gate

向用户提交简短验收摘要，并明确询问：

```text
是否确认本次流程可跑、操作足够简单、用户调整丢失风险可控，并同意申报 T-194 完成？
```

没有用户明确确认，不得把任务直接标为 `done`。

### 11.3 申报完成

用户确认后，调用 `personal-os` MCP 的 `task_complete`，evidence 应引用上述证据路径、命令退出码、耗时和验收结论。T-194 没有独立任务契约且包含 human gate，`task_complete` 可能生成最终人工审批；按 MCP 返回结果告知用户是否还需批准。只有 Personal OS 状态实际变成 `done`，才能宣称任务完成。

不要把“脚本已实现”“离线 smoke 已通过”或“已发起审批”表述为任务已经完成。

## 12. 最终交付口径

最终向用户报告时应清楚区分：

- 已完成：阶段 1 每日备份、阶段 2 快照/回退实现、生产演示、只读 Workspace 对比、最终恢复。
- 未发生：生产数据替换、真实 Workspace apply、测试微信、投资数据写入、GitHub push/PR。
- 最终状态：生产运行最新 `main` 的版本 B；A/B 均可校验；至少保留 3 个 known-good 的机制已验证，当前实际 known-good 数量按证据如实说明。
- 后续日常操作：每次正式发布都走 `snapshot -> deploy -> acceptance -> accept`；事故时走 `rollback -> acceptance`，Workspace 默认保留当前。

## 13. Executor Prompt

```text
接手 Invest Agent 的 Personal OS 任务 T-194 晚间维护窗口演示与收尾。完整阅读 AGENTS.md、CLAUDE.md、volcano-ops Skill 及 docs/t194-maintenance-window-handoff.md，并严格按交接文档执行。当前工作树混有其他任务的未提交修改：不得 reset、stash、清理或整仓提交，只能精确隔离 T-194。仅在北京时间 20:00 以后执行生产步骤。生产演示只允许代码快照、标准发布、代码回退、最终恢复和 Workspace 只读对比；不得替换运行数据、应用 Workspace 差异、发送测试微信或 push/PR。遇到门禁不满足立即停止并报告。完成后向 Personal OS T-194 写入证据，等待用户确认“可跑、够简单、风险可控”，再 task_complete。
```

## 14. Reviewer Prompt

```text
独立验收 T-194。以 docs/t194-maintenance-window-handoff.md 和 docs/version-snapshot-and-assisted-rollback-plan.md 为标准，核对 Git 提交是否只含 T-194、A/B release 与 recovery 证据、回退耗时、最终生产 commit、三用户 Workspace preflight、MCP/ACP 只读验收、Workspace apply=0 和 Personal OS 状态。重点查找用户工作树被误处理、敏感文件进入快照、运行数据被替换、回退后未恢复最新 main、证据不足却申报完成等问题。不要代替执行者补做生产写入；发现缺口应判定未通过并给出精确补救步骤。
```
