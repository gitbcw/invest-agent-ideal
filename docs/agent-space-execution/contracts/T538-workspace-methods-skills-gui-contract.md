# T-538 实施契约：工作空间我的方法与我的 Skills GUI（P1）

任务：os-mcp T-538（executor: agent）。前置：T-537（本文档引用的基线均已就绪）。
设计依据：[正式设计 §3/§4/§5](../../agent-space-user-product-design.md)；差距：[T537-gap-analysis D2/A1/A2/U1/U2/U3](../T537-gap-analysis.md)。

## 目标

在 111 隔离环境实现「工作空间」页面（我的方法 / 我的 Skills 双 Tab，默认方法）与侧栏入口，并为「我的文件」补关联信息；agent_space 对象获得第一条 connector API 面。内容版本与运行生效分离在页面上清晰可辨。

## 输入

- 隔离环境：`.state/agent-space-p0/`（[启动与自检方式](../T537-p0-baseline.md#2-隔离本地验证环境)；runtime 23660 / Portal 3110 / primary 测试身份绑 111）。
- 服务层：`src/services/agent-space/methods.ts`（createMethod/addMethodVersion/approveMethodVersion/listUserMethods/readMethodVersionContent）、`skills.ts`（upsertSkill/addSkillVersion/publishSkillRelease/listSkillCatalog/derivePrivateSkillFromRelease/listDefaultReleases）、`agents.ts`（installSkill/bindMethod）。
- 前端基座：`apps/portal/src/components/chat/Sidebar.tsx`（导航入口）、`/assets` 页（`AssetLibraryShell.tsx` + `assets/api.ts`，references 等 API 已有 UI 未接）。

## 工作内容

1. **connector 协议扩展**（`src/lib/protocol/envelope.ts` PORTAL_TYPES + `src/portal/connector.ts` + Portal 侧 route）：
   - `method.list / method.get / method.versions / method.diff / method.create / method.add_version / method.adopt / method.revoke`；
   - `skill.list_private / skill.list_installed / skill.get / skill.create / skill.edit / skill.compare_versions / skill.set_enabled / skill.install / skill.uninstall / skill.upgrade`；
   - scope 全部从 connector 注册 scope 派生，响应 redact 内部 scope/checksum 字段（沿用 `automation-api.ts` 模式 + zod 拒绝浏览器提交 scope）。
2. **111 隔离数据构造**（`scripts/agent-space/p0/seed-workspace-objects.mjs`，经服务层 API，不手写表行）：
   - 从容器 `methods/strategy-rules.md` 构造 1 个方法体系（≥2 个版本，其中 1 个已采用、1 个待确认），并绑定到 1 个 111 自动化任务；
   - 从容器 `skills/*/SKILL.md` 构造 ≥2 个私有 Skill（≥1 个已安装启用）与 ≥1 个系统 release 安装态；
   - 构造后 verify-isolated.mjs 的空集断言改为「期望对象存在」断言（保留对未构造 scope 的空集检查）。
3. **Portal 页面**：`/workspace`（`我的方法` 默认 Tab + `我的 Skills`）；方法列表卡片（名称/用途/采用状态/最近变更/绑定任务数/待确认版本）、方法详情（版本时间线/Diff/恢复入口/被任务使用/关联资料跳转/创建编辑入口）；Skills 两区块列表 + 详情（启停/安装/升级/版本比较）；侧栏新增「工作空间」入口（集中定义导航项，消除三页漂移）。
4. **我的文件关联升级**：文件详情/列表补「来源（上传/对话/自动化）、被哪些自动化读写（references）、报告所属任务结果」；方法/Skill 来源只跳转 `/workspace` 对应 Tab，不提供第二编辑入口。

## 边界（红线）

- 不实现市场浏览/推荐中心；不暴露 scope/checksum/run-basis/工具授权；不把保存写成生效（adopt/install/enable 必须是显式动作且服务端强制）。
- 不改生产、不部署、不触碰真实用户资产；一切验证在隔离环境。
- 不引入旧 Workspace 文件树/容器语义（页面只是 GUI，不是数据容器）。

## 验收

- verify-isolated 全过 + 新增断言过：111 方法/Skill 对象经 API 可读，未构造 scope 仍 0 行；
- 浏览器走查（隔离环境）：工作空间双 Tab 可达、方法卡片字段齐全、Diff 可看、采用动作改变状态且需确认、任务绑定显示版本；Skills 启停/安装/升级为显式操作且失败有终态提示；
- 文件页关联信息可跳转且无双重编辑入口；
- 单元/协议测试：method.*/skill.* 消息的 scope 派生与 redact（参照 `tests/automation-portal.test.ts` 形态）；
- `npm test` 全绿（隔离套件不依赖网络与生产）。

## 失败与上报

- 服务层函数不足以支撑读模型（例如方法-任务绑定计数无查询面）时：优先加服务层只读聚合函数，不改表结构；仍不足则停止并报告具体缺口，不得手写 SQL 绕过 scope 校验。
- 容器文件导入方法/Skill 的语义有歧义（版本归并、采用状态）时：按「新对象、来源标记容器迁移、默认未采用」处理并在报告注明，等 owner 裁决。
