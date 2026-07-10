# 测试体系健康审计

审计日期：2026-07-10

当前测试体系只保留确定性代码验证。产品行为评估由 workspace Skills、当前上下文、真实用户交互以及服务层日志审计完成；不维护 Golden Case、评测工作台、模型 judge、批量执行器或报告队列。

## 当前基线

| 领域 | 证据 | 状态 |
| --- | --- | --- |
| 统一验证 | `npm run verify`；GitHub Actions 调用同一命令 | Pass |
| 编译与单测 | `npm run typecheck`、`npm run build`、`npm test` | Pass |
| 服务安全和边界 | 临时 DB/workspace 下执行 security、MCP、legacy migration contract smoke | Pass |
| 其他服务契约 | onboarding confirm、附件、scheduler 等定向 smoke | Partial |
| 产品行为 | `conversation_messages`、`sandbox_audit_logs`、`codex_acp_traces`、workspace 产物 | Agent/用户审阅 |
| 隔离 | 部分存量 smoke 仍可能使用默认 DB/workspace | 待收敛 |

## 下一步

继续把其余高价值 smoke 逐项迁入临时 DB/workspace 的 `node:test` contract 测试。每项保留契约必须覆盖一个失败路径，并禁止默认 `primary`、共享端口和真实 ACP 依赖。新增或修改的合并门禁统一进入 `npm run verify`，不要在 CI 中复制另一套命令。

投资判断、对话质量和方法论不再以 YAML Case 固化；优先更新相关 workspace Skill、项目上下文或服务审计检查点。
