# Portal 右侧多文件与精选 Workspace 文件树工作包

> 状态：已发布，待生产目视确认（唯一剩余项）
> 日期：2026-07-25
>
> 执行记录（2026-07-25）：
> - 基线收敛：Runtime `main` 由 `b6f6f4b` 快进至发布分支 `677a05e`（前两个工作包的已部署代码），工作树陈旧快照已 stash 备份（`stash@{0}` pre-converge-20260725）。
> - 提交：Runtime `2301647`（main，`artifact.library.list` 精选列表 + cursor 分页 + 聚合审计 + capability + 38/38 测试 + 协议文档）、Portal `0244db3`（`codex/artifact-viewer-portal-release`，多标签文档工作区 + 精选文件树 + 降级 + 键盘/ARIA）。
> - 本地验收：隔离 Portal + Relay + **真实 connector** + 复制 fixture，1440×900 与 1920×1080 各 18/18 Pass，证据 `/private/tmp/portal-library-acceptance/ACCEPTANCE-REPORT.md`（截图 + 量测）。验收中修复 5 个 bug：list route 多传 userId/instanceId 被真实 connector 拒绝（阻断性）、FileTree `hidden` 被 flex 覆盖、隐藏 viewer 滚动被清零、ResizableDivider 命中区 0 高、离线误判为 capability 缺失。
> - 独立安全与交互审查：C1–C14 逐项 Pass，无高/中风险，结论可提交（低风险：mock 白名单与真实 connector 不一致、SESSION_CHANGED 依赖整页 reload 兜底）。
> - 部署：均从干净发布 worktree（`/private/tmp/invest-agent-release-2301647`、`/private/tmp/invest-agent-portal-release-0244db3`）执行普通代码发布；invest-agent(↺20) 与 invest-agent-portal(↺29) 在线；111/dyk/mg connector 重启后全部重新注册；`/login` 200；`/api/artifacts` 401 鉴权正常；dist 含 `listCuratedArtifactLibrary` 与 capability；发布后双端日志零新异常。
> - 数据保护：生产 `.env`（Runtime 2026-07-23、Portal 2026-07-07）、reviews、`.state` mtime 均早于发布未触碰；SQLite/Workspace 未替换；未发送微信消息。
> - 待办：生产 artifact 索引目前只有 111 的 legacy 记录（按设计排除），无任何 `artifacts.publish`/`reviews.save` 正式产物，文件树在生产将正确显示"暂无已发布文档"。需用户在生产 Portal（如 mg）正常对话产生一份正式发布报告后，目视确认其可从文件树打开（唯一剩余项）。
> 面向角色：目标模式执行 Agent、独立验收 Agent
> 依赖：
> - `docs/portal-inline-media-preview-work-package.md`
> - `docs/portal-resizable-sidebars-work-package.md`

## 1. 目标模式任务定义

### Objective

把当前一次只能查看一个文档的右侧预览栏升级为“右侧文档工作区”：

1. 右侧栏支持同时打开多个 Markdown/安全 HTML 文件，并用标签页切换。
2. 右侧栏内增加一个可展开/收起的精选文件树。
3. 文件树只展示当前用户、当前助手实例中经过正式 artifact 发布的可读文档，不暴露完整 Workspace 文件系统。
4. 点击文件树中的文件时，在右侧栏新增或激活对应标签页。
5. 保留现有右栏拖拽调宽、`收起`/`展开`、关闭、预览安全、checksum、错误终态和图片 Lightbox 语义。
6. 完成本地与生产验收后，使用普通代码发布路径部署到火山云。

### Completion Definition

只有同时满足以下条件，目标才可标记完成：

- 用户可从对话 artifact 卡片或文件树打开至少 3 个文档，并在标签间切换。
- 文件树只显示第 3 节定义的精选范围，不泄露未发布文件、绝对路径、配置、Skills、隐藏目录或其他用户文件。
- 文件树整体可展开/收起，目录节点也可逐级展开/收起。
- 已打开标签、活动标签、各标签滚动位置在右栏收起/展开和会话切换时保持。
- 右栏关闭全部、单标签关闭、重复打开、文件失效、connector 离线均有确定行为。
- Runtime、Portal 的相关测试、类型检查和生产构建通过。
- 火山云 Portal、Runtime 与 `111`、`dyk`、`mg` 三个 connector 均在线，生产已有文档可从文件树打开。
- 发布没有替换生产 `.env`、SQLite、Workspace、reviews、`.state` 或微信状态，也没有发送真实微信测试消息。

