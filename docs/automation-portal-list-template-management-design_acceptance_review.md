# 自动化 Portal 列表、模板与批量管理验收记录

> 验收日期：2026-08-06
>
> 验收依据：[automation-portal-list-template-management-design.md](./automation-portal-list-template-management-design.md)、用户对自动化、我的文件和聊天输入框的浏览器反馈，以及两个正式仓库的当前工作树。

## Acceptance Verdict

Status: Pass with caveats

任务/运行双视图、服务端筛选与分页、模板预填创建、批量生命周期动作、归档保留、范围隔离和用户文件页均已落地；Portal 与 Runtime 的完整验证均通过。根据用户后续反馈，列表页只保留一个“新建任务”主入口，模板能力保留为低优先级的“模板示例”，创建表单将输入/产物/输出方式收敛为任务说明下的可选 CSV/XLSX 附件和微信推送开关。剩余 caveat 是当前浏览器控制面不提供设置 390×844、768×1024 和 1440×900 视口的能力，因此本轮对响应式的证据来自 CSS 断点静态检查和当前页面无横向溢出检查，而不是三种精确视口截图。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 路由 | `/automations` 与 `/automations/runs` 可通过页签切换、刷新并恢复 URL 视图 | Pass | `src/app/automations/page.tsx`、`src/app/automations/runs/page.tsx`；浏览器回归两条 URL；导航链接带 `aria-current="page"` | 页签是实际链接，不是装饰性按钮 |
| 任务列表 | 搜索、状态/频率/投递/产物筛选由服务查询，且返回最近运行摘要 | Pass | `src/components/automation/AutomationWorkspace.tsx` 的 `fetchAutomations(query)`；`src/services/automation-tasks.ts` 的 `latestRunsByTask`；Portal `automation-portal.test.ts`；浏览器确认 `outputModes=update` 写入 URL | 未发现逐任务请求运行历史的 N+1 实现 |
| 任务列表 | 全宽轻量列表、需要处理优先、失败红色文字、相对/绝对下次时间和行内更多菜单 | Pass | `AutomationWorkspace.tsx` 的 `TaskRow`、`statusMeta`、`formatRelative`；浏览器截图 | 任务行更多菜单包含编辑、查看详情、立即运行一次、暂停/启用、归档 |
| 运行记录 | 全局运行记录按北京时间自然日分组，可搜索/筛选/分页 | Pass | `RunListViewFiltered`、`groupRunsByDate`；Runtime `listAutomationTaskRuns` 查询和 cursor；浏览器确认 `statuses=failed` 写入 URL | 日期边界由 Portal 转换为 Asia/Shanghai ISO 范围 |
| 运行详情 | 保留失败原因、任务版本、尝试次数、输入/结果文件、微信投递、下载、继续对话和查看任务 | Pass | `RunDetailViewAccurate`；`src/app/automations/runs/[runId]/page.tsx`；对应 API routes | 结果文件现可通过“查看结果文件”进入 `/assets?assetId=...`，也保留下载按钮 |
| 历史一致性 | 历史运行使用当时 revision 名称，仅有 attempt/recovery 证据时显示“恢复后成功” | Pass | `AutomationTaskRunRecord.taskName`、`runStatus`、`attempt`；`tests/automation-tasks.test.ts` 的 global run history 测试；Runtime 分页 cursor 携带 attempt | UI 不根据普通成功状态猜测恢复 |
| 模板 | 有 6 个静态模板，卡片进入同一可编辑创建页，模板不直接启用 | Pass | `src/lib/automation-templates.ts`；Portal 模板 schema 测试；浏览器计数为 6，`weekly-research-digest` 显示完整 instruction | 列表页只把模板作为次级示例入口，符合用户“只有一个通用新建任务主入口”的反馈 |
| 创建页 | 用户只需填写名称、说明、可选 CSV/XLSX 附件、执行时间和微信推送开关；保存为暂停 | Pass | `EditorView`；浏览器确认没有“产物输出/输入产物/输出方式”等旧字段，`accept=.csv,.xlsx`；Runtime 创建合同测试 | 模板必要附件条件仍会就地提示 |
| 批量管理 | 暂停、启用、归档支持逐项结果、部分失败、revision/busy 失败和审计 correlation | Pass | `batchAutomationTaskAction`；`src/app/api/automations/batch-action/route.ts`；`tests/automation-generic-tasks.test.ts`；Portal 公共页头和移动端“更多”入口 | 启用和归档有二次确认，失败项保留勾选 |
| 批量授权 | 启用前汇总频率、资料读取、产物更新和微信推送；服务仍逐项执行原有校验 | Pass | `TaskListView.doBatch`；`setAutomationTaskStatus` 的 needs-attention、scope、revision 和 busy 校验 | `needs_attention` 不能直接启用 |
| 归档 | 归档停止未来调度，保留 revision、运行、产物和审计，默认列表隐藏 | Pass | `archive` 路由与 Runtime `setAutomationTaskStatus`；`tests/automation-tasks.test.ts` 的 archived 测试；文件页默认未归档截图 | 任务归档后详情只读；恢复未在首期开放 |
| 安全边界 | 列表、运行、批量和资产按 user/project/instance scope 隔离，响应不暴露内部 scope/path | Pass | Runtime connector scope tests、`automation-portal-contract.test.ts`、`user-assets-portal-contract.test.ts`；Portal sanitizer | 没有通过 Portal 直读 SQLite 或 Workspace 的路径 |
| 我的文件 | 页面命名为“我的文件”，默认未归档，归档入口弱化，支持上传/搜索/预览/改名/下载/归档 | Pass | `src/components/assets/AssetLibraryShell.tsx`；浏览器确认 `未归档` 默认选中、`查看已归档文件` 次级入口；无版本管理主入口 | 结果文件可带 `assetId` 回到文件页并自动尝试打开 |
| 聊天输入 | 长文本输入框按行数自动伸展，达到上限后内部滚动，清空后收回 | Pass | `src/components/chat/MessageComposer.tsx` 的 `useLayoutEffect`；浏览器实际测量 `40px → 160px → 40px` | 上限为 176px |
| 响应式 | 桌面完整列表、移动端不横向溢出，移动端模板/批量收入更多 | Partial | CSS `sm`/`lg` 断点；当前浏览器页面 `document.documentElement.scrollWidth <= innerWidth`；移动端入口代码为“更多” | 当前浏览器控制面无法设置精确三种设计视口，缺少 390/768/1440 的截图证据 |

