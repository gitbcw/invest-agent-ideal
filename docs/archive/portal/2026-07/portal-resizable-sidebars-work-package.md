# Portal 右侧文档栏可拖拽调宽工作包

> 状态：实施中（已接入初始 1:1.2、分隔线与可折叠目录，待浏览器/生产验收）
> 日期：2026-07-25
> 面向角色：目标模式执行 Agent、独立验收 Agent
> 依赖：`docs/portal-inline-media-preview-work-package.md` 中的桌面 Portal 预览布局

## 1. 目标模式任务定义

### Objective

为桌面网页 Portal 的右侧文档预览栏实现可折叠、可拖拽调宽能力：

1. 右侧文档栏可按现有语义折叠和恢复。
2. 对话区与右侧文档栏之间的唯一竖向分隔线可拖拽，改变两侧宽度分配。
3. 右侧栏首次打开时使用“对话区 : 右侧栏 = 1:1.2”的默认布局；用户拖拽后，以用户选择的宽度为准。
4. 拖拽、右栏折叠/关闭、切换会话、图片 Lightbox 与窗口尺寸变化之间不互相破坏。

### Completion Definition

仅当以下全部完成时可标记目标完成：

- 右侧文档栏能折叠并恢复上一次有效宽度、已选 artifact 和预览滚动位置。
- 唯一的中间/右侧分隔线可通过鼠标或触控板指针拖拽，并提供键盘等价操作。
- 在 `1440 x 900` 与 `1920 x 1080` 桌面视口中，布局稳定、无重叠、无横向滚动条。
- 左侧会话栏现有宽度和折叠行为未改变。
- 文档预览、对话滚动、输入框、会话操作和图片 Lightbox 均无回归。
- Portal 类型检查、构建和浏览器验收通过；按普通代码发布路径部署火山云且健康检查通过。
- 发布未覆盖生产 `.env`、SQLite、Workspace、reviews、`.state`、微信状态或 connector 配置，且未发送真实微信测试消息。

## 2. 范围与明确非范围

布局只调整以下一个边界：

```text
┌── 左侧会话栏（保持现状）──┬──────── 中间对话区 ────────┬── 右侧文档栏 ──┐
│                            │                             │                 │
│                            │                             │                 │
└────────────────────────────┴─────────────────────────────┴─────────────────┘
                                                            ↑
                                                     唯一可拖拽分隔线
```

| 区域 | 本任务行为 |
| --- | --- |
| 左侧会话历史栏 | 保持当前固定宽度及现有折叠按钮；不增加拖拽、尺寸状态、键盘分隔线或持久化 |
| 中间对话区 | 根据右侧文档栏宽度自适应 |
| 右侧文档预览栏 | 保留现有折叠/关闭语义，新增可拖拽调宽 |

本任务只覆盖桌面网页，不做移动端、触屏专用布局、纵向分栏或多栏框架。

## 3. 前置状态与不可回退边界

执行前必须审计 Portal 工作树。共享工作区可能已有上一工作包的未提交实现，禁止清理、重置或覆盖用户/其他 Agent 的改动。

已知代码位置：

- Portal 工作树：`/private/tmp/invest-agent-artifact-release-portal`
- 主容器与右侧文档栏：`src/components/chat/ChatShell.tsx`
- 左侧会话栏：`src/components/chat/Sidebar.tsx`
- 文档预览栏：`src/components/chat/ArtifactViewer.tsx`
- 当前左侧栏固定宽度：`Sidebar.tsx` 的 `w-[280px]`，本任务不得修改。
- 当前右侧栏已进入约 1:1 的 flex 布局；执行 Agent 必须实测并保留该默认值。

保留既有语义：

