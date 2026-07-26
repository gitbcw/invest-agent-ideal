# Portal 对话内图片与侧栏预览调整工作包

> 状态：已完成（用户生产目视确认通过）
> 日期：2026-07-25
>
> 执行记录（2026-07-25）：
> - 提交：Portal `aec7ce0`（基线 `971415c`）、Runtime `677a05e`（基线 `f0011d2`），均在各自 release worktree。
> - 本地验收：A1–A13 在 1440x900 / 1920x1080 全部 Pass，证据 `/private/tmp/portal-inline-media-acceptance/ACCEPTANCE-REPORT.md`（30 张截图 + 量测数据）。
> - 独立安全审查：可提交；低风险 R1（HTML iframe 自导航）已加 CSP `navigate-to 'none'` 加固复验。
> - 部署：Runtime 与 Portal 均经普通代码发布路径部署火山云；`invest-agent`(↺19) 与 `invest-agent-portal`(↺26) 在线；111/dyk/mg connector 重启后重新注册；`/login` 200；生产 `.env`/SQLite/reviews/`.state` mtime 均早于发布未触碰；未发送微信消息。
> - 待办：用户手动在生产 Portal 确认真实 SVG artifact 内联展示与大图（唯一剩余项）。
> - 收尾（2026-07-25）：用户确认生产目视正常；应用户要求补齐大图层图片下载（Portal `fd65d18`，复用已校验 Blob 零额外请求），已部署并验证入口/connector/新 chunk 在线。
> 面向角色：目标模式执行 Agent、独立验收 Agent
> 生产目标：火山云网页 Portal（桌面端）

## 1. 目标模式任务定义

### Objective

完成 Portal 产物查看交互的第二轮收敛，并部署到火山云：

1. 打开文档侧栏时，当前对话区和产物侧栏在可用主区域内接近 1:1。
2. Markdown 和安全 HTML 使用可折叠的右侧栏预览。
3. SVG、PNG、JPEG、WebP 等图片直接显示在助手消息中，不进入右侧栏；点击后使用独立大图层查看。
4. 新产生的 AI 回复能够通过一等 artifact 数据在对话中携带 SVG；旧式 `reports/*.svg` 链接仍可点击并进入大图查看。
5. 通过本地验证、桌面浏览器验收后，仅以代码发布方式部署到火山云，保留全部生产数据和运行资产。

### Completion Definition

只有同时满足以下条件，目标才可标记为完成：

- 本文第 8 节全部必验项通过。
- Portal 与 Runtime 的相关类型检查、测试和生产构建通过。
- 火山云 Portal、Runtime 和三个生产 connector 均在线。
- 生产 Portal 已加载新前端，真实 SVG artifact 可以在消息中展示并打开大图。
- 没有覆盖生产 `.env`、SQLite、Workspace、reviews、`.state` 或微信状态。
- 没有向真实微信发送测试消息。

## 2. 用户意图与交互边界

本任务只覆盖桌面网页 Portal，不做手机或平板适配。

用户要求的展示路由如下：

| 产物类型 | 消息中的表现 | 点击后的表现 | 是否使用侧栏 |
| --- | --- | --- | --- |
| Markdown | 产物卡片 | 在右侧栏预览 | 是 |
| HTML | 产物卡片 | 在受限 sandbox 右侧栏预览 | 是 |
| SVG | 对话内图片 | 全屏/大尺寸图片查看层 | 否 |
| PNG/JPEG/WebP | 对话内图片 | 全屏/大尺寸图片查看层 | 否 |
| 其他类型 | 保留现有卡片和明确降级 | 下载或“不支持预览”状态 | 不扩展新预览器 |

这里的“侧栏支持 Markdown 以及 HTML”表示侧栏主要承载长文档，而不是继续承载图片。图片查看层与侧栏是两个独立状态，不得复用侧栏模拟大图。

## 3. 当前基线与已知事实

### Runtime 仓库

