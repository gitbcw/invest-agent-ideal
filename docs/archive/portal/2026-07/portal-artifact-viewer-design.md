# 用户门户 Artifact Viewer 设计与实施建议

> 状态：调研与方案建议，不代表已实现  
> 日期：2026-07-24

## 1. 背景与判断

当前 Portal 把 AI 生成的文件当作助手正文中的 Markdown 链接。用户点击后离开对话，预览能力取决于浏览器和本机工具；历史回复还可能包含 `/home/claude/...` 服务器绝对路径。已上线的 `report.asset.get` 与 `/api/reports/*` 解决了指定报告文件能否读取的问题，但没有形成完整的产物交互。

本项目下一步应建设一个 **Artifact Viewer（对话产物查看器）**：AI 生成的报告、图表和数据文件以结构化产物卡片出现在消息中，点击后在可收起的右侧栏预览。它不是通用文件管理器，也不是在线 Office。

推荐现在做到：

1. 建立结构化 artifact 协议与受控发布流程，不再依赖解析正文路径。
2. 完成网页门户内可折叠、可收起的右侧预览栏。
3. 第一批原生预览 Markdown、SVG/常见图片、PDF、纯文本/JSON/CSV。
4. 保留下载能力和不支持格式的明确降级。
5. 暂不做 DOCX/PPTX/XLSX 高保真预览、在线编辑、批注、多人协作或完整 workspace 文件树。

## 2. 调研结论

### 2.1 前沿产品的共同模式

不同产品的视觉实现有差异，但成熟交互有四个共同点：

- **对话与产物分层**：文件不是普通超链接，而是有标题、类型、状态和动作的一等对象。
- **保持上下文**：点击产物后对话仍然可见，用户可以边看边继续追问。
- **产品内渲染**：预览器由产品选择，用户无需依赖本机安装对应软件。
- **预览与编辑分层**：查看、下载是基础能力；编辑、版本、协作是更高一级能力，不应混在首版。

参考产品：

