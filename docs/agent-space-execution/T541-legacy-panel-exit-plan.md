# 旧聊天右侧「工作空间」面板退出方案（T-541 交付，方案非实施）

状态：**方案文档。移除本身属于生产发布授权任务范围，本文件不授权实施。**

## 1. 现状盘点

旧面板链路：`ChatShell.tsx:1257` 挂载 `DocumentWorkspace`（`components/chat/DocumentWorkspace.tsx` + `LibraryTree.tsx`）→ `GET /api/workspace/files` + `/api/workspace/files/content` → connector `workspace.file.list / workspace.file.get`（`src/routes/portal.ts` HTTP 面实现）。浏览器只读文件树 + 多标签查看器。

当前真实承载的使用场景与替代路径对照：

| 场景 | 旧面板能力 | 替代路径 | 差距 |
| --- | --- | --- | --- |
| 会话内看 AI 生成的报告/附件 | 附件卡片 + ArtifactViewer 内联预览（Markdown/HTML/图片内联，其余侧栏预览） | **已由附件/产物卡片承担**（不依赖旧面板） | 无 |
| 浏览我的文件库 | 左侧文件树（workspace files） | `/assets` 我的文件页（列表/搜索/文件夹/预览/下载/来源筛选） | 无核心差距；文件树形态不同（列表 vs 树，两层文件夹限制相同） |
| 会话中途快速打开一个历史文件 | 面板内直接打开 | 到 /assets 打开（多一次导航） | 轻微体验差异，可接受 |
| 查看 config 类原始文件（portfolio.yaml 等） | 面板可浏览 workspace 根 | /assets 的对话保存类目录同样可查（开发期 config 可交付） | 无 |
| 方法/Skill 文件查看 | 面板树内可见 | `/workspace` 我的方法/我的 Skills（版本化 + 详情正文） | **更强**（语义入口 + 版本链） |

结论：旧面板没有不可替代能力；其价值只剩「会话页内少一次导航」。

## 2. 移除步骤（生产发布授权任务内执行）

1. **前端**：`ChatShell.tsx` 移除 `DocumentWorkspace` 挂载与展开/收起按钮（含面板宽度状态）；删除 `DocumentWorkspace.tsx`、`LibraryTree.tsx`；`chat/api.ts` 的 workspace files 两个 fetch 封装一并删除。
2. **后端 API（保留一个发布周期后删）**：
   - 第一阶段：`apps/portal/src/app/api/workspace/files/*` 两个 route 返回 410 Gone（带指引文案「请到我的文件/工作空间查看」）；connector 的 `workspace.file.list/get` 保留（其他调用方核查后决定）；
   - 第二阶段（一个观察周期后）：删除 connector handler、`src/routes/portal.ts` 对应端点与 capabilities 中的 `workspace.file.*`。
3. **文案与提示**：移除后首次版本在 /assets 页顶部放一条一次性提示（「聊天右侧文件面板已并入我的文件」），避免用户找不到入口。
4. **保留不动**：`FilePanelProvider` 的资产预览（xlsx/文本预览走我的文件的版本读链）与会话附件预览——它们不属于旧面板。

## 3. 回滚方式

- 前端组件删除走正常代码回滚（发布快照/回滚 SOP）；
- API 两阶段设计保证第一阶段可即时恢复（410 → 恢复 route）；
- 无数据迁移、无 schema 变化——回滚零数据风险。

## 4. 需要保留的预览体验确认点（owner 复核）

- [ ] 会话内 AI 产物的内联预览（Markdown/HTML/图片/SVG）不受影响（走 ArtifactViewer，已验证与旧面板无关）；
- [ ] xlsx 预览（WorkbookPreview）在 /assets 可用；
- [ ] 用户是否需要「会话页内固定文件侧栏」的等价快捷体验（当前判断：不需要，/assets 一次导航可接受）。
