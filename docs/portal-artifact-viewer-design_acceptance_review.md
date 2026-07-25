# Portal Artifact Viewer 验收记录

> 验收依据：`docs/portal-artifact-viewer-design.md`

## 2026-07-24 / Initial Review

状态：待执行完成后验收。
## 2026-07-24 / Attempt 1 Acceptance Verdict

Status: Partial

第一轮建立了一部分受控 artifact 读取基础，并通过两个项目的 TypeScript 校验；但计划要求的网页门户卡片与可折叠/可关闭右侧 Viewer 尚未实现，安全验证和遥测也没有证据，不能验收。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Artifact metadata | 结构化 descriptor 与 SQLite 映射 | Partial | `src/services/conversation-artifacts.ts`, `src/db/index.ts` | 已有表、ID、descriptor 和读写路径；尚未验证消息绑定并发语义。 |
| Secure read | scope、相对路径和符号链接保护 | Partial | `conversation-artifacts.ts` | 代码存在，但没有 artifact 专项负向测试；MIME/内容真实性检查缺失。 |
| Portal card | 助手消息显示结构化 artifact 卡片 | Fail | `invest-agent-portal/src/components/chat/MessageBubble.tsx` | 只渲染普通 attachments。 |
| Right Viewer | 右栏预览、折叠保留、关闭清空 | Fail | `ChatShell.tsx` | 没有 selected artifact 或 Viewer 组件。 |
| Preview modes | Markdown/SVG/image/PDF/text/JSON/CSV | Fail | Portal `src/` 搜索 | 无 artifact preview 实现。 |
| Legacy links | 旧绝对路径进入同一 Viewer | Fail | `MarkdownLite.tsx` 仅保留旧 reports URL 重写 | 未接入 artifact 发布和 Viewer。 |
| SVG/HTML isolation | 不能同源执行 | Fail | `src/app/api/reports/[...path]/route.ts` | 仍以 `inline` 提供 SVG；没有 sandbox/CSP Viewer。 |
| Audit telemetry | open/success/fail/download | Fail | artifact 相关代码搜索 | 未发现实现。 |
| Automated coverage | 安全负向和真实样本 | Fail | `tests/` | 只有旧 `workspace-report-assets` 测试。 |

## Verification Performed

- `invest-agent-ideal`: `npm run typecheck` passed.
- `invest-agent-portal`: `npm run typecheck` passed.
- 静态审查 Runtime、connector、Portal Chat 组件和 reports route。

## Findings

- [P0] Phase 1 的用户可见交互缺失：没有 artifact 卡片、Viewer、折叠/关闭语义或预览状态。
- [P0] 同源 SVG 仍由 legacy reports route 以 inline 返回，尚未消除计划明确指出的脚本执行风险。
- [P1] artifact MIME 仅由扩展名推断，未验证 PNG/JPEG/WebP/PDF 的 magic bytes 或文本格式内容；未覆盖伪造 MIME。
- [P1] 缺少 artifact 专项的跨用户、路径、symlink、恶意 SVG/HTML、超限、checksum 和旧链接兼容测试。
- [P1] 缺少预览打开/成功/失败/下载轻量审计。

## 2026-07-24 / Attempt 2 Acceptance Verdict

Status: Partial

Portal 的卡片、右侧 Viewer、格式预览、legacy 入口与状态展示已经实现；Runtime 安全测试和两个项目的构建均通过。但折叠状态、SVG checksum 和并发消息绑定仍与验收标准冲突，需最后一轮修复。