- 左侧栏顶栏按钮继续是左栏唯一折叠/展开入口。
- 右侧栏折叠只隐藏预览，不清除当前 artifact 或预览滚动位置；关闭才清除当前 artifact。
- 右侧栏展开时，右上角的折叠控制必须是可见文字按钮 `收起`，不得继续使用 `›`、小角标或仅图标；收起后的恢复入口使用可见文字 `展开`。关闭按钮独立保留，不能与 `收起` 合并。
- 图片/SVG 继续走对话内展示与 Lightbox，不能因为本任务重新进入右侧栏。
- Markdown/HTML 继续走右侧文档栏；本任务不改变其渲染或安全模型。

## 4. 交互与布局设计

### 4.1 初始尺寸与约束

内部状态应使用像素宽度或可解析的 CSS 自定义属性，并在容器尺寸改变时重新 clamp；不能只保存不可恢复的比例。

| 区域 | 默认 | 最小 | 最大 |
| --- | ---: | ---: | --- |
| 右侧文档栏 | 首次打开时占“左栏以外可用空间”的 54.5% | `360px` | 主区域可用宽度的 60% |
| 中间对话区 | 首次打开时占 45.5% | `480px` | 剩余空间 |

- 1:1 不包含左侧会话栏。
- 右栏首次打开时才初始化为 1:1；拖拽后不应因 rerender、折叠或切换会话被强制写回 1:1。
- 当窗口无法同时满足中间 `480px` 与右栏 `360px` 时，优先保持对话区，右栏折叠；不要允许拖拽至零宽或制造页面横向滚动。
- 关闭右侧文档清除 artifact，但保留上次 `rightWidthPx`，使下次打开文档仍采用用户选择的宽度。

### 4.2 唯一分隔线

中间对话区与右侧文档栏之间使用一个稳定的竖向拖拽区：

- 命中面积不低于 `8px`，视觉线保持克制（约 1px）。
- 悬停和拖动期间使用 `col-resize` 与清晰的活动态。
- 使用 `pointerdown`、`setPointerCapture`、`pointermove`、`pointerup` 与 `pointercancel`；不要依赖只支持鼠标的事件。
- 拖动过程中禁止页面文字选中，结束、取消、失焦或组件卸载时必须恢复。
- 使用 `requestAnimationFrame` 合并移动更新，避免每次 pointermove 触发完整 React 树重渲染。
- 每次更新宽度前均重新 clamp；不依赖 CSS overflow 掩盖无效值。
- 右栏折叠、没有 active artifact 或右栏被自动收起时不显示分隔线。
- 不支持“拖到边缘自动折叠”，避免误操作；折叠只由明确按钮触发。

### 4.3 折叠、关闭与恢复

右栏的折叠状态与尺寸状态分离：

```ts
type RightPanelLayoutState = {
  collapsed: boolean;
  widthPx: number | null; // null 仅表示尚未打开过文档，首次按 1:1 初始化
};
```

- 右栏折叠后，现有浮动“展开文档预览”入口继续可用；展开后使用 `widthPx`、同一 artifact 和原预览滚动位置。
- 关闭右栏清除当前 artifact；下次新文档打开使用最后有效 `widthPx`。
- 切换会话继续关闭当前文档，但不重置 `widthPx`。
- 刷新页面后是否记忆宽度不是硬要求。可选择使用 `localStorage`，但必须版本化、解析防护、重新 clamp；不实现也可接受。

### 4.4 键盘与可访问性

分隔线不能是鼠标独占能力：

- 可 Tab 聚焦，使用 `role="separator"` 和 `aria-orientation="vertical"`。
- `aria-label="调整文档预览宽度"`，并暴露 `aria-valuemin`、`aria-valuemax`、`aria-valuenow`（像素宽度）。
- `ArrowLeft` / `ArrowRight` 每次调整 `16px`；`Shift + Arrow` 每次调整 `48px`。
- `Home` 设为最小宽度，`End` 设为最大宽度。
- 只有分隔线拥有焦点时才响应这些键，不影响聊天输入框。
- 展开状态的右上角按钮显示 `收起`，收起后的恢复按钮显示 `展开`；两者保持准确 `aria-label` 与 `title`，不得用 `›` 或 `‹` 代替可见文案。