## 2. 核心设计判断

### 2.1 不暴露真实文件系统

文件树不是 `readdir(workspace)` 的浏览器，也不是用户完整 Workspace 的镜像。它是由服务层 artifact 索引生成的只读虚拟树。

这样设计的原因：

- Workspace 中包含 `AGENTS.md`、`.codex/skills`、配置、运行状态和其他不应进入客户 Portal 的内容。
- Portal 当前已经有受 scope、checksum、MIME、路径和 symlink 保护的一等 artifact 协议，应复用该安全边界。
- 用户真正需要的是“可查看的报告目录”，不是服务器磁盘浏览器。
- 只有经过 Agent 明确发布的产物进入树，展示范围可审计、可解释、可撤销。

### 2.2 精选文件逻辑

首版采用固定、确定性的准入规则。文件必须同时满足：

1. 属于当前 Portal session 的 `userId + instanceId`。
2. 已存在于 `conversation_artifacts` 权威索引。
3. `relative_path` 位于当前用户 Workspace 的 `reports/**` 下。
4. 来源是 `artifacts.publish` 或 `reviews.save`。
5. `previewMode` 是 `markdown` 或 `html`。
6. 文件当前仍存在，realpath 仍位于真实 reports 根目录，且不是 symlink 逃逸。
7. 所有路径段均不是隐藏路径（不以 `.` 开头），文件名不属于临时/备份文件模式。
8. 同一 `relativePath` 存在多个发布记录时，只显示最新有效版本。

首版临时/备份文件模式固定排除：文件名以 `.` 或 `.#` 开头，或以 `~`、`.tmp`、`.temp`、`.bak`、`.swp` 结尾。不要让 Portal 自行判断；该过滤由 Runtime 服务层权威执行。

明确排除：

- 仅因用户点击旧路径而产生的 `legacy_path` artifact，避免历史兼容点击污染长期文件树。
- SVG、PNG、JPEG、WebP 等图片；它们继续在对话中展示并通过 Lightbox 放大。
- PDF、TXT、JSON、CSV、Office 文件；首版文件树与右侧栏只承载已确定的 Markdown/HTML 文档范围。
- `AGENTS.md`、Skills、配置、数据库、日志、隐藏文件、临时文件、绝对路径和 reports 以外内容。
- 未经过 artifact 发布的普通 Workspace 文件，即使其位于 `reports/`。

如果 HTML 支持尚未完成，执行顺序必须先完成依赖工作包中的静态 sandbox HTML；不能为了文件树直接开放同源 HTML。

### 2.3 跨会话、同实例文档库

精选文件树面向当前用户的当前助手实例，而不是只面向当前会话：

- 用户在不同对话中生成的正式报告都可以在同一文件树中看到。
- 切换会话不关闭右侧工作区或已打开标签。
- 切换账户或助手实例必须清空文件树缓存、标签和 Blob/object URL。
- artifact 内容读取仍通过 `artifactId` 和当前 session scope 校验，不能因跨会话展示降低权限要求。

## 3. 用户交互

### 3.1 整体布局

```text
┌─────────── 对话区 ───────────┬────────────── 右侧文档工作区 ──────────────┐
│                               │ [文件]                    [收起] [关闭全部] │
│                               ├───────────────┬───────────────────────────┤
│                               │ 精选文件树    │ [报告A ×] [报告B ×] [C ×] │
│                               │ ▾ 每日复盘    ├───────────────────────────┤
│                               │   07-24.md    │                           │
│                               │   07-23.md    │ 当前文档预览              │
│                               │ ▸ 公司研究    │                           │
│                               │               │                           │
│                               │ [收起文件树]  │                           │
└───────────────────────────────┴───────────────┴───────────────────────────┘
```

右侧工作区仍是一个整体：

- 外层右栏继续可拖拽调宽。
- `收起` 隐藏整个右侧工作区，但保留文件树、标签、内容状态和滚动位置。
- `关闭全部` 关闭全部标签并关闭右侧工作区；文件可再次从“文件”入口或聊天卡片打开。
- 图片 Lightbox 是独立覆盖层，不进入标签或文件树。

