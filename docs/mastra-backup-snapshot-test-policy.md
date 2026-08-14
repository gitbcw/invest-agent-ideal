# Mastra 备份快照测试策略

迁移分支可以使用生产灾备快照验证真实数据兼容性，但测试过程不得写入生产数据库、Workspace、`reviews/`、`.state/` 或备份源本身。

## 强制边界

- `--snapshot` 只允许作为复制源，不能直接绑定到 `DB_PATH`、`WORKSPACE_ROOT`、`RUNTIME_DATA_ROOT` 或 `REVIEWS_ROOT`。
- harness 会把快照复制到一次性的临时目录，并为运行时生成独立 SQLite 副本。
- Workspace 快照通过 `--workspace-snapshot` 和 `--workspace-id` 选择；没有显式指定时不会自动读取真实 Workspace。
- 测试前后对源快照和 Workspace 快照计算 SHA-256 清单；源发生变化时测试失败。
- 默认测试结束删除临时目录；需要人工检查时才使用 `--keep`，完成后应手工删除该临时目录。

## 示例

```bash
node scripts/mastra-backup-snapshot-test.mjs \
  --snapshot /Users/combo/MyFile/my-data/backups/invest-agent/disaster-recovery/full/2026-08-12T010004+0800 \
  --workspace-snapshot /Users/combo/MyFile/my-data/backups/invest-agent/workspaces/snapshots/2026-08-10T235031+0800 \
  --workspace-id mg \
  -- node -e 'console.log(process.env.DB_PATH, process.env.WORKSPACE_ROOT)'
```

该命令只验证隔离环境变量和复制流程；启动 23655 时应继续使用 `data/mastra-local` 或 harness 输出的临时目录，绝不能使用备份源路径。
