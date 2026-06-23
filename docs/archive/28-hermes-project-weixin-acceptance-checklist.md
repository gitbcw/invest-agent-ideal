# 28 — Hermes 项目微信连接真实使用验收清单

> 创建于 2026-06-05。本文档用于验收 `22649` Hermes 后端链路和项目微信连接是否具备长期运行的基本可靠性。该清单只验证 `22649`，不重启或干扰 `22648` 主路。
>
> Current status: backend-specific acceptance checklist. Hermes is an optional backend adapter, not the current required intelligent backend. Current main-path acceptance should use Codex ACP and project sandbox checks; keep this checklist for Hermes regression and fallback validation.

## 验收前置

- 服务健康：`curl -fsS http://localhost:22649/health`
- 自恢复 smoke：`npm run smoke:hermes-service`
- 客户输出边界 smoke：`npm run smoke:customer-output`
- 平台后台：`http://localhost:22649/platform`
- 项目微信绑定后台：`http://localhost:22649/admin/hermes-weixin`

## A. 服务与自恢复

| 项目 | 验收方式 | 通过标准 |
| --- | --- | --- |
| launchd 自恢复 | `npm run smoke:hermes-service` | 返回 `ok: true` |
| 健康检查 | `/health` | `status=ok`，`hermesAcp.enabled=true` |
| 日志路径 | 查看 `logs/hermes-service.out.log` / `err.log` | 文件存在且可增长 |
| 主路隔离 | 测试过程中不执行 `22648` 重启命令 | 主路测试不受影响 |

## B. 项目微信连接

| 项目 | 验收方式 | 通过标准 |
| --- | --- | --- |
| 扫码连接 | `/admin/hermes-weixin` 点击连接 | 微信账号显示 connected |
| 项目监听 | 发送普通微信消息 | 能收到客户可读回复 |
| 不泄露工程词 | 微信回复检查 | 不出现 localhost、端口、路径、API、Codex、ACP、Hermes、Skill、token |
| Trace 可查 | `/platform` 最近 ACP 追踪 | 能看到该轮消息 trace |

## C. 日复盘闭环

| 项目 | 验收方式 | 通过标准 |
| --- | --- | --- |
| 异步回执 | 微信发送“生成日复盘” | 先收到生成中回执 |
| 最终推送 | 等待后台任务完成 | 收到复盘正文 |
| 复盘保存 | 查询 `/api/reviews/query?date=YYYY-MM-DD&userId=...` | 能查到复盘内容 |
| 观点追踪 | 复盘正文包含“观点追踪表” | `review_viewpoints` 产生 open 记录 |
| 观点回测 | 下一份复盘包含“上一轮观点回测” | open 观点可回写为 validated / invalidated / pending |

## D. 周复盘闭环

| 项目 | 验收方式 | 通过标准 |
| --- | --- | --- |
| weekly context | `POST /api/reviews/weekly-context` | 返回 weekStart、weekEnd、viewpointSummary |
| 观点统计 | 检查 `viewpointSummary.counts` | validated / invalidated / pending / open 汇总正确 |
| 周报内容 | 生成周复盘 | 包含“本周观点追踪回测” |

## E. 选股问答与动作闭环

| 项目 | 验收方式 | 通过标准 |
| --- | --- | --- |
| 选股问答 | 微信问行业/公司筛选问题 | 回复区分事实、推断、观察条件和风险 |
| 转自选 | 用户确认加入自选 | 需要确认的写操作不绕过沙箱 |
| 预案/提醒 | 用户要求设置预案或提醒 | 生成明确支撑/压力/验证点，写操作有审计 |
| 客户边界 | 最终微信回复 | 不暴露内部工具、接口、路径或执行过程 |

## F. 沙箱与权限

| 项目 | 验收方式 | 通过标准 |
| --- | --- | --- |
| 只读 token | 调用 read 类 sandbox API | 成功返回当前实例数据 |
| 只读 token 写入 | 尝试写 watchlist/review | 返回权限拒绝 |
| 跨项目工具 | 非投资项目调用 invest 工具 | 返回 tool not allowed |
| 危险操作确认 | 删除/高风险写操作 | 需要 pending confirmation |
| 审计记录 | `/platform` 最近审计日志 | 能看到 operation、status、resource type |

## G. 推送队列

| 项目 | 验收方式 | 通过标准 |
| --- | --- | --- |
| 失败入队 | 模拟或观察失败推送 | push job 进入 retry/dead 状态 |
| 重试策略 | 等待 due job 处理 | attempts 增加，成功后 sent |
| 平台可见 | `/platform` 推送队列摘要 | 能看到 sent/retry/dead 汇总 |

## 当前阶段结论模板

验收完成后记录：

```text
日期：
Hermes 可选后端服务：
微信连接：
日复盘：
周复盘：
选股问答：
沙箱权限：
推送队列：
客户输出边界：
遗留问题：
下一步：
```