### 3.2 文件树入口与整体展开/收起

在对话顶栏增加一个清晰的“文件”入口，使没有 active artifact 时也能打开右侧工作区：

- 点击对话顶栏“文件”：打开右侧工作区并展开文件树。
- 右侧工作区顶栏也保留“文件”按钮，用于展开/收起内部文件树。
- 不能只用不易理解的小角标；按钮使用文件夹图标加“文件”文字，或在无图标库时使用可见文字“文件”。
- 文件树展开按钮提供 `aria-expanded` 和 `aria-controls`。
- 文件树整体收起后，标签和文档预览继续可用。
- 当右侧工作区没有标签但文件树打开时，预览区显示克制的空状态，不显示功能说明或营销文案。

### 3.3 文件树宽度与窄栏行为

- 右侧工作区宽度足够（建议 `>= 680px`）时，文件树停靠在预览区左侧，默认宽约 `220px`，最小 `180px`，最大为右栏的 35%。
- 右侧工作区较窄时，文件树以右栏内部覆盖式抽屉展示，不继续挤压文档正文。
- 覆盖式文件树不覆盖整个 Portal，只覆盖右侧工作区内容区域。
- 在覆盖模式点击文件后自动收起文件树；停靠模式点击文件后保持展开。
- 文件树自身宽度首版不可拖拽，避免出现第二条尺寸分隔线。
- 外层右栏的可拖拽分隔线与文件树边界必须视觉可区分。

### 3.4 目录节点

- 虚拟根目录显示为“报告文件”，不显示服务器路径或 `reports` 前缀。
- 目录节点点击后展开/收起，使用标准 disclosure 语义与 `aria-expanded`。
- 初次打开时，根目录展开；一级目录默认展开最近活动的一个，其余收起。
- 目录优先、文件随后；目录按自然名称排序，文件按 `updatedAt` 降序，同时间再按文件名排序。
- 文件项显示可读标题；次级文本可显示文件名或更新时间，不能显示 absolute path、userId、instanceId、artifactId。
- 同名文件位于不同目录时，目录层级必须可区分。
- 空目录不显示，因为虚拟树只由合格文件构建。
- 列表为空时显示“暂无已发布文档”。
- 首版不提供重命名、移动、删除、上传、拖放或右键菜单。

### 3.5 多文件标签页

标签页位于文档预览区顶部，不放在文件树内：

- 点击聊天中的 Markdown/HTML artifact 卡片：在右栏新增或激活标签。
- 点击文件树文件：在右栏新增或激活标签。
- 重复打开同一 `artifactId` 不产生重复标签，只激活已有标签。
- 同一路径发布新版本后，从文件树打开最新 artifact；旧版本标签仍保持已打开内容，并标识为旧版本或在重新获取时提示内容已更新。
- 每个标签显示短标题和独立关闭按钮，标题过长截断并通过 tooltip 显示完整标题。
- 标签条单行横向滚动，不换行，不挤高侧栏头部。
- 关闭活动标签后激活其左侧最近标签；没有左侧时激活右侧；最后一个标签关闭后保留已展开文件树和空预览状态。
- “关闭全部”清空所有标签、释放资源并关闭右侧工作区。
- 标签顺序按打开顺序稳定；首版不实现拖拽排序。

### 3.6 标签数量与资源管理

首版最多同时打开 `8` 个文档标签：

- 打开第 9 个新文档时，不自动丢弃用户标签；显示“最多同时打开 8 个文件，请先关闭一个标签”。
- 只读文档没有未保存内容，不需要关闭确认。
- 各标签保存自己的加载状态和预览滚动位置。
- 标签切换不重复记录 `success`，也不应在内容未变化时重复下载 payload。
- 关闭标签或关闭全部时释放其 Blob URL、iframe/srcDoc 和内容缓存。
- 右栏 `收起` 只隐藏，不释放打开标签的状态。

### 3.7 焦点与键盘

- 文件树、目录 disclosure、文件项、标签、标签关闭、`文件`、`收起`、`关闭全部` 均可 Tab 聚焦。
- 标签列表使用合适的 `tablist` / `tab` / `tabpanel` 语义。
- `ArrowLeft` / `ArrowRight` 在标签条中移动焦点，`Enter`/`Space` 激活。
- 文件树使用 `tree` / `treeitem` 或语义等价实现；目录左右键展开/收起，上下键移动焦点。
- 关闭活动标签后焦点移动到新活动标签；关闭最后一个标签后焦点移动到文件树或“文件”按钮。
- 右栏收起后焦点回到“展开”入口；重新展开时焦点可回到先前活动标签。

