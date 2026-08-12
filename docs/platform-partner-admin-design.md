# Platform Owner / Partner 当前契约

本文件描述已实现的 Platform 账号、RBAC、Partner 聚合面和当前部署边界。历史产品设计与实施记录见：

- [`archive/platform-partner-admin-design-pre-consolidation-2026-07-28.md`](./archive/platform-partner-admin-design-pre-consolidation-2026-07-28.md)
- [`archive/platform-partner-admin-phase1-implementation.md`](./archive/platform-partner-admin-phase1-implementation.md)

## 角色与权限

当前有两个后台角色：

| 角色 | 权限 |
| --- | --- |
| `owner` | `*`，保留既有实例、审计、成本、微信和运维能力 |
| `partner` | `overview.read`、`customers.read`、`quality.read`、`operations.read` |

Partner 只允许访问服务端重新构造的脱敏聚合 API。页面隐藏不是授权机制；`src/routes/platform.ts` 的 `preHandler` 对所有 `/api/platform/*` 请求执行鉴权、权限映射与审计。

Partner 不得获得 userId、instanceId、Workspace 路径、原始对话、持仓与成本、策略正文、规则条件、微信 session/二维码、token 或成本明细。客户标识使用 HMAC 派生的 `customerKey`，支持 active/previous secret 轮换读取并检测碰撞。

## 账号与 session

服务层拥有以下 SQLite 表：

- `platform_users`
- `platform_roles`
- `platform_user_roles`
- `platform_sessions`
- `platform_login_events`
- `platform_admin_audit_logs`

密码使用 scrypt 哈希，不保存明文。持久 session 默认 8 小时，可撤销；账号首次登录必须改密，未改密访问业务 API 返回 `428`。登录按来源 IP 限流，失败、拒绝、改密、退出和授权访问均写审计。

生产环境必须显式提供 bootstrap 密码；非生产环境可生成到权限受限的密码文件，日志不打印明文。相关配置：

- `PLATFORM_BOOTSTRAP_USERNAME`
- `PLATFORM_BOOTSTRAP_PASSWORD`
- `PLATFORM_BOOTSTRAP_PASSWORD_FILE`
- `PLATFORM_ANONYMIZATION_SECRET`
- `PLATFORM_ANONYMIZATION_PREVIOUS_SECRET`
- `PLATFORM_AUTH_ENABLED`

`PLATFORM_AUTH_ENABLED=false` 会关闭新 auth 与 Partner API 表面；旧 service-token Platform API 保持兼容。legacy loopback session 仍是本机兼容入口，不应被当成公网账号方案。

## 当前 API

账号 API：

- `POST /api/platform/auth/login`
- `GET /api/platform/auth/me`
- `POST /api/platform/auth/password`
- `POST /api/platform/auth/logout`

Partner API：

- `GET /api/platform/partner/overview`
- `GET /api/platform/partner/customers`
- `GET /api/platform/partner/customers/:customerKey/operations`
- `GET /api/platform/partner/quality`
- `GET /api/platform/partner/runtime-health`

Owner 审计 API：

- `GET /api/platform/automation-runs`：按用户、助手、任务、状态和来源查看自动化运行历史，返回失败分类、重试属性、交付状态及汇总计数；权限为 `admin_audit.read`。

所有 Partner response 使用 allowlist 构造，不能透传 Owner API 对象。Partner query 中伪造 userId 或 instanceId 不能扩大数据范围。

## 页面与部署边界

`/platform` 根据认证上下文返回：

- 未登录远程访问：401 和不含业务数据的登录壳；
- 首次登录：改密壳；
- Partner：四个只读经营视图，只调用 `/api/platform/partner/*`；
- Owner：既有运维页面；
- loopback legacy session：兼容 Owner 页面。

当前仓库实现了页面和服务端契约，但不能据此假设公网 listener、反向代理、TLS 或火山云入口已经部署。部署事实以运维 Skill 与生产验证为准。

## 权威实现与验证

- `src/lib/platform-auth.ts`
- `src/lib/platform-password.ts`
- `src/lib/platform-session.ts`
- `src/routes/platform.ts`
- `src/admin/partner-platform-page.ts`
- `src/db/schema.ts`
- `src/db/index.ts`

```bash
npm run smoke:platform-partner-auth
npm run smoke:platform-partner-migration
npm run verify
```