### 4.5 实现边界

推荐尺寸状态集中在 `ChatShell`：

- 使用 CSS custom property（例如 `--portal-right-panel-width`）或内联 style 为右栏容器分配宽度。
- 对话列保持 `min-width: 0; flex: 1`；消息内容的 `max-w-3xl` 只限制阅读行宽，不应参与列宽计算。
- 建议新增 `ResizableDivider.tsx` 和 `useResizablePanel.ts` 或等价小型 hook，集中处理 clamp、Pointer Events、键盘调整、ResizeObserver 和清理。
- `ArtifactViewer` 继续占满父容器，不自行决定宽度。
- 不增加大型 split-pane/UI 库；原生 Pointer Events 足够且更符合当前 React/Tailwind 架构。

## 5. 代码落点

预计只修改 Portal 前端，不改 Runtime、Relay 协议、SQLite 或 Workspace：

- `src/components/chat/ChatShell.tsx`
  - 拥有右栏宽度与拖拽状态，渲染唯一分隔线。
- `src/components/chat/ArtifactViewer.tsx`
  - 不改变内容逻辑，只继续占满父级右栏。
- 建议新增 `src/components/chat/ResizableDivider.tsx`。
- 建议新增 `src/components/chat/useResizablePanel.ts` 或等价 hook。
- 如需统一 cursor、拖拽防选中样式，可最小修改 `src/app/globals.css`。

明确不修改 `src/components/chat/Sidebar.tsx`，除非只读检查发现必须避免现有 CSS 冲突；不得增加左栏拖拽能力。

## 6. 实施顺序

1. 审计 Portal 工作树、当前右栏 1:1 状态、右栏折叠/关闭语义与上一工作包并行改动；不清理未知变更。
2. 定义右栏宽度状态、常量、clamp 规则和 ResizeObserver 收敛逻辑。
3. 创建可访问的单一 `ResizableDivider` 与 hook，先验证指针和键盘行为。
4. 在 `ChatShell` 接入右栏：首次打开初始化 1:1，后续使用保留 `widthPx`。
5. 处理窗口 resize、极窄窗口、pointercancel、拖拽后组件卸载和焦点恢复。
6. 完成类型检查、构建和桌面浏览器验收；检查 Lightbox、文档侧栏、左栏、会话操作、输入框和滚动。
7. 提交最小 Portal 变更，从干净发布 worktree 走 `scripts/deploy-volcano.sh`。
8. 只读验证火山云入口、Portal PM2、Runtime PM2、111/dyk/mg connector 与日志；不发送真实微信消息。

## 7. 验收清单

| 编号 | 必验结果 | 判定标准 |
| --- | --- | --- |
| B1 | 默认 1:1 | 首次打开文档时，中间对话区与右栏在可用区域内比例为 45:55 到 55:45 |
| B2 | 右栏拖拽 | 唯一分隔线可平滑将右栏调至最小、最大及中间值；不会超过 min/max 或产生横向溢出 |
| B3 | 折叠恢复 | 右上角显示文字按钮 `收起` 且不显示 `›` 小角标；收起后对话区扩展，通过 `展开` 恢复后仍显示同一 artifact、同一右栏宽度和原预览位置 |
| B4 | 文档关闭 | 关闭清除 artifact；下次打开仍采用上次右栏宽度 |
| B5 | 键盘 | 分隔线可 Tab 聚焦，并按 Arrow、Shift+Arrow、Home、End 调整 |
| B6 | 指针健壮性 | 拖拽越过窗口、pointercancel、失焦或组件卸载后，文字选中/光标/监听器均恢复正常 |
| B7 | 窗口变化 | 在 1440x900、1920x1080 以及缩放/调整窗口后，宽度重新 clamp；聊天至少保持 `480px` 或右栏自动折叠 |
| B8 | 左栏无变更 | 左栏宽度、折叠入口和行为与改动前一致，未出现新的左分隔线 |
| B9 | 既有交互 | 会话搜索、会话操作、消息滚动、输入、Markdown/HTML Viewer、SVG/图片 Lightbox 均无回归 |
| B10 | 视觉质量 | 没有重叠、布局跳动、不可点击分隔线、横向页面滚动或被截断的控制文字 |
| B11 | 生产健康 | Portal `/login` 返回 200；Portal、Runtime 和三个 connector 在线；无新的前端异常日志 |
| B12 | 数据保护 | 普通代码发布，未替换生产运行数据/配置，未发送真实微信测试消息 |