- 路径：`/Users/combo/MyFile/projects/invest-agent-ideal`
- 当前分支：`main`
- 当前基线提交：`b6f6f4b`
- 当前工作树包含大量与 artifact/runtime 收敛有关的未提交变更及用户已有变更。执行 Agent 必须先逐项辨认，禁止清理、回退或整体覆盖。
- 已有一等 artifact 能力：
  - `artifacts.publish`
  - `conversation_artifacts`
  - `assistant message.metadata.artifacts`
  - `artifact.get` / legacy publish / artifact event
  - SVG 清洗、scope、checksum、路径和大小校验
- `image/svg+xml` 当前映射到 `previewMode: "image"`。
- 当前协议的 `ArtifactPreviewMode` 尚无 `html`。

### Portal 仓库

- 当前发布工作树：`/private/tmp/invest-agent-artifact-release-portal`
- 当前分支：`codex/artifact-viewer-portal-release`
- 当前基线提交：`971415c fix: verify artifacts without Web Crypto`
- 该工作树在本工作包编写前无未提交产品代码改动。
- 已部署能力：artifact 卡片、右侧 Viewer、折叠/关闭、legacy 路径发布、checksum 校验、HTTP 环境纯 JS SHA-256 fallback。
- 当前问题：
  - 侧栏固定为 `480px`，`xl` 为 `560px`，宽屏下明显小于对话区。
  - 所有 `previewMode: "image"` 都被送入 `ArtifactViewer` 侧栏。
  - `ArtifactViewer` 内的图片不能进入独立大图层。
  - 助手消息中的 artifact 只渲染为 `ArtifactCard`，没有对话内图片。
  - legacy SVG 链接点击后也进入侧栏。
  - Portal 协议的 `ArtifactPreviewMode` 尚无 `html`。

### 生产环境

- Portal 公网入口：`http://118.145.115.197:22649`
- Portal 进程：`invest-agent-portal`
- Runtime 进程：`invest-agent`
- 生产 connector：`invest-agent-111`、`invest-agent-dyk`、`invest-agent-mg`
- HTTPS 临时域名方案已因火山云未备案域名拦截而放弃；本任务不得重新引入 HTTPS 切流。
- 当前 HTTP Portal 依赖 `@noble/hashes` fallback 完成 checksum 校验，必须保留。

## 4. 设计方案

### 4.1 主区域 1:1 布局

会话历史栏不参与 1:1 计算。除去左侧会话历史后，右侧主区域按以下方式分配：

- 没有文档侧栏或侧栏折叠：对话区占满剩余空间。
- 文档侧栏展开：对话区与侧栏各占剩余空间约 50%。
- 两列都必须设置 `min-width: 0`，避免长文本撑破布局。
- 建议使用同一个 flex/grid 容器的 `flex: 1 1 0` 或 `grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)`，不要继续使用固定像素宽度。
- 左侧会话历史栏折叠与文档侧栏折叠互不影响。
- 保留当前文档侧栏“折叠保留选择与滚动位置、关闭清除选择”的语义。
- 文档侧栏展开时，右上角的折叠控制必须是可见文字按钮 `收起`，不得继续使用 `›`、小角标或仅图标表达折叠；侧栏收起后的恢复入口使用可见文字 `展开`。`收起` 与独立的关闭按钮必须同时保留，语义不可合并。
- 本任务不加入拖拽调宽和宽度记忆。

### 4.2 对话内图片 artifact

新增专用的 inline image artifact 组件，建议命名为 `ArtifactImage` 或等价名称：

- 只处理 `previewMode === "image"` 且 MIME 在允许图片集合中的 artifact。
- 组件自行通过现有 `fetchArtifact(artifactId)` 获取受控 payload。
- 在生成 Blob URL 前校验 descriptor/payload、MIME、大小和 checksum。
- checksum 必须继续使用 `sha256Hex()`，兼容没有 Web Crypto 的 HTTP 生产环境。
- SVG 必须以已清洗的 `image/svg+xml` Blob 交给 `<img>`；禁止 `dangerouslySetInnerHTML`、同源 iframe 或把 SVG markup 插入 DOM。
- 对话内图片使用稳定的最大高度/宽度和 `object-contain`，避免图片加载前后使消息布局无界跳动。
- 加载、失败、过期、离线、超限状态必须在消息内明确显示，不能永久 loading。
- 点击图片打开大图层，同时记录一次 `open`；首次成功加载记录一次 `success`。不要因展开/关闭大图重复记录成功事件。
- 组件卸载或 artifact 切换时撤销 Blob URL。

