## Acceptance Verdict

Status: Pass with caveats

当前沙箱隔离的核心目标已经达成：token scope、实例级数据边界、审计与确认机制都已落地，且构建与测试通过。现阶段仍是服务内权限隔离，不是容器/VM 级硬隔离；另外文档中提到的 `/api/sandbox/dashboard` 路由与实现未完全对齐。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 身份隔离 | sandbox 请求不信任裸 `userId`，只认签名 token | Pass | `src/lib/sandbox-context.ts`，`curl -H 'Authorization: Bearer INVALID.TOKEN' /api/sandbox/me` 返回 `sandbox token invalid or expired` | token 校验生效 |
| 实例隔离 | 各实例按 `userId + instanceId` 分开 | Pass | `src/lib/workspace.ts`，`src/routes/platform.ts`，`/api/platform/instances` 返回 `invest-agent-primary` 与 `invest-agent-user-test-2` 分离 | 平台实例 backend 已分开 |
| 沙箱权限 | 只允许白名单工具与权限组合 | Pass | `src/platform/tool-registry.ts`，`src/routes/sandbox.ts` | `assertSandboxToolAllowed()` 统一拦截 |
| 审计/确认 | 写操作审计、删除类操作需确认 | Pass | `sandbox_audit_logs`、`pending_sandbox_confirmations` 表存在；`src/routes/sandbox.ts` 中 `requireConfirmation()` | 审计表已启用 |
| 工作区边界 | 工作区按用户独立，读写通过 `resolveWorkspacePath(userId)` | Pass | `src/lib/workspace.ts`，`src/lib/workspace-store.ts` | 逻辑上不会默认串到别的用户目录 |
| 运行验证 | 构建与测试通过 | Pass | `npm run build` 通过；`npm test -- --runInBand` 通过 | 当前代码可编译、测试稳定 |
| 文档对齐 | 文档与实现一致 | Partial | `docs/23-multi-user-sandbox-design.md` 提到 `/api/sandbox/dashboard`，但当前实现未见该 POST 路由 | 属于文档/实现未对齐 |
| 隔离强度 | 容器/VM 级硬隔离 | N/A | 用户明确表示不需要这一级别 | 当前目标不要求 |

## Findings

- [Medium] 文档与实现有一处偏差：`/api/sandbox/dashboard` 在设计文档里是首批能力，但当前 `src/routes/sandbox.ts` 没有对应 POST 路由。影响是后续验收/交接时容易误判“已实现”。
- [Low] 这是应用级隔离，不是容器/VM 级隔离。若服务代码自身出现参数串用，仍需靠代码审查与回归测试兜底。

## Verification Performed

- `npm run build` -> 通过
- `npm test -- --runInBand` -> 通过
- `curl -H 'Authorization: Bearer INVALID.TOKEN' http://localhost:22655/api/sandbox/me` -> 返回 401 级别错误
- `curl http://localhost:22655/api/platform/instances/invest-agent-user-test-2/weixin/status` -> 返回 `backend=codex`、`pushReady=true`
- `curl http://localhost:22655/health` -> `activeAcpBackend.id = codex`
- 读取 `sandbox_audit_logs` 与 `pending_sandbox_confirmations` 表存在性

## Follow-Up Checklist

- [ ] 补齐或删除文档中的 `/api/sandbox/dashboard` 描述，避免后续验收误读
- [ ] 若后续需要更硬隔离，再评估容器/进程级方案
