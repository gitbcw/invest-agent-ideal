# Workspace 生产备份操作说明

## 当前范围

这是 T-194 阶段 1 的运行说明。备份仅覆盖火山云生产 Workspace：

- 来源：`/home/claude/invest-agent-data/workspaces` 下显式 allowlist：`111`、`dyk`、`mg`
- 目标：`/Users/combo/MyFile/my-data/backups/invest-agent/workspaces`
- 方向：火山云 -> Mac mini，只读拉取
- 频率：每天 01:00（Mac mini 本地时区）
- 保留：最近 3 个有成功快照的自然日

备份脚本不会自动纳入新目录。2026-07-27 的只读归属核验结果如下：

| Workspace | 归属判断 | 备份 |
| --- | --- | --- |
| `111`、`dyk`、`mg` | active 用户；有 active Codex 实例、微信身份和近期会话 | 是 |
| `primary` | disabled 默认测试用户与 disabled 测试实例 | 否 |
| `onboarding-confirm-step-smoke`、`server-smoke`、`test-prompt-context-packet` | 无对应 user、instance 或 conversation 的 smoke/test 遗留目录 | 否 |

发现新增目录时先通过只读数据库归属、实例状态、渠道身份和近期会话核验是否为真实用户，再人工更新 allowlist；不能因为目录存在就自动备份。

SQLite、微信状态、Portal mirror、代码版本和完整运行时回退不在阶段 1 范围内，由 T-194 阶段 2 另行设计和验收。

## 快照结构

```text
workspaces/
  .invest-agent-workspace-backup-root
  latest -> snapshots/<timestamp>
  snapshots/<timestamp>/
  manifests/<timestamp>.txt
```

脚本先同步到 `.incomplete-current`，再执行 rsync metadata dry-run，并比较远端/本地 SHA-256 清单；远端清单会在本地校验前后各生成一次，用于确认校验期间源没有变化。运行态目录本身的 mtime 变化不影响恢复，验证时允许忽略；任何文件、链接、新增或删除差异仍会阻止发布。只有剩余元数据无差异、内容哈希一致且源稳定时才发布快照并更新 `latest`。Workspace 内符号链接按链接保存，不跟随到生产 Workspace 之外。

以下运行态或敏感项明确排除：

- `.sandbox-token`：Workspace sandbox 凭据，不复制到备份。
- `.codex/auth.json`：生产凭据副本，不复制到备份。
- `.codex/logs_2.sqlite*`：持续变化的 Codex 日志库；权威审计由服务层日志承担。
- `.codex/.tmp/`、`.codex/tmp/`：临时运行文件。
- `.rsync-partial/`：中断续传的临时块目录。
- `._*`：迁移遗留的 AppleDouble 元数据文件。

其余内容继续备份，包括 `AGENTS.md`、`.codex/skills`、memory、goals/state SQLite、sessions、研究产物和用户配置。

失败或中断时 `.incomplete-current` 会保留，以便下次续传，但不会更新 `latest`，也不算成功快照。成功发布后该目录被原子移动到带时间戳的正式快照。

每个 manifest 记录 Workspace allowlist、排除项、文件/目录/链接数量、逻辑大小，以及完整文件哈希清单的聚合 SHA-256，供后续离线完整性复核。

从第二个快照开始，未变化文件通过 hard link 复用上一快照的数据块；每个快照仍可独立浏览。清理旧快照不会破坏新快照中的 hard link 内容。

## 命令

```bash
npm run backup:workspaces:smoke
npm run backup:workspaces
npm run backup:workspaces:install
```

定时任务：

```text
~/Library/LaunchAgents/com.invest-agent.volcano-workspace-backup.plist
```

launchd 实际执行的脚本会由安装命令复制到稳定位置，避免依赖仓库工作树是否移动或切分支：

```text
~/Library/Application Support/InvestAgent/bin/backup-volcano-workspaces.sh
```

仓库脚本更新后需重新执行 `npm run backup:workspaces:install`，安装器会先校验 plist，再替换本机副本并重载任务。

日志：

```text
~/Library/Logs/com.invest-agent.volcano-workspace-backup.out
~/Library/Logs/com.invest-agent.volcano-workspace-backup.err
```

检查状态：

```bash
launchctl print gui/$(id -u)/com.invest-agent.volcano-workspace-backup
readlink /Users/combo/MyFile/my-data/backups/invest-agent/workspaces/latest
cat /Users/combo/MyFile/my-data/backups/invest-agent/workspaces/manifests/<timestamp>.txt
```

## 恢复门禁

备份脚本没有恢复能力，避免误写生产。需要恢复时必须：

1. 精确选择快照并检查对应 manifest。
2. 先把当前生产 Workspace 另行备份。
3. 在临时目录做 rsync dry-run，明确新增、覆盖和删除范围。
4. 停止或冻结相关写入并取得人工确认。
5. 使用独立恢复流程写回，完成后执行 Workspace preflight 和真实链路单点验收。

不得把 `latest` 未经审阅直接同步回生产，也不得让备份任务双向同步。
