# AI Project Registry 与 Project Type Manifest 设计

## 目的

本文档承接 [24-ai-instance-platform-architecture.md](./24-ai-instance-platform-architecture.md)，把“多 AI 项目运行平台”的概念落到可执行的数据结构和迁移计划。

当前代码已经有 `ai_projects`、`ai_instances`、`channel_identity_instances`，但语义与目标架构存在偏差：

- 当前 `ai_projects` 更像 project type。
- 当前 `ai_instances` 更像具体 AI Project。
- 当前 `instance_id` 承担了具体 AI Project 的隔离字段。

短期不急于重命名表，先通过文档定义目标语义和兼容关系，后续代码按这个方向收敛。

## 目标模型

### Project Type

Project Type 是项目模板，定义某一类 AI 项目能做什么。

例子：

- `invest-agent`
- `diet-agent`
- `meeting-agent`
- `knowledge-agent`

目标字段：

```text
project_types
- id                          模板 ID，例如 invest-agent
- display_name                展示名，例如 投资助手
- description
- default_skill_bundle_id
- allowed_tools               JSON array
- default_permissions         JSON array
- resource_types              JSON array
- default_hermes_profile      兼容字段，仅供 Hermes 可选后端使用；投资方法论由 Strategy Skill 管理
- dashboard_type              例如 invest-dashboard / generic
- status                      active / disabled
- created_at
- updated_at
```

说明：

- Project Type 不承载用户数据。
- Project Type 不作为沙箱隔离主键。
- Project Type 只是创建具体 AI Project 的模板。

### AI Project

AI Project 是具体可运行的 AI 工作空间，是长期产品层的隔离单位。

例子：

- `daiyk-invest-main`
- `user-a-diet-main`
- `family-health-main`

目标字段：

```text
ai_projects
- id                          具体 AI 项目 ID，长期主隔离键
- type                        project type，例如 invest-agent
- owner_user_id
- name
- status                      active / paused / archived
- backend                     hermes / codex / auto
- skill_bundle_id             可覆盖 project type 默认值
- config                      JSON object
- sandbox_policy              JSON object
- tool_permissions            JSON array，可覆盖或收窄 type 默认权限
- created_at
- updated_at
```

说明：

- `ai_projects.id` 是长期希望所有业务数据使用的 `project_id`。
- 一个 AI Project 可以绑定一个或多个 channel identity。
- 一个 AI Project 可以选择自己的 skill bundle。
- 一个 AI Project 不直接拥有数据库，但所有可变资源必须带它的 scope。

### Channel Project Binding

Channel Project Binding 定义外部会话默认路由到哪个 AI Project。

目标字段：

```text
channel_project_bindings
- id
- channel_identity_id
- project_id
- is_default
- status
- created_at
- updated_at
```

说明：

- 微信扫码进来的外部身份先解析为 `channel_identity`。
- 平台再根据 binding 找到默认 AI Project。
- 用户未来可以在微信里切换项目，但切换结果应由服务端记录，不由 AI 自己猜测。

## 当前表与目标语义映射

| 当前表/字段 | 当前语义 | 目标语义 | 短期处理 |
| --- | --- | --- | --- |
| `ai_projects` | project type / template | `project_types` | 暂时保留，文档上视为 project type |
| `ai_instances` | 具体 AI Project | `ai_projects` | 暂时保留，`ai_instances.id` 视为目标 `project_id` |
| `ai_instances.project_id` | 指向当前 `ai_projects` | project type id | 继续用作 type reference |
| `channel_identity_instances` | channel 到 instance 路由 | channel 到 AI Project 路由 | 暂时保留，语义上视为 binding |
| `instance_id` | 工程隔离字段 | 当前具体 AI Project ID | 短期继续使用 |
| 业务表 `user_id` | owner/user scope | owner/user scope | 保留，不作为唯一隔离 |
| 业务表 `instance_id` | 具体实例 scope | 当前 project scope | 短期作为主隔离字段 |