第一版建议的对话内展示约束：

- 最大宽度：助手正文可用宽度。
- 最大预览高度：约 `420px` 到 `520px`，使用固定上限而非视口字体缩放。
- 保留自然宽高比，不裁剪流程图。
- 图片下方可显示文件名和大小，但不要再叠加一个重复 artifact 卡片。

### 4.3 大图查看层

新增独立图片查看层，建议命名为 `ImageLightbox`：

- 使用覆盖 Portal 主视口的 modal/lightbox，不占用文档侧栏。
- 背景应克制、半透明，图片完整可见，默认 `contain`。
- 支持点击明确的关闭图标、点击遮罩关闭和 `Escape` 关闭。
- 关闭按钮使用现有图标库；如项目没有图标库，可使用可访问的文本符号，但不得为此引入大型 UI 依赖。
- 至少提供“适应窗口”和“查看原始尺寸/放大”能力；若加入缩放按钮，应具备放大、缩小、重置且不引发布局位移。
- 键盘焦点不能落到遮罩后的聊天控件；关闭后焦点返回触发图片。
- `aria-modal="true"`、可读标题和关闭按钮标签必须完整。
- 大图层不执行 SVG 脚本，不允许导航或外部资源权限。

### 4.4 Markdown 与 HTML 文档侧栏

Markdown 沿用现有安全渲染，不启用 raw HTML。

HTML 是新增协议能力，必须同时修改 Runtime 与 Portal 的 `ArtifactPreviewMode`：

```ts
type ArtifactPreviewMode =
  | "markdown"
  | "html"
  | "image"
  | "pdf"
  | "text"
  | "table"
  | "unsupported";
```

Runtime：

- 明确允许 `.html` / `.htm` -> `text/html`，映射到 `previewMode: "html"`。
- 继续执行 reports 目录、realpath/symlink、scope、大小、checksum 和 MIME 一致性检查。
- HTML 不应通过 legacy `/api/reports/*` 同源 inline 返回。
- 增加 HTML 大小上限和至少一个恶意样本测试。

Portal：

- HTML 只能在 `<iframe sandbox>` 中展示，不能添加 `allow-scripts`、`allow-same-origin`、`allow-forms`、`allow-top-navigation` 或下载权限。
- 使用隔离的 `srcDoc` 或等价方案，并注入严格 CSP：默认禁止资源，仅按真实需要允许 `data:`/`blob:` 图片和内联样式。
- 禁止外部网络图片、脚本、字体、表单提交、meta refresh 和顶层导航。
- iframe 内容不得读取 Portal cookie、DOM、localStorage 或调用已登录 API。
- 侧栏折叠/展开继续保持同一文档和滚动状态。

不要把“HTML 预览”实现为开放任意 HTML/JavaScript 应用运行。本任务只要求静态、隔离的文档查看。

### 4.5 新消息与 legacy SVG 路径

新消息的主路径必须是一等 artifact：

```text
Agent 生成 reports/*.svg
  -> 调用 artifacts.publish
  -> Runtime 在当前 turn 绑定 descriptor
  -> assistant message.metadata.artifacts
  -> Portal 将 image artifact 渲染在消息中
  -> 点击后进入 ImageLightbox
```

执行 Agent 应确认 MCP `artifacts.publish` 的 description 足以让当前 ACP 发现该能力。可加强服务工具描述或新建 Workspace 模板说明，但普通部署不得覆盖 mg 或其他真实 Workspace 的 `AGENTS.md`、`.codex/skills` 或用户方法。