- Claude Artifacts 把产物作为对话旁的独立工作区，可持续更新，并进一步发展为可交互应用。这证明“chat + artifact surface”已经是稳定模式，但它的应用构建和持久存储范围明显超过本项目当前需要。[Anthropic: Build Artifacts](https://claude.com/blog/build-artifacts)
- ChatGPT Canvas 把写作或代码内容放入独立编辑界面，强调协作修改，而不是把文件扔给系统默认应用。[OpenAI: Canvas](https://help.openai.com/en/articles/9930697-what-is-the-canvas-feature-in-chatgpt-and-how-do-i-use-it)
- GitHub 文件页将文件内容、文件动作和 Copilot 问答关联起来，用户可针对整个文件或选中内容继续提问。[GitHub: Viewing and understanding files](https://docs.github.com/en/repositories/working-with-files/using-files/viewing-and-understanding-files)
- Codex 当前产品呈现出的关键借鉴点是：文件/产物在任务内部打开，查看面板可关闭，不要求用户理解底层磁盘路径。由于本轮 OpenAI 官方手册受网络代理 403 限制，且新安装的官方 Docs MCP 需要重启后才会出现在会话中，本条只作为界面模式参考，不据此推断未公开能力。

### 2.2 本项目的真实需求分布

生产 workspace 当前 `reports/` 中约有 60 个 Markdown 文件、2 个 SVG 文件；mg 的主要产物是日/周复盘、公司报告、决策指标 Markdown 和本次 SVG 流程图，文件大小都很小（当前最大约 8 KB）。

因此，首版优先级应是：

| 优先级 | 格式 | 原因 | 首版方式 |
|---|---|---|---|
| P0 | Markdown | 当前绝大多数投资报告 | Portal 内安全 Markdown 渲染 |
| P0 | SVG、PNG、JPEG、WebP | 流程图、指标图、截图 | 安全图片预览，缩放/适应宽度 |
| P1 | PDF | 用户手册、正式报告导出 | 内置 PDF 查看器或受控浏览器预览 |
| P1 | TXT、JSON、CSV | 数据与审计导出 | 文本/表格预览，限制行数和大小 |
| P2 | DOCX、PPTX、XLSX | 当前 AI 产物中尚无真实需求 | 服务端转换后预览，不依赖客户本机 |

## 3. 产品交互

### 3.1 网页门户布局

```text
┌──────────────┬──────────────────────────┬─────────────────────────┐
│ 会话历史     │ 当前对话                 │ 产物预览                │
│ 可折叠       │                          │ 文件名   下载   关闭     │
│              │ 助手回复                 │                         │
│              │ ┌────────────────────┐   │ Markdown / 图 / PDF     │
│              │ │ 投资决策流程图 SVG │──▶│                         │
│              │ │ 预览 · 6.3 KB      │   │                         │
│              │ └────────────────────┘   │                         │
│              │                          │                         │
│              │ 输入框                   │                         │
└──────────────┴──────────────────────────┴─────────────────────────┘
```

- 点击消息中的 artifact 卡片，在右侧打开预览，不跳离对话。
- 再点击另一产物时复用同一侧栏并替换内容。
- 顶栏只保留文件名、类型、下载、在新窗口打开（可选）和关闭按钮。
- 支持关闭按钮和 `Escape`；关闭后聊天区恢复宽度。
- 右侧栏建议初始宽度 42%，最小 420px、最大 720px；首版可以固定宽度，第二步再加入拖拽调整与本地记忆。
- 顶栏提供明确的折叠/展开控制；折叠后只保留一个低干扰的展开入口，聊天区占用释放出的宽度。
- 关闭表示取消当前产物选择；折叠只隐藏预览并保留当前产物，重新展开时恢复原预览位置。
- 切换会话时关闭预览，避免把上一位上下文的文件误认为当前会话产物。

### 3.2 Artifact 卡片

卡片应展示：类型图标、可读标题、文件类型与大小、生成状态。整张卡片是“查看”动作，下载放在预览顶栏作为次级动作。

不要继续让 Agent 把“已制作完成”加服务器绝对路径链接作为唯一交付方式。回复正文可以说明结果，但结构化卡片才是文件入口。

### 3.3 状态与降级

- `loading`：骨架或加载指示，不阻塞聊天滚动。
- `ready`：正常预览。
- `connector_offline`：说明文件暂时不可读取，保留重试；对话历史仍可查看。
- `expired/not_found`：说明产物不存在或已清理，不循环重试。
- `unsupported`：展示文件信息和下载按钮，不伪装成可预览。
- `too_large`：提示超过在线预览限制，允许下载。
- `unsafe`：拒绝内联渲染，说明该格式只能下载或已被阻止。

## 4. 数据与协议设计

### 4.1 一等 Artifact

建议在助手消息 `metadata.artifacts` 中保存描述符：

```ts
interface ConversationArtifact {
  artifactId: string;       // 不可猜测的稳定 ID
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: "report" | "chart" | "data" | "document";
  previewMode: "markdown" | "image" | "pdf" | "text" | "table" | "unsupported";
  createdAt: string;
  checksum?: string;
}
```

Portal 镜像只保存以上安全字段，不保存 workspace 绝对路径。`artifactId` 在服务端映射到精确的 `userId + instanceId + relativePath`。

### 4.2 发布流程

```text
Agent 生成 workspace 文件
  -> artifacts.publish / reviews.save 返回 artifact descriptor
  -> 服务层登记 scope、相对路径、MIME、大小、checksum 和审计
  -> assistant message.metadata.artifacts 关联 artifactId
  -> Portal 镜像消息与 descriptor
  -> 用户点击卡片
  -> Portal 登录态 API
  -> Relay report/artifact command
  -> connector 按注册 scope 读取
  -> Portal 选择受控 previewer
```

`reviews.save` 应直接返回并关联复盘 artifact；临时图表和报告使用新的 `artifacts.publish`。该工具只登记已经位于允许目录的文件，不接受绝对路径，也不允许 Agent 选择 user scope。

现有正文绝对路径转换保留为兼容层，用于旧消息；新消息不得依赖它。

### 4.3 索引归属

产物正文继续属于 workspace。artifactId、消息关联、scope、checksum、可见状态和审计属于服务层确定性元数据，可以使用 SQLite `conversation_artifacts` 表；Portal 只镜像 descriptor。

首版内容按需通过 connector 读取，不建立第二份云端永久文件源。由于生产 connector 当前长驻火山云，这个限制可接受。未来若真实本地 connector 导致历史文件经常离线，再增加加密、限期的 Portal artifact cache；不能一开始就把全部 workspace 同步到云端。

## 5. 预览器策略

| Preview mode | 实现建议 | 安全要求 |
|---|---|---|
| Markdown | `react-markdown + remark-gfm`，可选目录 | 禁止 raw HTML；外链标识并新窗打开 |
| Image | `<img>` + fit/zoom | MIME 与 magic bytes 一致；SVG 特殊处理 |
| SVG | 清洗后渲染，或服务端转 PNG | 不得把任意 SVG 以同源可执行文档直接打开 |
| PDF | 优先 PDF.js，保证统一体验 | 禁用内嵌脚本/附件动作，限制大小 |
| Text/JSON | 等宽文本、换行、复制 | 限制字符数；不执行内容 |
| CSV | 只读虚拟表格 | 限制行列；公式按文本展示，防 CSV 注入 |
| Office | P2 服务端转 PDF/HTML | 不把客户文件上传第三方转换服务 |

### 当前必须先修正的安全点

现有 `/api/reports/*` 可以返回 `image/svg+xml` 且采用 `inline`。在加入侧栏前，必须避免未清洗 SVG 作为同源可执行文档打开：首选服务端清洗或转 PNG；至少让预览运行在无同源权限的 sandbox iframe/独立静态域，并配置严格 CSP。HTML 也不得直接同源执行。

## 6. 推荐实施范围

### Phase 0：协议和安全地基（必须先做）

- 定义 `ConversationArtifact`、`artifactId` 和 `metadata.artifacts`。
- 建立 `conversation_artifacts` 索引或等价权威映射。
- 增加 `artifacts.publish`；扩展 `reviews.save` 返回 artifact descriptor。
- 将 `report.asset.get` 收敛为按 artifactId 读取，旧相对路径仅兼容。
- 完成 SVG/HTML 隔离、MIME 校验、大小限制、scope 和路径穿越测试。

### Phase 1：投资报告 Viewer（本项目现在应该做到这里）

- 消息 artifact 卡片。
- 网页门户内可折叠、可收起的右侧预览栏。
- Markdown、SVG/图片、PDF、TXT/JSON、CSV 预览。
- 下载、加载、离线、过期、不支持和超限状态。
- 旧绝对路径消息点击后仍能打开同一 Viewer。
- 对 mg 的现有流程图、月度指标 Markdown、日/周复盘做真实验收。

### Phase 2：使用数据证明后再做

- 可拖拽宽度及宽度记忆。
- 产物历史/最近产物入口。
- DOCX/PPTX/XLSX 服务端转换。
- 大文件分块传输、Portal 加密缓存和离线预览。
- 从预览选中文本后“针对这段继续问”。

### 明确不做

- 在线 Office 编辑器。
- 任意 HTML/JavaScript 应用运行。
- 完整 workspace 文件浏览器。
- 多人批注、分享链接和权限协作。
- 产物版本分支、diff 或自动覆盖原文件。
- 为了预览把用户文件发送到第三方 SaaS。

## 7. 验收标准

1. AI 生成的文件以结构化卡片出现，正文不暴露绝对路径。
2. 点击卡片后在右侧打开，聊天仍可滚动和继续输入；关闭后聊天区恢复。
3. 折叠预览栏后聊天区扩展，重新展开时恢复同一产物和原预览位置；关闭则清除当前产物。
4. Markdown、mg 的 SVG 流程图、图片、PDF、JSON/CSV 各有一个真实样本通过。
5. 下载内容与 workspace 文件 checksum 一致。
6. 用户 A 无法使用 artifactId、路径变体或旧 URL 读取用户 B 的文件。
7. `..`、绝对路径、符号链接逃逸、伪造 MIME、超大文件全部被拒绝。
8. 恶意 SVG/HTML 不能在 Portal 同源上下文执行脚本、读页面或发起已登录操作。
9. connector 离线、文件不存在、不支持和超限都有稳定可理解状态。
10. 旧消息中的 `/home/claude/.../reports/...` 链接仍可通过兼容映射打开 Viewer。
11. 预览打开/成功/失败/下载写入轻量审计或遥测，便于判断是否值得进入 Phase 2。

## 8. 风险与取舍

- **把侧栏先做出来但协议仍是路径链接**：开发快，但会继续产生安全和兼容债；不建议。
- **一开始支持全部 Office**：投入大、依赖重，当前生产需求没有证据；后置。
- **文件只在 connector 在线时可读**：首版存在，但符合当前架构和实际部署；用明确离线状态接受这个限制。
- **在 Portal 永久镜像所有文件**：体验更稳，但扩大数据治理和泄露面；需在真实离线使用数据出现后再决策。
- **SVG/HTML 直接 iframe**：实现最简单但同源执行风险高；必须在 Viewer 前解决。

## 9. 执行交接

Executor prompt:

> 按 `docs/portal-artifact-viewer-design.md` 实现 Phase 0 和 Phase 1。先完成结构化 artifact 协议、安全读取与恶意 SVG/路径逃逸测试，再实现 Portal 右侧 Viewer。不得扩展到 Office 转换、在线编辑、文件树或云端永久镜像。保留旧绝对路径消息兼容，并使用 mg 现有 SVG、Markdown 复盘做真实验收。

Reviewer prompt:

> 独立验收 Phase 0/1，重点检查 artifact 是否是一等消息对象、跨用户 scope、绝对路径和符号链接逃逸、SVG/HTML 同源执行风险、右侧栏折叠/关闭语义、connector 离线降级，以及旧消息兼容。不要只凭 UI 截图判定完成，必须验证实际文件内容、checksum、审计和负向权限测试。