## Findings

- [P2] 精确响应式截图未完成：当前浏览器连接没有暴露 viewport 设置能力。本轮已检查断点类名、移动端“更多”分支和当前视口无横向溢出，但仍应在具备视口模拟能力的浏览器/CI 中补跑 390×844、768×1024、1440×900。
- [P3] 批量请求的 `idempotencyKey` 已做格式校验并传递到 Runtime，但没有单独的批量请求持久化表；当前审计使用同一 `correlationId` 追踪逐项结果。设计文档明确无需新增表，故不作为本轮阻塞项。

## Verification Performed

- Portal：`npm run typecheck` 通过。
- Portal：`npm test`，21/21 通过。
- Portal：`npm run build` 通过。
- Portal：`git diff --check` 通过。
- Runtime：`npm run verify` 通过：384 tests passed、Agent context 检查通过、TypeScript build 通过、boundary tests 7/7 通过。
- Runtime：PM2 `invest-agent-codex` 重载后 `GET http://127.0.0.1:22655/health` 返回 `{"status":"ok"}`。
- Portal：当前 3100 端口由正式仓库 `/Users/combo/MyFile/projects/invest-agent-portal` 的 `tsx watch server.ts` 开发进程提供，并已回归 `/automations`、`/automations/runs`、`/automations/templates`、`/automations/new?template=weekly-research-digest`、`/assets` 和 `/chat`；指向 `test-projects/invest-agent-portal-m` 的错误 PM2 应用已保持停止，不作为实现或验收证据。
- 浏览器：验证页签 `aria-current`、任务/运行筛选 URL、6 个模板、完整模板指令、附件 accept、无横向溢出、文件默认归档状态和聊天 textarea 实际高度变化。

## Follow-Up Checklist

- [ ] 在支持 viewport emulation 的浏览器或 CI 中补跑并保存 390×844、768×1024、1440×900 截图。
- [ ] 若后续要求严格的批量重放语义，再为 `idempotencyKey` 增加可持久查询/回放契约；当前设计只要求 key 校验和审计 correlation。

## 2026-08-06 后续复核

### Acceptance Verdict

Status: Pass with caveats