## 4. 数据与协议设计

### 4.1 新增只读 artifact library 能力

不得新增“任意 workspace 路径读取”API。复用 artifact 权威索引，增加一个按 session scope 列举精选文档的只读能力。

建议 Portal/connector command：

```ts
type ArtifactLibraryListRequest = {
  cursor?: string;
  limit?: number; // 默认 200，最大 500
};

type ArtifactLibraryItem = {
  artifactId: string;
  title: string;
  fileName: string;
  displayPath: string; // reports/ 以下的安全相对展示路径，不含 reports 前缀
  directorySegments: string[];
  mimeType: "text/markdown" | "text/html";
  previewMode: "markdown" | "html";
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  checksum?: string;
};

type ArtifactLibraryListResult = {
  items: ArtifactLibraryItem[];
  nextCursor?: string;
};
```

建议命令名：`artifact.library.list`。Portal 同源路由建议为：

```text
GET /api/artifacts?cursor=<opaque>&limit=200
```

关键约束：

- `userId`、`instanceId` 从已认证 Portal session 和 connector registration 得到，不接受浏览器提交。
- cursor 必须不透明且稳定，排序至少包含 `updated_at + artifact_id`，避免重复/漏项。
- 返回 `displayPath` 仅用于构造虚拟树，不得返回 Workspace 绝对路径或真实根目录。
- 列表阶段执行精选准入和 scope 过滤；内容读取继续走现有 `artifact.get`。
- API 未实现 raw path 参数、目录遍历参数、glob 或文件内容搜索。
- Portal 对未知 preview mode 安全忽略，不尝试自行猜测文件类型。
- capability 列表中显式增加 `artifact.library.list`，旧 connector 不支持时 Portal 显示“文件目录暂时不可用”，不影响聊天与已打开 artifact。

### 4.2 服务层查询与有效性检查

服务层实现应：

1. 按 `user_id + instance_id` 查询 artifact 索引。
2. 排除 `source = legacy_path`、非 Markdown/HTML、reports 外路径和隐藏/临时路径。
3. 按 `relative_path` 分组选择最新记录。
4. 对候选文件执行 realpath、reports containment、普通文件、大小与当前文件存在性检查。
5. 对最终项构造安全展示路径；不把绝对路径写入日志、响应或 Portal mirror。
6. 只返回描述符，不在 list 请求中批量读取文件正文。

列表是只读确定性服务能力。建议记录一条聚合审计事件（请求 scope、返回数量、分页信息），不要为每个树节点写一条事件。

### 4.3 树刷新

- 用户打开文件树时拉取第一页。
- 文件树保持打开期间，可提供手动刷新按钮；不做高频轮询。
- 当前网页对话完成并返回新的 Markdown/HTML artifact 后，静默刷新第一页，使新文档出现在树中。
- 分页存在时在树底部提供“加载更多”，追加并去重。
- 刷新不得关闭标签、重置目录展开状态或跳走活动文档。
- 文件在刷新后消失时，已打开标签继续保留；下一次读取失败显示既有 missing/stale 状态。

## 5. 前端状态模型

建议将当前单一 `activeArtifact` 收敛为右侧工作区状态：

```ts
type OpenDocumentTab = {
  artifact: ArtifactCardView;
  scrollTop: number;
  openedAt: number;
};

type DocumentWorkspaceState = {
  open: boolean;
  collapsed: boolean;
  treeExpanded: boolean;
  tabs: OpenDocumentTab[];
  activeArtifactId: string | null;
};
```

状态不应全部塞进一个巨型 `ChatShell` effect。建议提取 `useDocumentWorkspace` 或 reducer，集中处理：

- `OPEN_DOCUMENT`
- `ACTIVATE_TAB`
- `CLOSE_TAB`
- `CLOSE_ALL`
- `COLLAPSE_WORKSPACE`
- `EXPAND_WORKSPACE`
- `TOGGLE_TREE`
- `SAVE_SCROLL`
- `SESSION_CHANGED`