## Changed Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Portal card | 助手消息结构化 artifact 卡片 | Pass | `ArtifactCard.tsx`, `MessageBubble.tsx`, `types.ts` | metadata descriptor 已接入。 |
| Right Viewer | 右栏打开、关闭和折叠 | Partial | `ChatShell.tsx`, `ArtifactViewer.tsx` | 关闭正确清空；折叠直接卸载 Viewer，保存的是聊天滚动位置，预览位置和已加载状态丢失。 |
| Preview modes | Markdown/SVG/image/PDF/text/JSON/CSV | Pass | `ArtifactViewer.tsx` | 构建通过，待浏览器实测。 |
| Legacy links | 旧绝对路径进入 Viewer | Pass | `MarkdownLite.tsx`, legacy API | 已拦截 legacy reports 链接并发布 descriptor。 |
| SVG/HTML isolation | 不通过同源 inline 路径执行 | Pass | reports route, artifact blob image | legacy route 已改为 attachment；Viewer 使用校验后的 Blob image。 |
| Security tests | scope、路径、symlink、恶意 SVG、超限、MIME、checksum | Pass | `tests/conversation-artifacts.test.ts` | 17/17 通过。 |
| Download integrity | 下载内容与 workspace checksum 一致 | Fail | `sanitizeSvgForInline()` + Viewer checksum | sanitizer 对所有安全 SVG 执行 `trim()`，含换行的真实 SVG payload 与原文件 checksum 不一致。 |
| Turn association | artifact 绑定正确助手回合 | Fail | `attachArtifactsToAssistantMessage()` | 仍查询并绑定同一会话所有 `message_id IS NULL` 的 artifact，并发请求可串绑。 |
| Unsupported/too-large fallback | 稳定状态且可下载 | Partial | `ArtifactViewer.tsx` | 状态存在，但非 ready 时下载按钮禁用，超限/unsupported 没有下载降级。 |
| Audit telemetry | open/success/fail/download | Pass | `conversation_artifact_events`, artifact event route | 事件已入 Runtime SQLite；存在客户端与 connector 重复 open/success 计数的次要问题。 |

## Attempt 2 Verification

- Runtime: typecheck passed; artifact tests 17/17 passed; build passed.
- Portal: typecheck passed; Next production build passed, including three artifact API routes.
- 静态审查发现上述三个阻断项；尚未执行浏览器交互验收。

## 2026-07-24 / Attempt 3 Acceptance Verdict

Status: Partial

网页门户的卡片、Viewer、关闭/折叠语义、legacy 入口、格式策略、下载完整性、安全读取和轻量审计均已完成并有构建、专项测试和浏览器证据。不可接受的剩余风险是同一会话重叠请求时的 artifact turn 归属：当前实现把 active turn 存成单行，不能满足计划要求的确定性并发关联。因此不应部署或宣称 Phase 0/1 已完全验收。

## Final Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Artifact cards | 助手消息中的一等对象 | Pass | `ArtifactCard.tsx`, `MessageBubble.tsx`; local browser test | 测试消息显示 SVG 图表卡片。 |
| Viewer interaction | 右侧打开、关闭、折叠/展开 | Pass | `ChatShell.tsx`, `ArtifactViewer.tsx`; local browser test | 折叠保持挂载，展开保持加载状态；关闭清除面板。 |
| Preview modes | Markdown/SVG/image/PDF/text/JSON/CSV | Pass | `ArtifactViewer.tsx`; Runtime format tests | mock 不实现 `artifact.get`，真实 connector 渲染仍需一次终验。 |
| Download integrity | checksum 与 workspace 一致 | Pass | `tests/conversation-artifacts.test.ts` cases 2-3 | 安全 SVG 保留原始 bytes；20 项专项测试全过。 |
| Scope and hostile input | 跨用户、路径、symlink、MIME、SVG、超限 | Pass | Runtime artifact tests | 所有负向样本通过。 |
| Legacy compatibility | 旧绝对路径进入同一 Viewer | Pass | `MarkdownLite.tsx`, legacy artifact route | legacy reports route 已改 download-only。 |
| Telemetry | open/success/fail/download，受 scope 保护 | Pass | connector/event route/events table | 去除了 connector 与客户端的成功事件重复计数。 |
| Concurrent turn binding | 重叠请求不串绑 artifact | Fail | `conversation-turns.ts`, `conversation-log.ts` | 单行 active-turn 表被同会话后续请求覆盖；当前测试顺序执行，未覆盖真实重叠窗口。 |

## Final Verification

