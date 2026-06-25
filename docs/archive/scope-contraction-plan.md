# 项目范围收敛计划

**起草日期**: 2026-06-23
**定位**: 精品投资助手,**少数几个投资客户,每人一个 Workspace**。不是多产品 AI 平台。

## 背景

代码盘点(src/ 非测试代码 24,650 行)发现,项目实际承载了至少 6 套超出当前定位的职责:多产品平台框架、饮食推荐第二产品线、旧 Runtime 草案、L3 复合指标 DSL、复盘视角追踪、并行微信桥。

本计划只砍与"少数客户精品投资助手"定位**直接冲突**的部分,**保留** L3a/L3b 复合指标系统(WP B,后续单独评估)。

## WP A — 删三个独立子系统

目标:砍 ~3-4k 行独立模块,不涉及核心投资链路。

### A1. 删饮食推荐整个产品线

不同产品,应该独立成项目,不寄生在本 repo。

涉及文件(7 个,~66 处引用):
- `src/channels/weixin-mobile.ts` — 删 `dietWeixinMobileManager` 实例化 + diet 相关分支
- `src/server.ts` — 删 `/api/diet-weixin/*` 路由(5 个)+ `/admin/diet-weixin` 后台页
- `src/platform/project-registry.ts` — 删 `DIET_RECOMMENDATION_*` 常量 + `ensureBuiltInAiProjects` 里的 diet project 注册
- `src/platform/project-types.ts` — 删 `DIET_RECOMMENDATION_PROJECT_TYPE_ID` + 对应 manifest
- `src/platform/skill-bundles.ts` — 删 `DIET_RECOMMENDATION_DEFAULT_SKILL_BUNDLE_ID` 相关 bundle
- `src/admin/platform-page.ts` — 删 diet 相关 UI
- `src/acp/mobile-prompt.ts` — 清理 diet-recommendation profile 分支

DB 兼容:`ai_projects` / `ai_instances` 表里 diet 相关历史行不删,只是不再注册新的。

### A2. 删 BypassWeixinMobileBridge 旁路桥

刚才改名为 Bypass 是为了避免误导,但定位下根本不需要"并行测试通道"。主桥 + 多 Workspace 路由就够。

涉及文件(5 个):
- `src/channels/weixin-mobile.ts` — 删 `BypassWeixinMobileBridge` 类 + `bypassWeixinMobileManager` 实例化
- `src/server.ts` — 删 `/api/bypass-weixin/*` 路由(5 个)+ `/admin/bypass-weixin` 后台页 + `BYPASS_WEIXIN_AUTO_START` env 检查 + push-queue `backend === "hermes"` 分支(改成默认走主桥)
- `src/index.ts` — 删 shutdown 时的 `bypassWeixinMobileManager.stop()`
- `src/routes/sandbox.ts` — 删 `bypassWeixinMobileManager` 引用 + push backend 选择逻辑
- `src/acp/mobile-prompt.ts` — 删 `/api/bypass-weixin` 提及

DB 兼容:push-queue 历史 job 里 `backend==="hermes"` 的记录会查不到对应通道,直接 fallback 主桥即可(可以加一行 warn 日志)。

### A3. 删 conversation-task 草案系统

旧 Runtime 残留,理想型重构说推理全交给 Codex,这套 Draft 机制是过渡期产物。

涉及文件(7 个,核心 916 行):
- `src/lib/conversation-tasks.ts` — **整文件删除**(916 行)
- `src/channels/weixin-mobile.ts` — 删 `handlePendingConversationTaskTurn` / `handleAiIntentDraftTurn` 调用点
- `src/db/schema.ts` — 保留 `conversationTasks` 表定义(数据不迁出),但所有写入路径删除
- `src/db/index.ts` — 删 `conversation_tasks` 表的初始化/索引(表本身保留作考古)
- `src/lib/data-backend.ts` / `src/lib/workspace-store.ts` / `src/routes/dashboard.ts` — 删 conversation-task 相关引用

**风险评估**:conversation-task 是过去主链路里"AI 意图识别后落库待执行"的中间层。删除前要确认 Codex ACP 已经接管了所有原本走 conversation-task 的场景。删除后,所有用户消息直接进 Codex,没有中间 Draft 步骤。

## WP C — platform/ 多项目框架拍扁为 Workspace 极简模型

目标:把 platform/ 4 个文件 + `ai_projects` / `ai_instances` / `investment_profiles` 三张表的复杂抽象,简化成"每客户一个 Workspace"的单一概念。改 + 砍 ~2-3k 行。

### 当前过度建设

```
Project (多产品:type=diet-recommendation | invest-agent | ...)
  └─ Instance (多实例:invest-agent-primary | invest-agent-jr-ideal | diet-recommendation-shared | ...)
       └─ SkillBundle (多 bundle:invest-agent-default | invest-agent-mg-custom | ...)
            └─ Tool / Strategy / Plan / Portfolio / Watchlist / Alert
```

`investment_profiles` 还试图支持"同一客户多个投资风格 profile",但记忆里写"不引导配仓位/不存金额",profile 实际从未真正启用。

