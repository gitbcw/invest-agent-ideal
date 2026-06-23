# 29 — AI Project 分发需求

> 创建于 2026-06-05。本文档整理 Platform 如何把 AI Project 分发给用户，包括“独享实例”和“共享实例”两种模式。

## 背景

当前 Platform 已有两个样板项目：

- `invest-agent-primary`：投资助手。代表一人一项目、可个性化 skills 的独享实例模式。
- `diet-recommendation-shared`：饮食推荐助手。代表一个项目服务多个微信用户、共享一套 skills 的共享实例模式。

接下来 Platform 不能只展示项目，还要能完成项目分发：

- 给一个新用户创建投资助手实例。
- 给一个或多个微信用户绑定到饮食推荐助手共享实例。
- 在 Platform 内完成微信连接、二维码生成、监听、断开，不要求跳转到独立微信页。

## 核心概念

### Project Type

项目类型定义一类 AI 项目的能力边界。

示例：

- `invest-agent`：投资助手类型。
- `diet-recommendation`：饮食推荐助手类型。

Project Type 决定：

- 默认 skill bundle。
- 默认 runtime/profile 兼容配置。
- 默认 strategy skill。
- 默认可调用工具。
- 默认权限。
- 默认资源类型。
- 默认 dashboard 类型。
- 默认分发模式。

### AI Project Instance

AI Project Instance 是实际运行和隔离的单位。

示例：

- `invest-agent-primary`
- `diet-recommendation-shared`

它决定：

- 当前实例绑定哪些微信用户。
- 当前实例使用哪个 backend。
- 当前实例使用哪套 skill bundle。
- 当前实例的数据隔离 scope。

### Channel Binding

Channel Binding 是“某个微信用户身份”绑定到“某个 AI Project Instance”。

同一个微信用户可以绑定多个项目，但每个项目类型下应有明确默认绑定，避免消息路由混乱。

## 两种分发模式

## A. 独享实例分发

适用于：投资助手。

语义：

一个用户拥有一个独立投资助手实例。该实例可以有自己的方法论、节奏、关注股票、交易预案、复盘历史、提醒规则和 skill bundle。

### 分发流程

1. Platform 点击“创建项目实例”。
2. 选择项目类型：`投资助手`。
3. 输入用户信息：
   - 用户 ID。
   - 显示名称。
   - 实例名称。
4. 选择或默认：
   - backend：当前默认 Codex ACP；Hermes 只作为可选 backend adapter。
   - skill bundle：默认 `invest-agent-default`，后续可改为用户专属 skill bundle。
   - Strategy Skill：默认投资策略骨架，实例差异通过 instance expansion 承接。
   - Hermes Profile：仅作为 Hermes 可选后端兼容配置，默认 `invest-agent`，不承载方法论。
5. 创建实例。
6. 在 Platform 项目详情中生成该实例的微信二维码。
7. 用户扫码并发送消息。
8. 服务端把该微信 identity 绑定到这个投资助手实例。
9. 后续该用户消息进入该实例，并通过 `user_id + instance_id` 隔离业务数据。

### 验收标准

- 创建后 Platform 立即出现新的投资助手实例。
- 新实例不会共享主用户持仓、自选、预案、复盘、提醒。
- 扫码绑定后，该微信用户只进入这个实例。
- 不会因为访问 Dashboard 或旧用户列表而自动创建意外投资实例。
- 投资助手实例可以跳转到专属 Dashboard。

## B. 共享实例分发

适用于：饮食推荐助手。

语义：

一个饮食推荐项目实例服务多个微信用户。它们共享同一套 skills 和 runtime/profile 兼容配置；如果使用 Hermes，可复用默认 `diet-recommendation` profile。用户身份仍要分开。后续如果有偏好、忌口、目标、历史建议等数据，应按 `user_id + instance_id` 存储。

### 分发流程

1. Platform 选择 `饮食推荐助手` 项目。
2. 在项目详情中点击“生成二维码”。
3. 多个用户都可以扫码。
4. 每个微信用户都会创建或复用自己的 `users` / `channel_identities`。
5. 所有这些微信用户都绑定到同一个 `diet-recommendation-shared` 实例。
6. 消息进入同一个饮食推荐 skill bundle，但服务端上下文仍带当前 `userId`。