- Runtime: `npm run typecheck`, `node --import tsx --test tests/conversation-artifacts.test.ts` (20/20), `npm run build` passed.
- Portal: `npm run typecheck`, `npm run build` passed.
- Browser: isolated local Portal on ports 3101/3200 with test SQLite and mock connector. Card appeared; Viewer opened; collapse/reopen preserved mounted state; close removed the Viewer. No production data or production connector used.

## Required Follow-Up

- [ ] Replace the single-row active-turn registry with request-scoped propagation into the ACP/MCP process, or serialize same-conversation request execution before setting an active marker. Add a truly overlapping regression test that forces turn B to start while turn A publishes.
- [x] With a real local connector and a copied mg fixture, exercise actual Markdown/SVG Viewer rendering and download; PDF/text/JSON/CSV remain covered by automated format tests per the agreed Phase 0/1 evidence scope (completed in Attempt 4).

## 2026-07-24 / Attempt 4 Acceptance Verdict

Status: Pass for the agreed Phase 0/1 desktop web scope. Not deployed.

同会话 ACP 请求现在在 `conversation-log.ts` 中串行执行，artifact 不再依赖会被覆盖的并发 active-turn marker。专项测试已覆盖该修复并达到 21/21。当前范围只包含桌面网页门户的受控文件预览，不包含移动端适配、Office 转换、在线编辑、文件树或云端永久镜像。

## Final Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Artifact cards | 助手消息中的一等对象 | Pass | `ArtifactCard.tsx`, `MessageBubble.tsx`; real connector browser test | SVG 图表卡片在真实 connector 载入的 fixture 会话中出现。 |
| Viewer interaction | 右侧打开、关闭、折叠/展开 | Pass | `ChatShell.tsx`, `ArtifactViewer.tsx`; browser test | 折叠保留同一 Blob URL 和已加载图片；关闭移除 Viewer 并清空选择。 |
| Preview modes | Markdown/SVG/image/PDF/text/JSON/CSV | Pass | `ArtifactViewer.tsx`; 21/21 Runtime tests; real connector browser test | mg SVG 与月度指标 Markdown 已通过真实 connector 终验；其他类型由格式测试覆盖。 |
| Download integrity | checksum 与 workspace 一致 | Pass | `tests/conversation-artifacts.test.ts`; isolated Runtime audit | SVG 原始 bytes 与 checksum 一致；下载入口记录 `download`。 |
| Scope and hostile input | 跨用户、路径、symlink、MIME、SVG、超限 | Pass | `tests/conversation-artifacts.test.ts` | 21 项专项测试通过。 |
| Legacy compatibility | 旧绝对路径进入同一 Viewer | Pass | `MarkdownLite.tsx`, legacy artifact route | reports route 保持 download-only。 |
| Telemetry | open/success/fail/download，受 scope 保护 | Pass | event route, Runtime SQLite | 当前源码重启后的单次点击产生 `open=1`、`success=1`；折叠/展开不产生新事件。 |
| Concurrent turn binding | 重叠请求不串绑 artifact | Pass | `conversation-log.ts`; 21/21 tests | 同一会话 ACP 执行已串行化。 |
| Connector offline | 历史可看、预览失败可理解且可重试 | Pass | isolated real connector browser test | 停止 connector 后，消息和卡片保留；Viewer 显示明确离线原因及“重试”。 |

## Final Verification

- Runtime: `npm run typecheck`, `node --import tsx --test tests/conversation-artifacts.test.ts` (21/21), `npm run build` passed.
- Portal: `npm run typecheck`, `npm run build` passed.
- Browser: isolated Portal at `http://127.0.0.1:3102/chat`, relay `3202`, real local connector and copied mg fixture. The SVG loaded through a blob URL with natural dimensions 300 x 133; the mg monthly-metrics Markdown rendered its headings and lists. One click yielded exactly one `open` and one `success` audit event; collapse/reopen retained the same blob URL; close removed the Viewer. After the connector was stopped, cached history remained visible and the Viewer showed a retryable offline state.

Residual risk: PDF, plain text, JSON and CSV have automated format coverage but were not all exercised through the browser in this final pass. The explicitly required mg SVG and Markdown fixtures were exercised through the real connector. This is not a production deployment or production-data validation.