旧消息兼容：

- `/home/claude/.../reports/*.svg` 或 `reports/*.svg` 链接仍通过 legacy publish API 解析。
- 点击 legacy 图片链接后，若 descriptor 为 `previewMode: "image"`，直接打开 ImageLightbox，不进入文档侧栏。
- 不要求在渲染全部历史消息时自动发布所有 legacy 链接，避免页面加载触发大量网络、审计和文件读取。
- legacy Markdown/HTML 链接解析后进入文档侧栏。
- legacy 其他格式保留现有明确降级。

## 5. 代码落点

### Portal 必查/预计修改

- `src/components/chat/ChatShell.tsx`
  - 将文档侧栏展开布局改为主区域等分。
  - 将 artifact 打开动作按 preview mode 分流到文档侧栏或图片查看层。
  - legacy descriptor 同样使用统一分流函数。
- `src/components/chat/MessageBubble.tsx`
  - image artifacts 渲染为对话内图片。
  - 非图片 artifacts 保留卡片。
- `src/components/chat/ArtifactCard.tsx`
  - 卡片注释与行为不再假设所有 artifact 都进入右侧 Viewer。
- `src/components/chat/ArtifactViewer.tsx`
  - 只负责文档/降级预览；移除或停止路由 image 到侧栏。
  - 新增安全 HTML renderer。
- `src/components/chat/MarkdownLite.tsx`
  - legacy 路径回调返回 descriptor 或通过父组件统一分流。
- `src/components/chat/types.ts`
- `src/lib/protocol/types.ts`
  - 加入 `html` preview mode。
- `src/components/chat/api.ts`
  - 复用 artifact fetch/publish；不要新增平行文件读取 API。
- 建议新增：
  - `src/components/chat/ArtifactImage.tsx`
  - `src/components/chat/ImageLightbox.tsx`
  - 共享的 artifact payload 校验/Blob URL helper，避免 Viewer 和 inline image 复制安全逻辑。

### Runtime 必查/预计修改

- `src/services/conversation-artifacts.ts`
  - HTML MIME、格式映射、安全限制。
- `src/portal/connector.ts`
- `src/lib/protocol/*` 或等价协议类型
  - `html` preview mode 透传。
- `src/mcp/invest-agent-service-tools.ts`
  - 必要时加强 `artifacts.publish` 的可发现描述，明确图片会内联到 Portal 消息。
- `tests/conversation-artifacts.test.ts`
  - 增加 HTML 与图片消息绑定相关契约测试。
- `docs/user-portal-protocol.md`
  - 只有当 `html` 成为正式协议能力时更新当前契约。

## 6. 实施顺序

1. 在两个仓库分别确认分支、diff、基线与生产发布目录；不得把用户已有改动误当成任务改动。
2. 先提取共享 artifact payload 验证逻辑，保持当前 checksum fallback 与错误终态。
3. 实现对话内 `ArtifactImage` 和 `ImageLightbox`，让所有 image mode 不再进入侧栏。
4. 修改 `ChatShell` 为文档侧栏展开时主区域 1:1，并保留折叠/关闭状态语义。
5. 扩展 Runtime/Portal 协议支持静态 HTML，并完成 sandbox/CSP 预览。
6. 统一 first-class artifact 与 legacy 链接的打开分流。
7. 增加自动化测试，完成两个仓库的类型检查和生产构建。
8. 启动隔离本地 Portal + Relay + 真实本地 connector 或安全 fixture，完成桌面浏览器验收。
9. 独立审查安全、交互和回归；修复后再提交。
10. 从干净、已审查的发布树走普通代码发布路径部署 Runtime 和 Portal。
11. 验证生产进程、入口、connector、日志和一个不发送真实消息的已有 artifact 打开流程。

## 7. 测试要求

### 自动化

Runtime 至少覆盖：

