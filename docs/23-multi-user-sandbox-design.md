# 多用户沙箱当前契约

本文件描述当前服务层的用户隔离、授权、确认和审计边界。历史设计阶段与执行记录见
[`archive/23-multi-user-sandbox-design-pre-consolidation-2026-07-28.md`](./archive/23-multi-user-sandbox-design-pre-consolidation-2026-07-28.md)。

## 适用边界

- Workspace 内的 Codex ACP 通过具名 MCP 服务工具访问确定性能力，不使用 sandbox HTTP API。
- `/api/sandbox/*` 是 Platform、兼容调用者和非 Agent 集成的适配器，不是 Agent 的能力发现面。
- 服务层必须在所有入口复用同一套 scope、确认、锁和审计语义；HTTP 路由本身不是业务真相来源。
- Skill、Workspace 文件或提示词不能承担访问控制、安全确认或审计保证。

## SandboxContext 与 token

`src/lib/sandbox-context.ts` 签发和验证 HMAC token。token 绑定：

- `userId`
- `projectId`
- `instanceId`
- `conversationId`
- `role`
- `channel`
- `permissions`
- 签发与过期时间

默认有效期为 1 小时。生产环境必须显式设置 `INVEST_AGENT_SANDBOX_SECRET`；本地开发可使用持久化的 `data/.sandbox-secret`。调用者不得通过请求体或查询参数扩大 token 已绑定的 scope。

权限检查采用最小授权。管理态、系统态或其他用户的资源不能因为知道 ID 就被用户态 token 访问。

## 写操作确认

`src/lib/sandbox-confirmation.ts` 管理待确认操作，默认有效期为 10 分钟。确认必须同时匹配：

- 用户、项目、实例和会话；
- operation 与 resource；
- 规范化后的 payload；
- 发起确认的 token/turn 约束；
- 后续轮次中的明确确认。

确认不能跨会话、跨资源、跨 payload 或在同一轮中消费。payload 改变后必须重新确认。高风险写入应通过 `sandboxMutationSafe` 及资源锁执行，避免同一资源并发覆盖。

## 审计与持久化

`src/lib/sandbox-audit.ts` 将允许、拒绝和失败结果写入 `sandbox_audit_logs`。审计记录必须保留调用 scope、operation、resource、状态和必要摘要，但不得把密钥或完整敏感内容写入日志。

待确认状态存于 `pending_sandbox_confirmations`。数据库表的所有权与迁移规则见 [`table-ownership.md`](./table-ownership.md)。

## 文件与资源隔离红线

- Workspace 路径必须从已验证的用户 scope 解析，禁止接受任意绝对路径。
- 禁止路径遍历和通过符号链接逃逸 Workspace。
- 真实 Workspace 的配置、Skills 与产物属于用户实例；模板差异不构成覆盖授权。
- 服务/MCP 层必须校验资源归属，不能依赖前端隐藏字段或调用者自律。
- 同一确定性写操作无论来自 MCP 还是 HTTP，都必须保持相同确认与锁语义。

## 当前限制

Portal 的 `workspace.file.list/get` 是服务层强制的只读浏览边界，但 Codex ACP 进程当前仍拥有其绑定 Workspace 内的文件写权限。尚未存在覆盖所有 ACP 文件写入的服务层 allowlist，因此不能把 Portal 的只读协议误写成完整的 Agent 文件系统沙箱。涉及 Workspace 资产替换仍必须遵守用户所有权、逐文件确认与备份红线。

## 权威实现与验证

代码入口：

- `src/lib/sandbox-context.ts`
- `src/lib/sandbox-confirmation.ts`
- `src/lib/sandbox-audit.ts`
- `src/routes/sandbox.ts`
- `src/mcp/service-tools-core.ts`

最小验证以 `package.json` 中现行脚本为准；涉及 sandbox 或 MCP 变更时至少运行：

```bash
npm run check:agent-context
npm run verify
```
