# Portal Artifact Viewer 执行日志

> 主计划：`docs/portal-artifact-viewer-design.md`

## 2026-07-24 / Attempt 1

状态：第一轮执行未完成，进入独立验收与修复。

执行范围：Phase 0 + Phase 1；涉及 `invest-agent-ideal` runtime/connector 与相邻 `invest-agent-portal` 网页门户。保留两个仓库现有未提交改动，不部署生产，不扩展 Office、在线编辑、文件树、移动端或云端永久镜像。

Claude Code 执行约 15 分钟后卡在无关的 `npm exec @cloudbase/cloudbase-mcp@latest` 子进程，已中断，未返回总结。工作区保留了部分实现。

独立初检（Codex）：

- Runtime 已新增 `conversation_artifacts` 表、artifact 发布/读取服务、connector 协议命令及 SVG 清洗入口；`src/db/index.ts` 亦包含建表和索引初始化。
- Runtime 与 Portal 的 `npm run typecheck` 均通过。
- Portal 尚未出现 `ArtifactViewer`、artifact 卡片或右侧栏状态；`MessageBubble.tsx` 仍只渲染用户上传附件，`ChatShell.tsx` 未维护选中 artifact 状态，且没有 artifact 下载/读取 API 路由。因此 Phase 1 核心交互未完成。
- 尚未发现 artifact 专项测试；现有 `/api/reports/*` 仍可把 SVG 同源 `inline` 返回，未满足计划中的 SVG/HTML 隔离要求。
- 下一轮需修复上述缺口，并补齐 scope、路径穿越、符号链接、MIME/内容伪造、恶意 SVG/HTML、超限、checksum、旧路径兼容与审计的自动化/实测证据。

## 2026-07-24 / Attempt 2

状态：实现大部分功能，独立验收仍为 Partial。

执行器新增 Portal artifact API、卡片、右侧 Viewer、legacy 链接接入、预览事件审计；Runtime 增加 MIME magic 校验、artifact 事件表和 17 项专项测试。执行器未返回文字总结，但实际改动已检查。

验证结果：

- Runtime `npm run typecheck`、17 项 artifact 专项测试、`npm run build` 全部通过。
- Portal `npm run typecheck`、`npm run build` 全部通过。

剩余阻断：折叠会卸载 Viewer，未保留预览滚动位置；安全 SVG 被 `trim()` 后 payload 与 workspace checksum 不一致；消息关联仍把会话内全部 pending artifacts 绑定到下一条助手消息，存在并发串绑；unsupported/too-large 状态没有可用的下载路径。

## 2026-07-24 / Attempt 3

状态：三轮执行已达默认上限，最终独立验收为 Partial，不部署。

本轮完成：

- Viewer 保持挂载后折叠，保存并恢复预览自身的滚动位置；关闭清空选择。
- 安全 SVG 保留原始 bytes，checksum 与 workspace 文件一致；移除 TypeScript 源文件中的字面 NUL，并改为 ESM `createHash` import。
- 补充 preview 限制与下载限制分离、原地重试、artifact event 去重和 event scope 校验。
- Runtime artifact 专项测试扩展至 20 项，typecheck/build 通过；Portal typecheck/Next build 通过。
- 隔离本地 Portal 浏览器实测：结构化卡片出现，点击打开右栏，折叠后可展开并保持加载状态，关闭后清空预览。

最终未通过项：`conversation_turn_active` 以 `(user_id, instance_id, conversation_id)` 为唯一键，只保存一个 active turn。第二个同会话请求在 ACP 返回 `ACP_TURN_BUSY` 前仍会短暂覆盖第一个 turn 的 marker；第一个请求如果恰在该窗口内发布 artifact，就可能被标记到第二个 requestId。新增测试是先后执行的，未复现这个重叠窗口，不能证明并发安全。需要把 requestId 直接沿 ACP/MCP 进程上下文传入 `artifacts.publish` / `reviews.save`，或在调用 ACP 前按会话串行化，才能关闭此风险。

## 2026-07-24 / Attempt 4

状态：完成最终修复与隔离环境验收；未部署生产。

本轮完成：

- 在 `src/services/conversation-log.ts` 为同一会话增加 ACP 执行串行锁，消除 active-turn 被并发请求覆盖而串绑 artifact 的窗口；artifact 专项测试增至 21 项。
- 将 `open` 事件上报移动到用户点击 artifact 卡片的入口，移除 Viewer 挂载 effect 的 `open` 上报，避免 React 开发模式双挂载造成重复事件。
- 使用真实 Runtime connector、复制的 mg fixture 和隔离 SQLite 复验 SVG：卡片可打开右侧 Viewer；图片经 Blob URL 加载，尺寸为 300 x 133。
- 使用同一真实 connector 复验 mg 月度指标 Markdown：标题、二级章节和列表均由 Portal Viewer 正确渲染，不依赖本机文件工具。
- 验证折叠不会卸载 Viewer：展开后仍是同一 Blob URL、已加载图片仍可用；关闭会清空 Viewer，但保留消息中的 artifact 卡片。
- 重启隔离 Portal 到当前源码后，一次卡片点击只写入 1 条 `open` 和 1 条 `success`；随后折叠/展开没有新增审计事件。下载操作已在同一隔离 Runtime 中留下 `download` 事件。
- 停止 connector 后再次打开 Markdown artifact，历史消息与卡片仍可查看，Viewer 稳定显示“助手暂时离线”并提供原地“重试”动作。

本轮验证：Runtime `npm run typecheck`、`node --import tsx --test tests/conversation-artifacts.test.ts`（21/21）及 `npm run build` 通过；Portal `npm run typecheck` 与 `npm run build` 通过。隔离实例使用 `127.0.0.1:3102` / `3202`、临时 SQLite 和 fixture workspace，不读取或修改生产数据。
