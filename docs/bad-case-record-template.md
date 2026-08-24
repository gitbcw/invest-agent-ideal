# Bad Case 记录模板

状态：治理基线草案（2026-08-22）

每个高影响问题都应完成“证据 → 归因 → 修复 → 回归 → 灰度/回滚结论”闭环。不要把“模型表现不好”作为最终归因；必须继续定位到数据、服务契约、Prompt、模型、交互或运维。

## 记录卡片

```yaml
case_id: BC-YYYYMMDD-NNN
status: observed | triaged | fixed | regressed | accepted-risk | closed
severity: S0-blocking | S1-high | S2-medium | S3-low
first_seen_at:
last_seen_at:
reported_by:
scope:
channel: portal | wechat | scheduler | automation | other
```

## 1. 场景与结果

- 场景名称：
- 用户/隔离实例：只记录脱敏标识，不提交真实秘密或完整用户内容
- 输入摘要：
- 预期事实/状态：
- 实际用户可见结果：
- 实际系统终态：`success` / `error` / `timeout` / `cancelled` / `expired` / `dead` / 其他
- 禁止行为是否发生：越权、秘密泄露、重复写入、重复推送、旧规则复活、静默成功

## 2. 关联证据

```text
traceId:
requestId:
conversationId:
messageId:
runId:
taskId:
artifactId / assetId:
deliveryId / pushJobId:
service audit id:
```

证据链接：

- Trace：
- 服务审计：
- scheduler/automation：
- artifact/delivery：
- 日志或截图：

## 3. 归因

初步类别（只能选一个主因，可附次因）：

- `data`：数据缺失、过期、来源不完整或格式错误
- `service-contract`：scope、权限、确认、revision、幂等或状态机错误
- `prompt`：上下文、指令或输出契约错误
- `model`：模型能力、延迟、网关或路由问题
- `interaction`：Portal/微信呈现或用户操作路径问题
- `operations`：部署、重启、配置、依赖或投递运维问题

根因证据：

影响范围：

为何不是其他类别：

## 4. 修复与验证

- 修复说明：
- 修改文件/契约：
- 确定性测试：
- 隔离行为评估：
- 真实链路或人工抽查：
- 新增回归样例：
- 是否需要故障演练：

## 5. 处置结论

```text
是否允许灰度：yes | no | only-isolated
灰度对象/allowlist：
观测窗口：
回滚目标：
未解决风险：
复核人：
关闭条件：
```

## 记录纪律

- 不保存完整 Prompt、模型原始回复、MCP 原始输出、凭证或绝对路径。
- “模型说已完成”不能替代服务审计、读回或投递终态。
- 若发生安全、scope、事务一致性或重复副作用，自动升级为阻断项。

