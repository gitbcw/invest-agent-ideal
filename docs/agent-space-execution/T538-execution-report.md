# T-538 执行报告：工作空间我的方法与我的 Skills GUI（P1）

状态：**执行完成，验收点全部达成。** 日期：2026-09-21。
契约：[T538-workspace-methods-skills-gui-contract.md](./contracts/T538-workspace-methods-skills-gui-contract.md)。

## 交付内容

### 1. connector 协议扩展（runtime 侧）

- `apps/portal/src/lib/protocol/envelope.ts`：PORTAL_TYPES 新增 method.*×8、skill.*×10、asset.workspace_usage，错误码 union 新增 AGENT_SPACE_* 13 项（与 connector 本地 TYPES 逐键对齐）。
- `src/portal/connector.ts`：18+1 个 handler case；载荷规整 helpers（workspaceString/Text/Constraints/ActionKey）；`agentSpaceCall` 统一 AgentSpaceError 透传；`requiresCurrentProtocol` 与「浏览器 scope 字段拒绝」守卫覆盖 method.*/skill.*；capabilities 广播补 19 个命令。
- **scope 纪律**：全部 scope 从注册 connector 派生（`automationScope` 模式）；浏览器载荷经 zod `.strict()` 拒绝（实测 `userId` 注入 → INVALID_REQUEST/unrecognized_keys）。

### 2. 服务层（portal-actions）

- `src/services/agent-space/portal-actions.ts`（约 1400 行）：GUI 读模型（方法卡片/详情/版本/Diff、Skill 两类卡片/详情/比较、资产用途反查）+ 显式动作（create/add_version/adopt/readopt/retire、skill create/edit/approve/install/uninstall）+ `registerPortalActionAuthorization` 凭证登记。
- `src/services/agent-space/index.ts` re-export。
- **修复两个实现缺陷**：`listPortalAgents` 列名映射缺失（agentId 运行时为 undefined，导致安装 NOT NULL——已修为显式 camelCase 映射并加回归测试）；asset.workspace_usage 消息在 connector 的接线（TYPES/handler/capabilities）。

### 3. Portal 前端

- `/workspace` 页面（`components/workspace/`：WorkspaceShell 双 Tab 默认方法、MethodsPanel 列表+详情+编辑+采用/恢复+Diff+任务使用+关联资料跳转、SkillsPanel 两区块+详情+启用/安装/升级/卸载、api.ts 封装）。
- API routes：`/api/methods*`（4 个）、`/api/skills*`（3 个）、`/api/assets/[assetId]/workspace-usage`；`lib/workspace-api.ts` + `lib/workspace-schemas.ts`（strict）。
- 侧栏：`Sidebar.tsx` 新增工作空间入口（主导航+顶部图标）、`PortalSidebar` 支持 `active="workspace"`。
- 我的文件关联升级：`AssetLinksDialog`（来源/被自动化引用 references/被方法与 Skill 引用 workspace-usage，只跳转不二次编辑）挂入文件行「更多操作」菜单。
- 错误状态映射：`error-status.ts` 补 AGENT_SPACE_* → HTTP status。

### 4. 111 隔离数据构造

`scripts/agent-space/p0/seed-workspace-objects.mjs`（护栏：DB_PATH 必须指向 agent-space-p0；全部经服务层 API，不手写表行）：
- 方法体系 ×1：v1 采用→v2 采用（v1 superseded）→v3 待确认草稿；绑定 daily-review 任务（pinned v2）。
- 私有 Skill ×2：p0-fundamental-analysis（启用 v1+安装）、p0-technical-analysis（草稿态）。
- verify-isolated.mjs 断言更新：空集断言 → 「方法≥1/Skill≥2」断言。

## 验证证据

- **typecheck**：主仓 + apps/portal 双侧 `tsc --noEmit` 零错误。
- **测试**：主仓 `npm test` 740/740 全绿（新增 `tests/agent-space-portal-actions.test.ts` 5 例：生命周期「保存≠生效」/跨域读写拒绝/幂等回放与凭证不可复用/Skill 全链路/agentId 映射回归）；Portal 53/53 全绿（新增 `apps/portal/tests/workspace-portal.test.ts`：协议全集、scope 字段拒绝、enable 只接受 true、错误码映射）。
- **隔离环境端到端**（start-isolated + verify 14/14 全过）+ curl 走查：method.list 卡片字段齐全（当前 v2/待确认 v3/任务绑定 1/版本 3）、method.get 三版本+任务使用+正文、skills private/installed 两区块数据正确、scope 注入被 strict 拒绝。

## 与契约的偏差（如实记录）

1. **系统/市场 release Skill 未构造**：系统域发布需 owner token，隔离环境无发布数据（生产 releases=0）。已安装 Skills 区块以私有安装呈现（install/uninstall/upgrade 代码路径完整，「显式升级 release」路径待真实 release 数据后验证——留给 T-541 验收清单标注）。
2. **SKILL_SET_ENABLED 首版只支持启用（enabled=true）**：停用语义经卸载表达（服务层无 disable 状态转换；connector 对 enabled=false 返回 AGENT_SPACE_UNSUPPORTED 并说明）。
3. **GUI 凭证通道**：采用/安装/启用动作经 `registerPortalActionAuthorization`（source_kind='portal'，幂等 ref=portal:<userId>:<idempotencyKey>，消耗/回放/绑定校验复用既有 authorization 机制）——这是 P0 范围的定向底座修订（设计 §10 允许并要求记录），未绕过 scope/版本/审计约束。
4. 浏览器截图验收不在本任务（契约明确归 T-541）；页面代码经 typecheck 与 API 走查验证。

## 遗留到后续任务

- T-539：侧栏「待处理」入口（本任务只加了工作空间入口）。
- T-541：浏览器完整走查 + release 升级路径验证。