本次复核确认前一轮实现仍可构建、测试和运行；并补验了旧版 CSV/XLSX 任务从 Portal 编辑后的资产绑定保留，以及文件上传弹层的键盘交互。用户反馈对应的产品收敛仍保持：自动化是通用任务，创建任务只要求名称、说明、可选 CSV/XLSX 附件、执行时间和微信推送；文件入口为“我的文件”，默认隐藏归档；聊天输入框按内容自动伸展。未解决的唯一验收 caveat 仍是当前浏览器控制面无法生成 390×844、768×1024、1440×900 三种精确视口截图。

### 增量证据

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 旧任务兼容 | 编辑旧版 CSV/XLSX 任务不能丢失原有 source/working asset 绑定 | Pass | `src/components/automation/AutomationWorkspace.tsx`；`tests/automation-tasks.test.ts` 的 legacy revision update 测试；Runtime `npm run verify` | 旧版任务继续提交旧版更新契约，不会被通用字段覆盖 |
| 弹层可访问性 | 上传弹层支持 Escape、焦点进入、Tab 限制和关闭后焦点恢复 | Pass | `src/components/assets/AssetLibraryShell.tsx`；浏览器验证“关闭上传”获得焦点、Escape 关闭、焦点恢复到“上传文件” | 上传弹层声明 `role="dialog"` 和 `aria-modal` |
| Portal 回归 | 类型检查、测试、生产构建和差异检查通过 | Pass | `/Users/combo/MyFile/projects/invest-agent-portal`：`npm run typecheck`、`npm test` 21/21、`npm run build`、`git diff --check` | 构建输出包含自动化、运行、模板、资产和聊天路由 |
| Runtime 回归 | 完整验证和边界检查通过 | Pass | `/Users/combo/MyFile/projects/invest-agent-ideal`：`npm run verify`；384/384、boundary 7/7 | 未触碰生产环境、SQLite、Workspace 或微信状态 |
| 页面回归 | 自动化、运行记录、模板、创建、我的文件、聊天页面可访问且文案符合当前方向 | Pass | 浏览器 DOM 回归：`/automations`、`/automations/runs`、`/automations/templates`、`/automations/new`、`/assets`、`/chat` | 当前空数据状态下未伪造任务详情或运行详情；详情逻辑由既有测试和代码审查覆盖 |

### Verification Performed

- Portal `npm test`：21/21 通过。
- Portal `npm run build`：通过。
- Portal `git diff --check`：通过。
- Runtime `npm run verify`：384/384 测试、Agent context、TypeScript build、7/7 boundary tests 全部通过。
- 浏览器：运行记录页按日期空状态、自动化列表单一主创建入口、6 个模板、简化创建字段、我的文件默认未归档、聊天输入框和关键导航均完成 DOM 回归。
- 浏览器：上传弹层焦点进入关闭按钮，Escape 关闭后恢复到上传入口；长文本 textarea 已验证自动增高、达到上限后内部滚动、清空后恢复初始高度。

### Remaining Follow-Up

- [ ] 在支持 viewport emulation 的浏览器或 CI 中补跑并保存 390×844、768×1024、1440×900 截图。

## 2026-08-06 独立复验

### Acceptance Verdict

Status: Pass with caveats

本轮未采信此前验收结论，重新对照设计第十二节检查了两个正式仓库、协议测试、构建产物和 Portal 页面。任务与运行双视图、服务端查询与 scope 隔离、历史 revision 名称、模板预填、批量部分成功、归档留存和既有详情能力均有直接代码与测试证据。Portal 在 1440×900、768×1024、390×844 三个精确视口均没有横向滚动；但 390px 下“批量管理”和“模板示例”仍常驻页头，未按设计收进“更多”菜单，且任务行的窄屏布局实际为多行字段堆叠而非设计要求的稳定两行。因此不满足无条件通过标准。

### Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 路由与列表 | 任务/运行 URL 双视图、搜索筛选、cursor 与最近运行摘要 | Pass | Portal `AutomationWorkspace.tsx`、`fetchAutomations`；Runtime `listAutomationTaskPage`、`latestRunsByTask` | 任务列表单次请求带 `latestRun`，未发现逐任务运行历史请求。 |
| 全局运行 | 当前 scope 的运行时间线、北京时间分组、历史 revision 名称和恢复标识 | Pass | Runtime `listAutomationTaskRunsPage` JOIN revision；`tests/automation-tasks.test.ts`；Portal `groupRunsByDate`、`runStatus` | `attempt > 1` 才显示“恢复后成功”。 |
| 模板创建 | 6 个静态模板、可编辑预填、创建保持 paused | Pass | Portal `automation-templates.ts`、`automation-portal.test.ts`；`/automations/templates` 和模板创建页浏览器检查 | 6 个 preset 均通过创建 schema，模板不承载 runtime 权限。 |
| 批量生命周期 | 暂停/启用/归档逐项执行，保留部分失败和 correlation 审计 | Pass | Runtime `batchAutomationTaskAction`；`automation-generic-tasks.test.ts`；Portal batch API/UI | `needs_attention` 和运行中任务不能被误启用/归档。 |
| 归档与隔离 | 停止未来调度、保留历史；跨 user/project/instance 拒绝 | Pass | `archiveAutomationTask` 测试；Portal connector contract tests；response sanitizer | 未发现 Portal 读取本地 SQLite 或 Workspace 的路径。 |
| 既有能力 | 任务详情、运行详情、产物入口、下载和继续对话保留 | Pass | `TaskDetailView`、`RunDetailViewAccurate`、Portal 路由构建产物 | 本轮未对当前空数据账号写入真实任务；行为由现有契约测试和代码路径复核支持。 |
| 响应式 | 1440×900、768×1024、390×844 无横向溢出；移动端收敛控制并使用两行任务布局 | Partial | 三个精确视口的浏览器 `scrollWidth === innerWidth` 检查；390px 截图；`AutomationHeader`/`TaskRow` | 390px 下“批量管理”和“模板示例”仍可见，同时出现“更多”；窄屏任务行也不是设计指定的稳定两行布局。 |
| 构建与测试 | Portal typecheck/test/build，Runtime verify | Pass | 本轮命令结果 | Portal：21/21；Runtime：384/384，agent-context、TypeScript build、boundary 7/7 均通过。 |

### Findings

- [P2] 390px 的移动端操作区未按设计收敛：`AutomationHeader` 中的 `hidden sm:inline-flex` 被 `.btn-secondary` 的显示样式覆盖，导致“批量管理”和“模板示例”仍显示在页头；`TaskListView` 的“更多”菜单同时重复提供这两个操作。此问题直接偏离 7.1 的移动端要求，并增加紧凑屏幕的认知负担。
- [P2] 窄屏任务行不是稳定两行：`TaskRow` 在 `<640px` 仍逐项渲染执行规则、最近一次、下次执行和状态，形成多行堆叠。虽然本轮没有横向溢出，但未达到设计约定的两行扫描布局。

### Verification Performed

- Portal `/Users/combo/MyFile/projects/invest-agent-portal`：`npm run typecheck`、`npm test`（21/21）、`npm run build`、`git diff --check` 通过。
- Runtime `/Users/combo/MyFile/projects/invest-agent-ideal`：`npm run verify` 通过，384/384 tests、agent-context、TypeScript build、boundary 7/7 通过。
- 浏览器：`/automations`、`/automations/runs`、`/automations/templates`、`/automations/new?template=weekly-research-digest` 在 1440×900、768×1024、390×844 下均无横向滚动；390px 实测页头操作重复显示。

### Follow-Up Checklist

- [ ] 修正 390px 的 header 显示优先级：只保留“新建任务”，将模板和批量管理保留在“更多”菜单。
- [ ] 将 `<640px` 的任务行压缩为两行布局，并复测长中文任务名、状态和下次时间。

## 2026-08-06 修复后复验

### Acceptance Verdict

Status: Pass

此前独立复验中的两项移动端 P2 已修复。390px 页头现在只显示“新建任务”和“更多”，模板与批量管理只在“更多”菜单中提供；768px 与 1440px 保持三项直接操作。任务行在 `<1024px` 使用紧凑摘要布局，将任务状态放在标题行、执行规则与最近结果合并为副信息、下次执行固定在右侧，桌面稳定网格不变。

### Verification Performed

- Portal：`npm run typecheck`、`npm test`（21/21）、`npm run build`、`git diff --check` 通过。
- 浏览器：390×844 显示的操作仅为“新建任务”“更多”，展开“更多”后可访问“模板示例”“批量管理”，无横向滚动。
- 浏览器：768×1024 和 1440×900 显示“批量管理”“模板示例”“新建任务”，均无横向滚动。

### Resolved Findings

- [Resolved P2] 移动端 header 的 `.btn-secondary` 显示样式不再覆盖隐藏断点；次级操作由无按钮样式的断点容器控制。
- [Resolved P2] 任务行的非桌面布局不再逐项堆叠独立列，状态与下次执行保持可见。