- 安全 `.html` 发布、读取、checksum 一致。
- `.htm`/`.html` MIME 映射正确。
- HTML 超限、伪造 MIME、路径逃逸、symlink 逃逸、跨 scope 拒绝。
- 恶意 HTML 文件仍只能作为 artifact bytes 返回，不能通过同源 reports route inline 执行。
- SVG artifact 在助手 turn 中正确绑定到 `metadata.artifacts`。

Portal 至少覆盖：

- Web Crypto 可用和不可用时 checksum 均通过。
- image mode 分流到 inline image/lightbox，不创建文档侧栏选择。
- markdown/html mode 分流到文档侧栏。
- legacy SVG descriptor 分流到 lightbox。
- artifact fetch、checksum mismatch、connector offline 和处理异常进入明确终态。
- Blob URL 在切换和卸载时释放。

如当前 Portal 没有组件测试框架，不应为了这次任务引入重量级框架；可以新增针对纯 helper/route decision 的 TypeScript smoke，并用浏览器验收补齐 UI 证据。

### 浏览器验收视口

本任务只验桌面：

- `1440 x 900`
- `1920 x 1080`

每个视口需截图或等价证据验证：

- 文档侧栏展开时对话区与侧栏宽度比例在 `45% : 55%` 到 `55% : 45%` 内。
- 消息、输入框、侧栏标题和控制按钮没有重叠或横向溢出。
- SVG 自然比例正确、内容非空、没有被裁剪成不可读缩略图。
- 点击 SVG 后大图层完整显示，关闭和 Escape 有效。
- 打开大图不会同时打开文档侧栏。
- Markdown/HTML 打开侧栏，折叠后聊天扩展，再展开保持当前内容。
- HTML 内脚本、事件处理器、外链资源、表单和顶层跳转均不生效。

## 8. 验收清单

| 编号 | 必验结果 | 判定标准 |
| --- | --- | --- |
| A1 | 侧栏 1:1 | 两个桌面视口中，展开文档侧栏后两列比例均在 45:55 到 55:45 内 |
| A2 | 折叠与关闭 | 右上角显示文字按钮 `收起`，不显示 `›` 小角标；收起后通过 `展开` 恢复并保留文档、Blob/内容和滚动位置；关闭清除选择 |
| A3 | SVG 对话内展示 | first-class SVG artifact 在助手消息正文下显示真实图像，不显示重复卡片 |
| A4 | SVG 大图 | 点击 SVG 打开独立 lightbox，可通过关闭按钮、遮罩和 Escape 关闭 |
| A5 | 普通图片一致性 | PNG/JPEG/WebP 与 SVG 使用同一展示和大图路径 |
| A6 | 图片不进侧栏 | 点击任何 image mode artifact 都不会创建/替换文档侧栏 |
| A7 | Markdown 侧栏 | Markdown 卡片在右侧栏安全渲染，折叠行为正确 |
| A8 | HTML 侧栏 | 静态 HTML 可读，但脚本、同源访问、网络资源、表单与导航全部受阻 |
| A9 | legacy 兼容 | 旧 SVG 链接点击进入 lightbox；旧 Markdown/HTML 链接进入侧栏 |
| A10 | 完整性 | HTTP 环境无 `crypto.subtle` 时 SVG/图片仍通过纯 JS SHA-256 校验 |
| A11 | 错误终态 | 离线、不存在、不安全、checksum mismatch、异常均不永久 loading |
| A12 | 审计 | 首次打开和成功各记录一次；折叠/重新展开不重复 success |
| A13 | scope 安全 | 用户 A 不能读取用户 B 的图片或 HTML artifact |
| A14 | 生产健康 | Portal、Runtime、111/dyk/mg connector 在线，Portal `/login` 返回 200 |
| A15 | 数据保护 | 发布未替换生产 `.env`、SQLite、Workspace、reviews、`.state` 或微信状态 |

## 9. 发布约束与回滚

### 发布

