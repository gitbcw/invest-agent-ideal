# 发布记录：生产锁定装配模式——关闭旧 Workspace 运行入口（2026-10-13）

- releaseId：`20261013T020148Z-5a20a61c`，commit `5a20a61c`，known-good 已标记。
- 依据：[T534-compatibility-window-closure.md](./agent-space-execution/T534-compatibility-window-closure.md) 请示①，owner 2026-10-13 批准。

## 发布内容

生产（`NODE_ENV=production`）下 `AGENT_SPACE_ASSEMBLY_MODE` 非 `on` 一律视为 `on` 并 warn 一次：`off`/`scope:*`/缺省无法再让轮次回落 legacy Workspace 装配（autoLoadSkills + 路径写入 + AGENTS.md instructions），旧运行入口自此无法通过改配置重开，回退只能走发版。测试与隔离镜像（NODE_ENV=test）保留 `off`/`scope` 语义（agent-space 测试基建依赖）。

实施前的证据修正：装配轮挂载的是新项目根（`data/mastra-projects/<digest>`），10-10 装配全量以来两通道 `mastra_workspace_*` 调用读写的均为 staging/资产面，旧 `workspaces/` 树零接触——旧入口唯一活体是配置回退分支，本次锁定即关闭。旧 Workspace 文件原样保留（history-only + 每晚备份），物理删除未做（需另立任务）。

## 验证证据

- 新增 `tests/agent-space-assembly-lock.test.ts` 2 例（生产强制 on / 非 production 保留 off+scope 语义）；agent-space 域 39 例全过；typecheck 干净。
- 发布后验收：`/health` ok、Portal `/api/health` 200、PM2 双进程 online（↺135/31）、所有模块启动完成、重启后 app.log ERROR=0、生产 dist 实证含锁定逻辑、生产 `.env` 为 `on` 故无锁定 warn（符合预期）。

## 回滚

`npm run release:rollback -- 20261013T020148Z-5a20a61c`。纯代码路径，无数据迁移；回滚即恢复"配置可回退旧装配"的旧行为。