切换会话不触发 `CLOSE_ALL`；session 的 `userId` 或 `instanceId` 变化必须触发清理。

## 6. 代码落点

### Runtime 仓库

路径：`/Users/combo/MyFile/projects/invest-agent-ideal`

必查/预计修改：

- `src/services/conversation-artifacts.ts`
  - 新增精选列表查询、去重、路径过滤与有效性检查。
- `src/portal/connector.ts`
  - 接收 `artifact.library.list` 并复用服务层。
- Portal 协议类型/命令定义所在模块。
- connector capability 注册。
- `tests/conversation-artifacts.test.ts`
  - 增加列表范围、分页、去重、隐藏/legacy/跨 scope/失效文件测试。
- `docs/user-portal-protocol.md`
  - 将 library list 记录为正式只读契约。

不新增数据库表；首版复用 `conversation_artifacts` 及现有索引。只有查询计划证明确有性能问题时才增加最小索引，并按 `db-migration` 规范执行。

### Portal 仓库

路径：`/private/tmp/invest-agent-artifact-release-portal`

必查/预计修改：

- `src/components/chat/ChatShell.tsx`
  - 从单 artifact 状态迁移到文档工作区状态。
  - 对话切换不再自动清空文档标签。
  - 对话顶栏增加“文件”入口。
- `src/components/chat/ArtifactViewer.tsx`
  - 支持作为标签内容实例保存/恢复滚动位置，或拆成无顶栏的内容 Viewer。
- `src/components/chat/api.ts`
  - 增加同源文件树列表请求。
- `src/lib/protocol/types.ts` 与 envelope/type 定义。
- `src/app/api/artifacts/route.ts`
  - 新增已认证的 library list 转发；路径参数 artifact get 继续保持现状。
- 建议新增：
  - `src/components/chat/DocumentWorkspace.tsx`
  - `src/components/chat/ArtifactTabs.tsx`
  - `src/components/chat/ArtifactFileTree.tsx`
  - `src/components/chat/useDocumentWorkspace.ts`
  - tree builder、分页去重和状态 reducer 的纯函数测试/smoke。

必须兼容正在实施或已完成的 `ResizableDivider.tsx` 与 `useResizablePanel.ts`，不能重写右栏拖拽逻辑。

## 7. 实施顺序

1. 审计 Runtime 和 Portal 当前工作树，确认前两个工作包实际完成状态；保护并行改动。
2. 先定义 `artifact.library.list` 协议、scope、分页、精选规则和错误形状。
3. 在 Runtime 实现列表服务与安全/分页测试，再接 connector capability。
4. 在 Portal 实现 route/API、树构造纯函数和离线/旧 connector 降级。
5. 将单 artifact 状态改为 document workspace reducer，保持现有 checksum、load state 和 telemetry。
6. 实现标签条、单标签关闭、关闭全部、8 标签上限与滚动位置保持。
7. 实现文件树停靠/覆盖模式、整体和目录展开/收起、分页、刷新和键盘语义。
8. 接入聊天 artifact 卡片、legacy Markdown/HTML 链接与对话顶栏“文件”入口。
9. 完成两个仓库的类型检查、专项测试和生产构建。
10. 使用隔离本地 Portal + Relay + 真实 connector/复制 fixture，进行桌面浏览器验收。
11. 独立安全与交互审查通过后，分别提交 Runtime 与 Portal 变更。
12. 从干净发布 worktree 使用普通代码发布路径部署 Runtime 与 Portal，再执行只读生产验收。

## 8. 自动化测试要求

### Runtime

- 当前 user/instance 只能看到自己的合格 artifact。
- 同一用户不同 instance 互相不可见。
- `legacy_path`、image/PDF/text/table/unsupported 不进入精选列表。
- reports 外路径、绝对路径、`..`、隐藏段、临时/备份文件和 symlink 逃逸不进入列表。
- 同一路径多版本只返回最新有效 artifact。
- 最新版本失效时的规则明确：推荐继续查找同路径下最近一个仍有效的正式版本；不得回退到 legacy 来源。
- cursor 分页稳定，无重复、无漏项，非法 cursor 返回确定错误。
- 返回值不包含 absolute path、userId、instanceId、conversationId 或内部 scope。
- 目录列表不批量返回正文。

### Portal