### 验收标准

- 多个微信用户扫码后，Platform 的饮食推荐助手显示多个通道绑定。
- 不新增多个饮食推荐实例。
- 不新增投资助手实例。
- 每个用户的上下文中都有自己的 `userId`。
- 饮食偏好等未来业务数据必须按 `user_id + instance_id` 隔离。

## Platform 需要支持的操作

### 项目列表

显示：

- 项目名称。
- 项目类型。
- 分发模式：独享实例 / 共享实例。
- Owner。
- backend。
- skill bundle。
- 微信绑定数量。
- trace / audit / push 摘要。

### 创建项目实例

最低支持：

- 创建投资助手独享实例。

字段：

- project type。
- user id。
- user display name。
- instance name。
- backend。
- skill bundle。

饮食推荐助手当前不需要创建多个实例，除非后续要为不同组织、客户、场景创建多个共享项目。

### 微信绑定操作

在项目详情中直接支持：

- 生成二维码。
- 刷新二维码/连接状态。
- 启动监听。
- 断开连接。

关键要求：

- 点击投资助手实例时，二维码必须绑定到该具体实例。
- 点击饮食推荐助手时，二维码必须绑定到共享实例。
- 二维码绑定目标不能只由 backend 推断，必须明确带 `projectId / instanceId / bindingMode`。

### Dashboard 跳转

只有具备业务 Dashboard 的项目才显示 Dashboard 跳转。

当前：

- 投资助手：显示 Dashboard 跳转。
- 饮食推荐助手：暂不显示业务 Dashboard；只显示连接、trace、audit、绑定用户。

## 当前已支持

- Platform 能显示 AI Project。
- Platform 项目详情已内联微信连接操作。
- 饮食推荐助手已有共享实例 `diet-recommendation-shared`。
- 饮食推荐助手微信绑定入口会把多个用户绑定到共享实例。
- Dashboard 不再为非 primary 用户自动创建投资助手实例。

## 当前缺口

### 1. 投资助手创建实例按钮

当前还没有 Platform UI 直接创建一个新的投资助手实例。

需要新增：

- `POST /api/platform/projects/invest-agent/instances`
- Platform 创建表单。

### 2. 投资助手二维码必须绑定到具体实例

当前投资助手微信连接仍偏“backend 级连接”，不是“选中实例级连接”。

需要改成：

- Platform 选中某个投资助手实例。
- 生成二维码时带上目标 `instanceId`。
- 微信扫码后把 channel identity 绑定到该实例。

### 3. 共享项目用户列表

饮食推荐助手需要在 Platform 详情中展示已绑定用户列表。

当前通道绑定已经能显示基础信息，但后续应扩展为：

- 用户显示名。
- 最近消息时间。
- 最近 trace。
- 是否可推送。

### 4. 饮食推荐业务数据

饮食推荐助手目前有 skill 和消息链路，但还没有偏好/目标/历史建议等确定性数据表。

后续如需沉淀用户偏好，应新增：

- `diet_user_profiles`
- `diet_preferences`
- `meal_suggestions`
- `nutrition_notes`

并全部按 `user_id + instance_id` 隔离。

## 推荐近期实现顺序

1. Platform 新增“创建投资助手实例”按钮和 API。
2. 项目微信绑定接口改为 instance-aware，支持给选中的投资助手实例生成二维码。
3. 饮食推荐助手详情增强：展示绑定用户列表。
4. 给饮食推荐助手补最小偏好记录 API 和数据表。
5. 再考虑创建多个饮食推荐共享实例，例如“家庭饮食助手”“企业员工健康餐助手”等。

## 一句话总结

投资助手的分发是“给某个用户创建一个独享项目实例，再绑定他的微信”。

饮食推荐助手的分发是“把多个微信用户绑定到同一个共享项目实例，每个用户有自己的身份上下文，但共享同一套 skills”。
