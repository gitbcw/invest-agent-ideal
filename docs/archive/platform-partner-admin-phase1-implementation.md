# Platform 合伙人后台 Phase 1 实施记录

## 范围

本阶段只实现服务层账号、角色、session、登录限流、服务端权限检查和审计，以及 Partner 脱敏聚合 API。没有重写 Platform 页面，没有部署火山云，也没有改变微信、scheduler、MCP 或用户 Portal 主链路。

## 数据变更

新增 6 张 service-owned SQLite 表：

- platform_users：后台账号、密码哈希、锁定和首次改密状态。
- platform_roles：Owner/Partner 预设权限。
- platform_user_roles：账号与角色绑定。
- platform_sessions：可撤销、过期的后台 session。
- platform_login_events：成功/失败登录事件。
- platform_admin_audit_logs：授权访问、拒绝访问、改密、退出和高风险路由审计。

迁移由 src/db/index.ts 的 canonical initDb 路径以 CREATE TABLE IF NOT EXISTS 和唯一索引完成，并写入 schema_migrations.platform_auth_v1。没有回写、删除或迁移现有投资数据。

开发环境首次启动会从 PLATFORM_BOOTSTRAP_PASSWORD 或受限文件生成 Owner；生产环境没有显式密码时不自动创建账号。密码使用 scrypt 哈希，数据库不保存明文。

## 服务端授权

src/routes/platform.ts 的 preHandler 对所有 /api/platform/* 路由执行：

- 登录接口公开，但按来源 IP 限流。
- 其他接口必须有后台账号 session、旧本机 session 或 service token。
- Partner 只允许 overview.read、customers.read、quality.read、operations.read。
- 旧实例、审计、成本、规则、投资状态、微信和写接口均由服务端拒绝 Partner，返回 403。
- 首次登录账号在访问业务 API 前必须先完成改密；改密失败和门槛拒绝也写入审计。
- 每次授权和拒绝访问都写入 platform_admin_audit_logs；日志不保存密码、token、二维码或原始对话正文。

## Partner API

新增：

- GET /api/platform/partner/overview
- GET /api/platform/partner/customers
- GET /api/platform/partner/customers/:customerKey/operations
- GET /api/platform/partner/quality
- GET /api/platform/partner/runtime-health

这些接口由服务端重新构造 allowlist response，不透传旧 Owner 对象。customerKey 使用 HMAC 脱敏；轮换期间支持 active/previous secret 读取旧 key，启动时检测截断碰撞并拒绝启动。Partner 不收到 userId、instanceId、Workspace 路径、原始对话、持仓、策略、规则条件、微信 session/二维码、token 或 cost。

## 验证证据

- npm run smoke:platform-partner-auth
  - 未登录 Partner API：401。
  - Partner overview/customers：200。
  - Partner 访问审计、实例、投资状态、创建实例、source-quality：403。
  - Owner 访问审计：200。
  - Owner 首次登录未改密：428；改密后访问审计：200。
  - 修改 query/userId 不扩大 Partner 数据范围。
  - 授权和拒绝事件均落入管理员审计表。
  - 退出后 session：401。
- npm run smoke:platform-partner-migration
  - fresh DB 创建 6 张表。
  - platform_auth_v1 只写一次。
  - Owner/Partner 角色和 Owner bootstrap 幂等。
  - rollback：PLATFORM_AUTH_ENABLED=false 会返回新 auth/Partner API 404，同时旧 service-token Platform API 仍可用；新增表可闲置。
- npm run smoke:security-boundary
  - 既有 service-token、本机 legacy session、远程未授权和旧 Platform 边界保持通过。
- npm run smoke:route-uniqueness
  - 路由无重复，旧路由集合未被破坏。

## Phase 2 页面补充（本地）

在 Phase 1 的服务层能力之上，已增加 `src/admin/partner-platform-page.ts` 并接入 `/platform`：

- 未登录远程访问返回 HTTP 401，同时返回不含业务数据的账号密码登录壳；远程页面不再要求旧的 loopback session。
- Partner 登录后只返回经营总览、客户与助手、产品质量、运行与触达四个只读视图，页面只调用 `/api/platform/partner/*`。
- 任何首次登录且需要改密的后台账号（包括 Owner）先进入改密壳；完成改密后 Owner 才返回原有运维页，Partner 才返回经营看板。
- Partner 页面不包含成本、原始对话、持仓/成本、规则条件、微信凭据或管理操作入口；客户详情只显示服务端 allowlist 的运营摘要。
- Owner 账号仍返回原有本机运维页；loopback 无账号访问保留旧 Owner 回退兼容。Partner 无法通过页面或 URL 切换到该页面。
- 退出登录会撤销持久 session；API 继续由服务端 RBAC 保护，页面隐藏不等于权限控制。

公网入口仍按产品决策使用火山云服务器固定公网 IP 的 `22646`（HTTP、不配置域名/HTTPS）；本次只修改本地代码和页面，不启动或部署火山云 listener，也不改 runtime `22655`。

## 当前未完成项

- `22646` 独立 listener/反代尚未部署；现有 runtime 仍默认监听 127.0.0.1:22655。按当前决策，后续公网入口使用固定 IP + HTTP，不配置域名或 HTTPS。
- 本地真实浏览器登录、Partner 四个视图和敏感入口检查已完成；尚未进行 `22646` 公网入口穿透测试，因为本轮明确不部署火山云冻结版本。
- 本机 loopback 的旧 /platform 页面仍保留 legacy session 回退；远程未授权页面返回 401 并仅返回登录壳，业务 API 仍不放行。