- descriptor 列表能稳定构造嵌套树，排序和同名路径正确。
- 点击同一文件两次只产生一个标签。
- 8 标签上限、关闭活动/非活动/最后标签行为正确。
- 切换标签保存并恢复各自滚动位置。
- 收起/展开右栏不丢标签、树状态或 payload；关闭全部释放资源。
- 切换会话保留标签；session/instance 变化清空标签与缓存。
- 旧 connector 不支持 library list、connector offline、分页失败、空列表均有明确状态。
- tree item、tab 与控制按钮具备所定义的键盘和 ARIA 行为。
- 图片 artifact 不进入树或文档标签，仍走 Lightbox。

## 9. 浏览器验收

仅验桌面：

- `1440 x 900`
- `1920 x 1080`

必须覆盖：

1. 通过对话顶栏“文件”打开无标签的右侧工作区和文件树。
2. 文件树只出现 mg 当前已发布的 Markdown/安全 HTML 报告，不出现 SVG、配置或未发布文件。
3. 展开/收起文件树及至少两层目录。
4. 从文件树依次打开 3 个文件，验证标签、内容与路径归类。
5. 再从聊天 artifact 卡片打开一个文档，验证进入同一标签系统。
6. 重复点击同一文件，验证只激活不重复。
7. 在不同标签滚动到不同位置，切换后位置保持。
8. 收起整个右栏再展开，标签、活动文档、文件树与滚动位置保持。
9. 拖拽右栏宽度；在宽模式观察停靠树，在窄模式观察覆盖树且正文可读。
10. 切换会话，右侧工作区保持；登出或切换测试 session 后清空。
11. 关闭一个标签、关闭最后标签、关闭全部，验证焦点和空状态。
12. 停止隔离 connector 后，树显示离线但已镜像对话仍可读；重启后刷新恢复。
13. 验证 SVG/图片仍只在对话和 Lightbox 中，不进入文件树或文档标签。

## 10. 验收清单

| 编号 | 必验结果 | 判定标准 |
| --- | --- | --- |
| C1 | 精选范围 | 树只含当前 user/instance 正式发布、有效的 Markdown/HTML reports artifact |
| C2 | 无文件系统泄露 | 响应只含对外 opaque `artifactId` 与安全展示字段；不含绝对路径、配置、Skills、隐藏/临时文件、数据库 row id、scope 身份字段或其他用户内容 |
| C3 | 入口 | 没有 active artifact 时也能从对话顶栏“文件”打开右侧工作区 |
| C4 | 树折叠 | 文件树整体及目录节点均可展开/收起，并保留展开状态 |
| C5 | 多标签 | 可同时打开 3 个以上文档；重复打开只激活已有标签 |
| C6 | 标签关闭 | 单标签、活动标签、最后标签和关闭全部行为符合第 3.5 节 |
| C7 | 状态保持 | 标签、活动项、树状态和各文档滚动在右栏收起/展开及会话切换后保持 |
| C8 | 尺寸兼容 | 右栏拖拽正常；宽栏停靠树、窄栏覆盖树，无横向溢出或正文不可读 |
| C9 | 安全读取 | 点击文件仍走 artifactId、scope、checksum、MIME 和 sandbox 校验，不出现 raw path API |
| C10 | 降级 | 空列表、离线、旧 connector、不存在、stale、分页失败都有明确非永久 loading 状态 |
| C11 | 图片边界 | SVG/普通图片不进入树/标签，继续走对话内预览和 Lightbox |
| C12 | 可访问性 | 树、目录、标签、关闭、文件、收起/展开具备键盘与 ARIA 语义 |
| C13 | 审计 | list 仅聚合审计；打开/成功事件不因标签切换重复记录 |
| C14 | 性能资源 | 8 标签上限有效；重复打开不重复拉取；关闭释放 Blob/iframe/cache |
| C15 | 生产健康 | Portal `/login` 返回 200，Portal、Runtime、111/dyk/mg connector 在线且无新异常 |
| C16 | 数据保护 | 仅代码发布，未替换生产数据、配置或真实 Workspace，未发送真实微信测试消息 |

## 11. 非目标