当前兼容关系：

```text
target project_types.id       ~= current ai_projects.id
target ai_projects.id         ~= current ai_instances.id
target project_id in resources ~= current instance_id
```

## 资源 Scope 规则

### 长期目标

所有项目可变资源都应至少带：

```text
project_id
resource_type
resource_id
```

如果资源与人有关，再带：

```text
owner_user_id 或 user_id
```

例子：

```text
project_id=daiyk-invest-main
resource_type=invest.watchlist
resource_id=000001
```

### 当前过渡

投资助手业务表当前使用：

```text
user_id + instance_id
```

其中：

- `user_id` 是 owner 或主要用户。
- `instance_id` 当前等价于具体 AI Project ID。

后续收敛方向：

```text
instance_id -> project_id
```

或者在业务表中新增真正的 `project_id`，再逐步停止依赖 `instance_id`。

## Project Type Manifest

Project Type Manifest 是创建或运行 AI Project 的模板定义，可以先用代码常量或 JSON 文件承载，不急于入库。

建议最小结构：

```json
{
  "id": "invest-agent",
  "displayName": "投资助手",
  "description": "微信优先的投资决策辅助项目",
  "defaultSkillBundleId": "invest-agent-default",
  "defaultHermesProfile": "invest-agent",
  "defaultStrategySkillId": "invest-agent-strategy-middle-trend",
  "dashboardType": "invest-dashboard",
  "allowedTools": [
    "stock.quote.read",
    "invest.watchlist.read",
    "invest.watchlist.write",
    "invest.plan.read",
    "invest.plan.write",
    "invest.alert.check",
    "invest.review.generate",
    "push.weixin.send"
  ],
  "defaultPermissions": [
    "read:self",
    "write:self",
    "review:self",
    "alert:self",
    "push:self"
  ],
  "resourceTypes": [
    "invest.watchlist",
    "invest.portfolio",
    "invest.plan",
    "invest.alert",
    "invest.review"
  ]
}
```

## AI Project Registry 示例

当前投资助手主项目可以被解释为：

```json
{
  "id": "invest-agent-primary",
  "type": "invest-agent",
  "ownerUserId": "primary",
  "name": "主用户投资助手",
  "status": "active",
  "backend": "codex",
  "skillBundleId": "invest-agent-default",
  "config": {
    "strategySkillId": "invest-agent-strategy-middle-trend",
    "instanceExpansionPath": ".codex/skills/invest-agent-strategy-middle-trend/references/instances/invest-agent-jr-ideal.md",
    "profileSummary": "runtime compatibility summary only",
    "dashboardType": "invest-dashboard"
  }
}
```

微信用户项目可以被解释为：

```json
{
  "id": "invest-agent-weixin-mobile-ke933866",
  "type": "invest-agent",
  "ownerUserId": "weixin-mobile-ke933866",
  "name": "微信用户投资助手",
  "status": "active",
  "backend": "codex",
  "skillBundleId": "invest-agent-default",
  "config": {}
}
```

未来饮食管理项目可以是：

```json
{
  "id": "diet-agent-user-a-main",
  "type": "diet-agent",
  "ownerUserId": "user-a",
  "name": "饮食管理助手",
  "status": "active",
  "backend": "codex",
  "skillBundleId": "diet-agent-default",
  "config": {
    "dietGoal": "weight-control"
  }
}
```

## Tool 权限模型

工具权限应从两层决定：

1. Project Type 允许的工具全集。
2. AI Project 自己收窄后的工具权限。

实际执行时再叠加 sandbox token 的短期权限。

最终判断逻辑：

```text
requested_tool
  must be in project_type.allowed_tools
  must be in ai_project.tool_permissions or default_permissions
  must be allowed by sandbox token permissions
```

这样可以防止：