- 严格使用普通代码发布路径。
- Runtime 从 `main` 的干净、已审查发布 worktree 执行 `scripts/deploy-volcano.sh`。
- Portal 从干净、已审查发布 worktree执行其 `scripts/deploy-volcano.sh`。
- 禁止使用 Runtime 数据迁移/快照 apply 脚本。
- 发布前后记录两个仓库的精确提交、PM2 进程 uptime/restart、connector 状态和入口状态。
- 不打印 `.env`、token、密码或微信登录状态。
- 不发送真实微信测试消息；使用已有会话/artifact 做只读验收。

### 回滚

- 记录发布前 Runtime 与 Portal 的已知良好提交。
- 若 Portal UI 回归，优先部署上一 Portal 提交；不回滚数据库。
- 若 `html` 协议兼容出错，Portal 应把未知 mode 降级为 unsupported，Runtime 可回滚到上一代码提交。
- 回滚后重新验证 Portal、Runtime 与三个 connector。

## 10. 非目标

- 移动端或响应式手机布局。
- 可拖拽侧栏宽度、宽度持久化。
- 在线编辑 Markdown/HTML/SVG。
- 执行 HTML/JavaScript 应用。
- PDF、Office、CSV 等格式的新预览能力扩展。
- 完整 workspace 文件树、分享链接、批注或多人协作。
- HTTPS 域名购买、备案、证书申请或切流。
- 覆盖真实 Workspace 以强制改变 Agent 方法。

## 11. 风险与处理

- **HTML 扩大攻击面**：只允许 opaque-origin sandbox 文档，不赋予任何 capability，并做恶意样本验收。
- **重复下载与内存泄漏**：共享 payload loader/缓存策略，严格撤销 Blob URL；不要让卡片、缩略图和 lightbox 各自重复请求同一文件。
- **legacy 自动解析造成请求风暴**：旧链接只在点击时发布，不在历史消息初次渲染时批量解析。
- **图片导致对话跳动**：使用稳定容器约束、自然宽高比和加载占位。
- **Portal/Runtime 协议版本错配**：未知 `html` mode 必须安全降级；部署顺序需保证旧 Portal 不会执行 HTML。
- **脏工作树混入发布**：建立干净发布 worktree，只选择本任务提交，不清理用户已有变更。
- **HTTP 缺少 Web Crypto**：保留 `@noble/hashes` fallback 和 smoke，不能退回只依赖 `crypto.subtle`。

## 12. 执行 Agent 交接提示词

```text
请进入目标模式，执行 docs/portal-inline-media-preview-work-package.md。

目标是完成桌面网页 Portal 的产物交互收敛并部署火山云：文档侧栏展开时与对话区约 1:1；Markdown 和严格 sandbox 的静态 HTML 进入可折叠侧栏；SVG/PNG/JPEG/WebP 在助手消息中直接展示并点击进入独立大图层，绝不进入侧栏；新消息走 metadata.artifacts，旧 reports 链接按点击兼容。

先审计两个仓库当前工作树与基线，保护用户已有改动。按文档的实施顺序、测试、浏览器视口、验收清单和普通代码发布约束执行。不得覆盖生产数据、真实 Workspace 或微信状态，不得发送真实微信测试消息，不得重新尝试 HTTPS 切流。完成前必须提供本地与生产证据；遇到安全或协议阻断时报告，不扩大范围。
```

建议目标模式 Objective 直接使用本文第 1 节 `Objective`，不要把单个 UI 子步骤提前标记为目标完成。

## 13. 独立验收 Agent 交接提示词

```text
请作为独立验收 Agent，对照 docs/portal-inline-media-preview-work-package.md 第 8 节逐项验收执行结果。

优先寻找行为回归、安全漏洞和缺失证据。必须实测 1440x900 与 1920x1080；验证 1:1 布局、图片不进入侧栏、SVG/普通图片 lightbox、Markdown/HTML 侧栏折叠语义、legacy 路由、HTTP checksum fallback、错误终态、Blob URL 生命周期、HTML sandbox/CSP、跨用户 scope，以及火山云发布未触碰生产数据。不要只凭构建通过或截图判定完成。未满足任一 A1-A15 必验项时给出 Partial/Fail 和精确修复建议。
```