- 展示完整 Workspace 或任意路径浏览。
- 在文件树中显示图片、PDF、Office、CSV、JSON 或纯文本。
- 文件上传、下载管理、重命名、移动、复制、删除、收藏、分享或权限管理。
- 标签拖拽排序、标签固定、恢复上次浏览器会话。
- 文件树搜索、全文搜索、最近文件、版本历史或 diff。
- 文件树自身可拖拽调宽。
- 移动端适配。
- 修改 Workspace Skills/AGENTS 或自动发布旧文件。
- HTTPS、域名、备案或证书工作。

## 12. 风险与缓解

- **把文件树误做成真实 FS 浏览器**：API 只列 artifact 索引，不接收路径/glob，不调用通用 readdir。
- **历史 legacy 点击污染目录**：明确排除 `source=legacy_path`。
- **同一路径多版本混乱**：树只显示最新有效版本；已打开旧标签明确标识，不静默替换内容。
- **多标签内存增长**：限制 8 个标签，复用 payload，关闭时释放 Blob/iframe/cache。
- **右栏变窄后树挤压正文**：阈值以下改为右栏内部覆盖式抽屉。
- **会话切换误清空标签**：文档库按 user/instance 管理，只在 session scope 变化时清理。
- **协议版本错配**：capability 检测与明确降级，不影响聊天和现有 artifact 卡片。
- **共享脏工作树混入发布**：两个仓库分别建立干净、已审查发布 worktree，只纳入本任务和依赖任务提交。

## 13. 发布与回滚约束

- 这是普通代码发布，禁止使用 Runtime 数据迁移、快照 apply 或 Workspace 替换路径。
- Runtime 必须从 `main` 的干净、已审查提交执行 `scripts/deploy-volcano.sh`。
- Portal 必须从干净、已审查提交执行其 `scripts/deploy-volcano.sh`。
- 发布顺序建议 Runtime/connector capability 先上线，Portal 后上线；旧 Portal 会忽略新 capability。
- 发布后验证 PM2、入口、三条 connector、library list 和已有 artifact get。
- 不打印 `.env`、token、密码或微信登录状态，不发送真实微信测试消息。
- 回滚 Portal 时文件树入口消失但现有单文件 artifact viewer 应恢复可用。
- 回滚 Runtime 时 Portal 根据 capability 缺失显示目录不可用，聊天与已有卡片仍可工作。
- 回滚不得回滚或替换数据库；本任务不新增强制数据迁移。

## 14. 执行 Agent 交接提示词

```text
请进入目标模式，执行 docs/portal-multi-file-workspace-library-work-package.md。

把右侧单文件预览升级为多标签文档工作区，并加入可收起的精选文件树。文件树绝不是完整 Workspace 浏览器：只列当前 userId+instanceId 下，经 artifacts.publish/reviews.save 正式登记、当前有效、位于 reports/** 的 Markdown/安全 HTML，排除 legacy_path、图片、其他格式、隐藏/临时文件与所有未发布文件。内容仍按 artifactId 读取。

保留现有右栏 1:1 默认、拖拽调宽、可见文字“收起”/“展开”、Markdown/HTML 安全渲染、图片对话内展示与 Lightbox。多文件使用最多 8 个标签，右栏收起和会话切换保持标签/树/滚动；session scope 变化清空。按协议、测试、浏览器验收 C1-C16 和普通火山云代码发布约束执行。

先审计两个共享工作树及前两个依赖工作包的实际状态，不得 reset、清理、覆盖并行改动或真实 Workspace。不得新增任意路径读取 API，不得发送真实微信测试消息，不得替换生产数据。
```

## 15. 独立验收 Agent 交接提示词

```text
请独立验收 docs/portal-multi-file-workspace-library-work-package.md，对 C1-C16 逐项给出 Pass/Partial/Fail 与可复查证据。

安全优先：确认文件树由 artifact 索引生成而非 raw workspace readdir；验证跨 user/instance、reports 外路径、legacy、隐藏/临时、symlink、失效文件和绝对路径泄露。交互上必须实测多标签、重复打开、单个/全部关闭、各标签滚动保持、树整体/目录折叠、宽/窄右栏、会话切换、session 变化、离线和旧 connector 降级，并确认 SVG/图片仍只走对话与 Lightbox。

在 1440x900 与 1920x1080 进行浏览器验收，确认火山云发布只同步代码，Portal、Runtime 和三条 connector 在线。不要仅凭构建、静态代码或单张截图判定完成。
```
