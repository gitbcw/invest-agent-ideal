# T-539 执行报告：自动化详情升级、失败告知与通知偏好（P2）

状态：**执行完成，验收点全部达成。** 日期：2026-09-21。
契约：[T539-automation-detail-failure-notify-preference-contract.md](./contracts/T539-automation-detail-failure-notify-preference-contract.md)。

## 交付内容

### 1. attention 事项事实（服务拥有）

- 迁移块 `attention_items_v1`（src/db/index.ts；schema.ts 同步 drizzle 定义）：`attention_items` + `notification_preferences`，仅隔离库先行（生产迁移归 owner 后续授权）。
- `src/services/attention-items.ts`：失败记录/去重（同任务 open 事项只更新计数与系统状态）、成功自动 resolve（resolved_run_id 溯源）、列表/详情/open 计数、偏好读写。写入唯一入口是 `notifyAutomationRunTerminal` 终态钩子；无用户手动收口、无状态机暴露。

### 2. T-479 策略调整（设计 §7.2）

`src/services/automation-notify.ts`：
- 失败首条：**无论偏好如何都写 attention 事实**；微信经偏好 gate（`wechatFailureEnabled`，默认开）；关闭时 audit 记 `skipped_by_preference`；发出后回写 `wechat_notified`。
- 连败非首条：不重复发微信，但去重更新 open 事项（计数+系统状态）。
- 成功终态：自动 resolve open 事项；**恢复微信默认静默**（`wechatRecoveryEnabled` 默认关，显式开启才发；代码路径保留）。
- 失败正文补「详情见网页端待处理」投影指引。

### 3. connector API（5 个新消息）

`attention.list / attention.get / automation.detail / preference.get / preference.set`；scope 全部注册派生，浏览器 scope 字段拒绝与协议版本守卫同步覆盖；错误码 ATTENTION_NOT_FOUND → 404。

### 4. automation.detail 四块聚合

`src/services/automation-detail.ts`：任务目标（名称/说明/频率/交付方式）、依赖与产物（method/skill/asset 依赖 + 主管理入口跳转句柄）、最近结果（执行/产物/投递分层：runs + run_outcomes + push_jobs）、需要注意（关联 open 事项）。

### 5. Portal 前端

- `/attention` 待处理页（失败卡片固定字段：任务、时间、直接影响、系统状态、「让 Agent 解释并处理」入口——按契约本轮为占位路由，语义落地在 T-540；已恢复 Tab；不展示错误码/trace/重试次数）。
- 侧栏「待处理」入口 + 未处理数徽标（PortalSidebar 拉 openCount）。
- `/settings` 设置页（微信失败提醒开关/恢复提醒开关/静默时段；文案明示偏好不改变任务运行与网页告知）。
- `/automations/[taskId]` 详情顶部插入 TaskDetailPanel 四块（跳转工作空间/文件/待处理）。

### 6. 失败反例构造

`scripts/agent-space/p0/seed-failure-fixtures.mjs`（幂等自清理；经 runGenericAutomationTaskNow 真实终态链路构造）：单次失败（open count=1 微信已提醒）、连败 2 次（同一事项去重 count=2）、失败后成功（resolved 带恢复时间）。

## 验证证据

- **回归五场景**（tests/automation-notify.test.ts 新增 6 例 + 1 例语义更新，全套 14/14）：失败首条（事实+微信+回写）、连败去重、恢复默认静默（事项 resolved、无 recovery job）、微信失败偏好关闭（事项仍写、任务状态不变）、显式开启恢复才发恢复微信、微信投递失败不影响事项与任务状态、跨 scope 隔离。
- **全量**：主仓 `npm test` 746/746 全绿；Portal 53/53 全绿；双侧 tsc 零错误。
- **隔离环境端到端**：verify 14/14（新断言「微信通道零触碰」= weixin_delivery_attempts 相对拉取快照无新增）；curl 走查 attention open/resolved（卡片字段齐全）、preference get/put（默认值+开关生效）、automation.detail 四块聚合（2 runs 含投递分层、1 关联事项）。
- 夹具产生的 pending push（offline 下不被消费）= 「微信投递失败但网页告知完整」的直接证据形态。

## 与契约的偏差（如实记录）

1. 静默时段首版**预留不强制**（存储与 API 就绪，投递时不裁剪）——设置页文案已注明；强制逻辑待真实使用反馈后补。
2. 可提醒类别（categories）存储结构就绪，设置页未暴露 UI（首版无分类告知需求）。
3. run_outcomes 对历史 run 覆盖不全（W7 前无记录）时，产物层显示"无产物登记"而非推测——契约预留的真实形态处理。
4. 「让 Agent 解释并处理」按钮 disabled 占位（title 注明后续版本）——契约明确入口语义归 T-540。

## 遗留到 T-540

- 失败事项 → 问题处理会话（受限上下文绑定 + 脱敏注入）。
- Agent 纠错候选端到端（state candidate 工具面 + 触达规则 + 批准生效链）。
