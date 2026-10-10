# Mastra 分支与 main 同步规约

迁移分支 `feat/mastra-migration` 与 `main` 长期并存。`main` 仍可作为历史业务上游参考，但当前生产已切换到本分支：PM2 `invest-agent-mastra`、runtime `23655`、Portal/Relay `23657/23658`。本文后续的 `23656` 隔离拓扑描述的是历史验证环境，不是当前生产目标。

## 当前同步基线

当前已吸收 `main` 直系业务提交：

- `d2b493f`：自动化超时与 XLSX 输出路径处理，对应实现为受控 staging 目录内的文件读取与 base64 输出。
- `74184c9`：自动化运行审计，对应 `/api/platform/automation-runs`、权限校验和管理端审计视图。
- `8702952`：会话取消与服务重启恢复，对应 Mastra 的中性 `AbortSignal`、`TASK_CANCELLED` 和启动收敛逻辑。

当前分支还包含 Mastra runtime checkpoint `6a25153` 及后续原生化提交。最近同步基线为 `74184c9`；`8702952` 的行为已在 `9cccf8b` 中改写为 Mastra 实现。

## 后续同步流程

1. 查看增量：`git log <last-main-sync>..main`。
2. 按提交分类：业务功能、数据/API 契约、运行时实现、旧 ACP 实现。
3. 纯业务和契约变更可逐提交 cherry-pick；旧 ACP 实现只提取行为要求，在 `src/runtime`、`src/mastra` 或服务层重写。
4. 保持中性协议、`agent_traces`、Mastra 模型网关和隔离状态根，不恢复 ACP/Codex/Hermes 执行依赖。
5. 执行 `git diff --check`、`npm run typecheck`、`npm run build`、`npm test`，再启动隔离 runtime `23656` 与 Portal `23657` 做健康检查和真实回合验证。
6. 更新本文件的同步基线和验证证据。

## 禁止事项

- 不直接 merge `main`，不操作旧 `main` runtime；生产数据和真实 Workspace 仍须通过明确授权的生产运维流程操作。
- 不恢复 `src/acp` 执行器、ACP session/cancel 语义或 Claude CLI 调用。
- 不把 `test-projects/` 或迁移工作树作为正式 Portal 发布源。