### 目标模型

```
Workspace(每客户一个)
  ├─ userId(主键,跟微信账号绑定)
  ├─ instanceId(= userId,或客户起的别名,用于数据隔离)
  └─ 数据(持仓/自选/预案/提醒/复盘/策略,全部按 instanceId 隔离)
```

- `projectType` 字段移除(只剩 invest-agent,不再分支)
- `skillBundleId` 字段移除(每 workspace 用同一套默认 SKILL 集)
- `hermesProfile` 字段移除(Hermes 已退场)
- `investment_profiles` 表整个作废(精简客户模式不需要)

### 涉及文件

- `src/platform/project-registry.ts` — 大幅瘦身,保留 `getProjectRuntimeContext` 但返回固定 `projectType: "invest-agent"`、`skillBundleId: "invest-agent-default"`
- `src/platform/project-types.ts` — **整文件删除**(单产品不需要多 type)
- `src/platform/skill-bundles.ts` — **整文件删除**(单 bundle)
- `src/platform/tool-registry.ts` — 评估保留与否(可能也没用了)
- `src/db/schema.ts` — `aiProjects` / `aiInstances` / `investmentProfiles` 表保留数据但标记 deprecated;新增轻量 `workspaces` 表(或直接复用 settings KV)
- `src/admin/platform-page.ts`(679 行)— **整文件删除**,精品客户不需要运营界面
- `src/routes/platform.ts` — 大部分路由砍掉,只保留微信身份绑定相关
- `src/routes/sandbox.ts`(919 行)— 多项目 sandbox 路由简化,sandbox 改成按 userId 隔离

### 工作步骤(粗略)

1. 在 `settings` KV 里加 `workspace_bindings` 一项,记录 userId → instanceId 映射
2. 所有 `getProjectRuntimeContext` 调用点改为查 workspace_bindings
3. 数据访问层(`portfolio` / `watchlist` / `stockPlans` / `alerts` 等)按 instanceId 隔离的逻辑保留,只是上层调用不再走 platform 抽象
4. platform/ 文件按上面列表删除/瘦身
5. DB schema 用 `ALTER` / 软删除方式迁移,不丢历史数据

## 执行顺序

```
1. WP A1 (删 diet)         → build 验证 → 提交
2. WP A2 (删 bypass)        → build 验证 → 提交
3. WP A3 (删 conversation)  → build 验证 + 主链路冒烟 → 提交
4. WP C   (platform 简化)   → 分子步骤,每步独立可回滚
```

每个子工作包独立提交,出问题可以单步回滚。A1→A2→A3 顺序无强耦合,但建议先做 A1(diet 在 platform/ 留下的常量最多,清完后 C 的可见度更高)。

## 完成情况(2026-06-23)

- ✅ WP A1 饮食推荐产品线已删
- ✅ WP A2 BypassWeixinMobileBridge 旁路桥已删
- ✅ WP A3 conversation-task 草案系统已删
- ✅ WP C platform 多项目框架已拍扁为极简模型:
  - 删 `src/platform/skill-bundles.ts`(208 行)、`src/platform/project-types.ts`(99 行)、`src/admin/platform-page.ts`(679 行)
  - 新增 `src/acp/skill-bundle-prompt.ts`(75 行,固定投资助手技能包)
  - `src/platform/project-registry.ts`:226 → 184 行,内联 manifest 常量,删 `createInvestAgentInstance` / `INVEST_AGENT_JR_IDEAL_INSTANCE_ID` / `AgentBackend` 死导出
  - `src/platform/tool-registry.ts`:去掉 `getProjectTypeManifest` 耦合,改用 `ALLOWED_SANDBOX_TOOLS` 常量
  - `src/routes/platform.ts`:327 → 68 行,删全部 admin REST + 平台后台页,保留 weixin 工厂和自动恢复
  - `src/server.ts`:删 `registerPlatformRoutes` 调用 + `/platform` 日志
  - `src/admin/dashboard-page.ts`:删两处 `/platform` 入口
  - `src/lib/sandbox-context.ts`:用 `DEFAULT_SANDBOX_PERMISSIONS` 常量替代 manifest 查询
  - DB 表 `ai_projects` / `ai_instances` / `investment_profiles` 保留作考古

## 保留不动(WP B,后续单独评估)

- L1/L2 标准指标(算子 + 信号)
- L3a 规则树复合指标 + YAML 加载器
- L3b 沙箱脚本引擎(isolated-vm)
- 告知协议门禁
- method_change 跟踪(评估后可能进 WP C 而非这里)
- review-viewpoint-backend(闭环自演进的产物,先保留观察)

这些是"超出 MVP 但用户已用上主力控盘 ZZLKP"的能力,贸然删除会影响现有客户体验。

## 预期收益

- src/ 体积 24,650 → 估 17-18k 行(WP A 后)
- WP C 完成后 → 估 14-15k 行
- 心智负担下降:不再需要理解 project / instance / skill-bundle / profile 四层抽象
- 文档同步收敛:CLAUDE.md / AGENTS.md 大量 platform/diet 相关段落可以删除
