# 36 — 状态冻结分支 Acceptance Review（2026-06-12）

## Acceptance Verdict

Status: Pass with caveats

`codex/invest-agent-state-freeze` 已把原本大范围未提交改动拆成 8 个主题提交，并满足本阶段“工程冻结、可审计分组、自动化体检、合并前 review”的核心目标。TypeScript 编译、通用 smoke、客户输出边界、sandbox token、Hermes 服务 smoke、Platform projects/tools API 均通过。未发现阻塞合并的高风险缺陷。保留 caveat：真实微信链路尚未人工验收，历史 push queue 中仍有 `dead=19`，以及单个中间提交不保证各自独立可编译，最终分支整体可编译。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 提交整理 | 将大工作区拆为可 review 的主题提交 | Pass | `git log --oneline` 显示 8 个主题提交 | 主题覆盖 docs、skills、ACP、sandbox、platform、weixin/push、persistence、invest workflows |
| 文档冻结 | 新增工程状态冻结记录并挂到索引 | Pass | `docs/35-current-state-freeze-2026-06-12.md`, `docs/README.md` | 包含验收结果、风险、提交分组和后续真实验收项 |
| Skills 资产 | 投资/饮食推荐 skills 与 skill bundle 落地 | Pass | `.codex/skills/*/SKILL.md`, `src/platform/skill-bundles.ts` | 12 个 skill，覆盖复盘、选股、风险、技术、服务工具、饮食推荐 |
| ACP 主链路 | 移除旧 runtime/router，新增 Codex/Hermes ACP 托管与 trace | Pass | `src/acp/*`, 删除 `src/agent/*`, 删除 `src/router/*` | 客户输出经 `sanitizeCustomerText`，trace 写入前 redaction |
| Sandbox 身份 | 用户态 API 从 token 上下文取 scope，不信任请求体 userId | Pass | `src/routes/sandbox.ts`, `src/lib/sandbox-context.ts` | 主要读写路径均使用 `ctx.userId + ctx.instanceId` |
| Sandbox 权限 | Tool registry 限制 project type allowedTools 和 permissions | Pass | `src/platform/tool-registry.ts` | 非投资项目无法调用投资工具；缺权限返回 403 |
| 危险操作确认 | 删除/关闭类操作需要 pending confirmation | Pass | `src/routes/sandbox.ts`, `src/lib/sandbox-confirmation.ts` | 自选删除、预案删除、提醒关闭/删除均走 confirmation |
| 审计 | Sandbox 写操作写入审计 | Pass | `src/lib/sandbox-audit.ts`, `src/routes/sandbox.ts` | 关键写入路径记录 operation/resource/status |
| Platform registry | AI Project registry、project type、platform API/UI 落地 | Pass | `src/platform/project-registry.ts`, `src/platform/project-types.ts`, `src/routes/platform.ts`, `src/admin/platform-page.ts` | `GET /api/platform/projects` 返回 5 个项目 |
| 微信/Hermes 运行链路 | 项目微信绑定、Hermes service smoke、push queue 落地 | Pass | `src/channels/weixin-mobile.ts`, `src/services/push-queue.ts`, `scripts/hermes-service-smoke.mjs` | 服务健康；push queue 存在历史 dead job 待运维处理 |
| DB 兼容 | 新表、旧表增量列、索引、历史 scope 回填 | Pass | `src/db/index.ts`, `src/db/schema.ts` | `initDb()` 创建并迁移 users/projects/instances/traces/audit/push 等表 |
| 投资业务闭环 | Dashboard、复盘、提醒、预案、指标和行情增强 | Pass | `src/admin/dashboard-page.ts`, `src/handlers/*`, `src/scheduler/*`, `src/services/*` | smoke 通过；真实微信体验待人工验收 |
| 客户输出边界 | 不泄露 localhost、端口、API、token、内部组件等 | Pass | `npm run smoke:customer-output` -> `ok=true,cases=4` | smoke 覆盖 4 类内部泄露样例 |
| 自动化验证 | build/smoke/API 快查通过 | Pass | Commands listed below | 所有自动化检查通过 |
| 工作区状态 | review 前工作区干净 | Pass | `git status --short --branch` | 分支 `codex/invest-agent-state-freeze` 干净 |

## Findings

- [Low] 历史 push queue 存在 dead job：`npm run smoke:hermes-service` 与 `/api/platform/projects` 显示 `dead=19`。这不阻塞代码合并，但下一轮真实验收需要复核失败原因、是否可重试或清理。
- [Low] 真实微信链路尚未人工验证：自动化覆盖了服务健康、API、smoke 和客户输出边界，但 `docs/28-hermes-project-weixin-acceptance-checklist.md` 中的真实微信普通问答、日复盘异步推送、观点回测、选股转自选仍需人工或半自动验收。
- [Low] 中间提交不声明逐个独立可编译：拆分按逻辑边界完成，最终分支整体通过 `npm run build`。若后续需要 bisect 每个提交，可能需要额外校验每个提交点。
- [Low] Diet 项目的 sandbox `/api/sandbox/me` 目前也走 `invest.dashboard.read` tool gate，非投资项目会被拒绝。这符合“非投资项目不能调用投资工具”的安全取向，但后续若饮食项目需要通用 `/me`，应新增 generic tool 或独立 route。

## Verification Performed

- `npm run build`: pass.
- `npm run smoke`: pass, `Experimental MVP smoke test passed`.
- `npm run smoke:customer-output`: pass, `ok=true`, `cases=4`.
- `node scripts/sandbox-token-smoke.mjs`: pass.
- `npm run smoke:hermes-service`: pass, `status=ok`, `codexReady=true`, `hermesReady=true`.
- `GET http://localhost:22649/api/platform/projects`: pass, `count=5`, project ids include `invest-agent-primary`, `invest-agent-mg`, `diet-recommendation-shared`.
- `GET http://localhost:22649/api/platform/tools`: pass, `count=15`.
- Static code inspection: sandbox scope checks, confirmation checks, trace redaction, DB init/migration, server route registration.
- Secret scan: no hardcoded sandbox secret or real Bearer token found in staged/final source; sample tokens only appear in smoke test literals and docs.

## Follow-Up Checklist

- [ ] Run the real WeChat checklist in `docs/28-hermes-project-weixin-acceptance-checklist.md`.
- [ ] Review and resolve/clear historical `deadPush=19` queue entries.
- [ ] Decide whether diet/shared project needs a generic `/api/sandbox/me` endpoint or generic tool id.
- [ ] If strict bisectability is required, verify `npm run build` at each of the 8 topic commits.
