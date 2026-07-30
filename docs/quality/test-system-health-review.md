# 测试体系健康审计

审计日期：2026-07-28

当前测试体系只保留确定性代码验证。产品行为评估由 workspace Skills、当前上下文、真实用户交互以及服务层日志审计完成；不维护 Golden Case、评测工作台、模型 judge、批量执行器或报告队列。

## 当前基线

| 领域 | 证据 | 状态 |
| --- | --- | --- |
| 统一验证 | `npm run verify`；GitHub Actions 调用同一命令 | Pass |
| 正式测试 | `npm test` 执行确定性单元和服务契约测试 | Pass |
| 编译与类型 | `npm run build` 完成一次全量 TypeScript 类型检查和产物编译 | Pass |
| 服务安全和边界 | `npm run test:boundary` 并行执行 7 个隔离的构建产物、进程和迁移检查 | Pass |
| 其他服务契约 | onboarding confirm、附件、scheduler 等定向 smoke | Partial |
| 产品行为 | `conversation_messages`、`sandbox_audit_logs`、`codex_acp_traces`、workspace 产物 | Agent/用户审阅 |
| 默认门禁隔离 | 正式测试和 boundary tests 只使用测试或临时 DB/workspace，不连接真实 ACP 和外部 provider | Pass |

## 下一步

稳定的模块行为进入 `node:test`；只有必须验证编译产物、子进程、HTTP/MCP 注册或数据库迁移的检查才进入 `test:boundary`。真实行情、ACP、生产和发布验收保持为显式 probe/acceptance，不进入默认门禁。

新增或修改的合并门禁统一进入 `npm run verify`，CI 不复制内部命令。`npm run typecheck` 保留给开发中的快速检查，但 `verify` 不在 `npm run build` 前重复执行同一套类型检查。

投资判断、对话质量和方法论不再以 YAML Case 固化；优先更新相关 workspace Skill、项目上下文或服务审计检查点。
