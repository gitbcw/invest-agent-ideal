# 发布治理证据模板

状态：治理基线草案（2026-08-22）

本文用于涉及 Prompt、模型路由、工具清单、MCP、服务契约、模板、Portal 构建或运行时配置的变更。它是发布记录模板，不授权生产发布、数据迁移、端口切换或真实用户灰度。

## 变更摘要

```text
release_id:
commit / snapshot:
branch:
date:
owner:
change_type: code | prompt | model | tool | mcp | template | portal | config
```

- 变更目的：
- 影响范围：
- 明确不影响的生产状态：`.env`、SQLite、Workspace、`reviews/`、`.state`、微信状态
- 依赖与外部条件：

## 验证证据

| 门类 | 结果 | 证据 |
| --- | --- | --- |
| 确定性测试/类型检查/构建 | pass / partial / fail | |
| scope/权限/确认/revision/幂等 | pass / partial / fail | |
| 错误终态、超时、取消、重试 | pass / partial / fail | |
| Trace 覆盖和秘密边界 | pass / partial / fail | |
| Portal/微信/scheduler/automation 适用链路 | pass / partial / fail / n/a | |
| 隔离行为评估与 Bad Case 回归 | pass / partial / fail | |
| 故障演练 | pass / partial / fail / n/a | |

## 灰度与观测

- 灰度对象/allowlist：
- 隔离环境或副本：
- 观测开始/结束时间：
- 必看指标：工具/写入安全违规、跨 scope、重复写入/推送、超时/空响应、终态收敛、Trace 覆盖、Portal/微信成功率、数据来源缺口
- 阻断阈值：
- 负责人和复核人：

## 回滚

- 回滚目标 commit/snapshot：
- 回滚只替换的内容：
- 明确不触碰的状态：
- 回滚触发条件：
- 回滚演练证据：
- 回滚后健康检查：

## Go / No-Go

```text
G1 反馈证据：go | no-go
G2 服务边界：go | no-go
G3 失败终态：go | no-go
G4 灰度与回滚：go | no-go
G5 关联与脱敏：go | no-go

最终结论：go | only-isolated | no-go
未解决风险：
批准人：
复核日期：
```

任何安全、scope、事务一致性或重复副作用回归，直接 `no-go`，不得以其他指标平均抵消。