### 浏览器证据

至少在以下桌面视口产生截图或可重放浏览器证据：

- `1440 x 900`
- `1920 x 1080`

最小演示路径：

1. 打开已有含 Markdown/HTML artifact 的会话，确认右栏初始 1:1。
2. 将右分隔线拖至最小、中间、最大；折叠并恢复。
3. 用键盘执行 Arrow、Shift+Arrow、Home、End。
4. 打开已有 SVG/图片 artifact 的 Lightbox，确认右栏布局没有影响遮罩、关闭或焦点。
5. 修改窗口尺寸后，再验证 clamp、输入框、左栏和消息滚动。

## 8. 非目标

- 左侧会话栏拖拽、宽度持久化或新分隔线。
- 移动端适配、手势抽屉或响应式重构。
- 自动将拖拽到边缘解释为折叠。
- 新增图片/HTML/Markdown 预览能力或修改其安全策略。
- 保存布局到服务端、跨设备同步、团队共享偏好。
- 改动 Runtime、connector、数据库或 Workspace。
- HTTPS、域名、证书、备案工作。

## 9. 风险与缓解

- **右栏压缩中间对话区**：基于主容器实测宽度集中 clamp；无法满足最小宽度时折叠右栏。
- **拖拽造成频繁重渲染**：用 `requestAnimationFrame` 批处理，Pointer capture 在分隔线本身维护。
- **与现有 1:1 冲突**：只在首次右栏打开时初始化；用户拖拽后不再强制回写。
- **accessibility 缺失**：separator 具备焦点、ARIA 数值和完整键盘调整。
- **共享工作树污染发布**：从干净、已审查 Portal worktree 提交和发布，绝不 reset 现有变更。

## 10. 执行 Agent 交接提示词

```text
请进入目标模式，执行 docs/portal-resizable-sidebars-work-package.md。

只实现桌面 Portal 右侧文档栏的可折叠与可拖拽调宽：对话区和右栏之间只有一条可访问的竖向分隔线；右栏首次打开保持中间对话与右栏约 1:1，用户拖拽后尊重其宽度。保留现有图片 Lightbox、文档侧栏、折叠/关闭语义和所有 artifact 安全处理。

左侧会话栏不在范围内：不得新增左分隔线、拖拽、尺寸状态或修改其既有折叠行为。先审计共享 Portal 工作树，可能已有上一工作包的未提交改动；不得 reset、清理或重做未知变更。按本工作包的布局约束、Pointer Events、键盘细节、验收 B1-B12 和普通代码发布约束执行。仅修改 Portal 前端；不得修改 Runtime/数据库/Workspace，不得发送真实微信测试消息，不得覆盖生产运行数据。
```

## 11. 独立验收 Agent 交接提示词

```text
请独立验收 docs/portal-resizable-sidebars-work-package.md 的执行结果，对 B1-B12 逐项给出 Pass/Partial/Fail 和证据。

必须在 1440x900 与 1920x1080 实测唯一右分隔线的鼠标/Pointer 及键盘行为、最小最大 clamp、折叠恢复、文档关闭、窗口变化和已有 Artifact Viewer/Lightbox/聊天输入回归。重点检查拖拽结束后的焦点、文字选中、监听器和页面横向溢出。确认左侧会话栏没有新拖拽能力或行为变化，并确认发布仅同步代码且火山云 Portal、Runtime 与三条 connector 在线。不要只凭静态代码或截图直接判定通过。
```