- 饮食项目调用投资工具。
- 投资项目调用平台管理工具。
- AI 幻觉调用未授权工具。
- 同一个项目在某个会话里越权执行危险操作。

## Sandbox Context 目标结构

目标结构：

```ts
interface SandboxContext {
  projectId: string;
  projectType: string;
  userId: string;
  channel: "weixin-mobile" | "dashboard" | "api" | "scheduler";
  backend?: "codex" | "hermes";
  conversationId?: string;
  skillBundleId?: string;
  permissions: string[];
  tokenId?: string;
  expiresAt?: string;
}
```

当前兼容结构仍保留：

```ts
interface SandboxContext {
  projectId: string;   // 当前多为 project type: invest-agent
  instanceId: string;  // 当前实际具体 AI Project ID
  userId: string;
  ...
}
```

短期新增代码时，应优先把 `instanceId` 当作具体 AI Project scope 使用；文档、命名和新设计中则优先使用 `projectId` 表达长期语义。

## 迁移计划

### Step 1：语义冻结

状态：已完成。

规则：

- 文档上“AI 项目”是最终产品主语。
- 当前 `instance_id` 是具体 AI Project 的工程字段。
- 不再把目标描述成“投资助手多用户化”。

### Step 2：Manifest 常量化

新增代码层 manifest，不先入库：

```text
src/platform/project-types.ts
```

内容：

- `invest-agent` project type manifest。
- 默认 allowed tools。
- 默认 permissions。
- 默认 skill bundle。
- 默认 strategy skill。
- 默认 dashboard type。

验收：

- Dashboard API 可以返回当前 project type manifest 摘要。
- sandbox token 创建时可以带出 project type / skill bundle 信息。

### Step 3：Registry 读取抽象

新增 project registry helper：

```text
src/platform/project-registry.ts
```

职责：

- 根据当前 `ai_instances.id` 读取具体 AI Project。
- 把当前 `ai_instances.project_id` 解释为 project type。
- 输出统一 `AiProjectRuntimeContext`。

建议类型：

```ts
interface AiProjectRuntimeContext {
  projectId: string;       // 长期语义，短期来自 ai_instances.id
  projectType: string;     // 短期来自 ai_instances.project_id
  ownerUserId: string;
  name: string;
  backend: "codex" | "hermes";
  skillBundleId: string;
  permissions: string[];
  dashboardType: string;
  config: Record<string, unknown>;
}
```

验收：

- Dashboard / sandbox / ACP prompt 逐步改为从这个 context 取项目运行信息。
- 不再散落手写 `DEFAULT_PROJECT_ID + DEFAULT_INSTANCE_ID` 组合。

### Step 4：Platform Dashboard 雏形

新增平台视角 API：

```text
GET /api/platform/projects
GET /api/platform/projects/:projectId
```

短期返回：

- 当前 `ai_instances` 列表。
- project type。
- owner。
- backend。
- skill bundle。
- channel binding。
- push job 摘要。
- audit 摘要。

验收：

- 可以总览所有 AI 项目。
- 投资业务数据仍留在原 `/dashboard`。

### Step 5：字段收敛

等旁路稳定后再考虑表结构命名调整：

方案 A：保守方案

- 保留当前 `ai_projects / ai_instances`。
- 文档和 helper 层完成语义转换。
- 业务表继续使用 `instance_id`。

方案 B：中期方案

- 新增 `project_types`。
- 新增新的 `ai_projects`。
- 把旧 `ai_instances` 数据迁移到新 `ai_projects`。
- 业务表新增 `project_id` 并从 `instance_id` 回填。

建议短期采用方案 A。

## 当前优先级

近期优先级应是：

1. 先加 Project Type Manifest 常量。
2. 再加 Project Registry helper。
3. 再做 Platform Dashboard API。
4. 最后考虑表结构命名收敛。

不要急着拆仓库，也不要急着做通用插件系统。当前最重要的是让所有后续代码都通过统一项目上下文工作。
