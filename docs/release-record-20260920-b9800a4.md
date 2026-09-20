# 发布记录：20260920T010819Z-b9800a40

按 [release-governance-evidence-template.md](./release-governance-evidence-template.md) 口径记录。deployed 已标记；known-good 待首个观察点通过后由 owner 确认。

## 变更摘要

```text
release_id: 20260920T010819Z-b9800a40
commit: b9800a4（main，含 fa773ae 代码修复 + 5 个纯文档提交）
branch: main
date: 2026-09-20 09:08–09:10（北京时间，白天发布惯例）
owner: 用户授权（2026-09-20 对话：「部署授权今天白天可以发」）
agent 执行
change_type: code（模型消息兼容层，无安全面改动；附文档批入库）
```

- 代码变更（fa773ae，T-511）：DeepSeek 网关对流式请求校验——assistant 带 tool_calls 时必须携带 reasoning_content 字段，@ai-sdk 序列化只在思考文本非空时输出该字段，deepseek-flash 某轮空思考 → 字段缺失 → 下一轮工具回传 400（9-15 mg / 9-18 111 日复盘失败同源，误分类 dependency_unavailable）。修复 = deepseek-reasoning-compat processor 在 processLLMRequest 阶段给缺有效思考的 tool-call assistant 消息补占位 reasoning part（空格，生产网关实测可过），只改出站请求不动持久化消息。另 glm 坏证据阈值 2→3（owner 9-18 裁决：国产通道稳定，偶发空响应/慢首字不应轻易降级）。
- 文档批（b9800a4 相对上一 release 的其余部分）：9-19 会议两份设计稿（策略模拟 T-529 / Agent 自纠错工作空间 T-524）、Workspace 透明化重构执行契约 v1（T-521）、BC-20260913-001 bad case、9-18 运营周报双版与聚合脚本、mgreplay A/B 脚本与盲评材料（甲乙密封纪律保持）。
- 生产数据动作：无。`.env`、数据库、Workspace、`reviews/`、`.state/`、微信状态零触碰。

## 验证证据

| 门类 | 结果 | 证据 |
| --- | --- | --- |
| 确定性测试/类型检查 | pass | 发布前 `npm run verify`：690/690（约 57s）、boundary 7 项、build/tsc 零错、agent-context 212 文件检查通过 |
| 快照与备份 | pass | release 快照 20260920T010819Z-b9800a40（clean tree）；工作区备份 2026-09-20T090819+0800（1516 文件）已发布 |
| 生产部署 | pass | release:deploy 全流程，PM2 `invest-agent-mastra` + `mastra-portal` 双进程 online |
| 健康检查 | pass | runtime `/health` 200（{"status":"ok"}）、portal `/api/health` 200、`/platform` 200 |
| Portal 连接器 | pass | 5 assistant（primary/mg/dyk/111/mgreplay）09:09:50 全部重注册，conversation.get 往返 ok；socket 错误全部落在 09:09:37–42 部署窗口内，之后零新增 |
| 兼容层行为 | pass（本地） | fa773ae 自带单测 6 用例 + 模拟 DeepSeek 校验网关的本地回归；生产首个真实业务验证点见下 |

## 灰度与观测

- **首个真实业务验证点：9-21（周一）11:20Z mg 日报自然 run**（此前该签名 9-15 mg / 9-18 111 各失败一次）。若 deepseek 兜底轮再被调用，reasoning_content 占位应使其通过；巡查按既有口径盯 dependency_unavailable 与「thinking mode 的 reasoning_content 必须回传」签名。
- glm 阈值放宽（2→3）的副作用观察：若 glm 连续 3 次坏证据才降级，轮内重试成本上升；巡查关注 attempt 预算击穿（T-464 口径）是否复发。
- known-good 标记：建议 9-21 验证点通过后由 owner 确认 `release-snapshot.mjs accept`（本地最近 accepted known-good 为 20260910T064230Z-d7ff4fa0）。

## 回滚路径

- 代码回滚：`git revert fa773ae` 重发（同 9-11 记录口径）；或 `npm run release:rollback -- 20260910T064230Z-d7ff4fa0 --confirm=rollback-code-v1` 回到最近 known-good。
- Portal 构建回滚：服务器 `.deploy/portal-previous-20260920T010842Z-*` 保留部署前 `.next`。
- 触发条件：周一验证点失败且归因指向兼容层；或 processor 对正常调用产生误改（设计上仅 tool-call 且缺思考时介入，理论不可能，仍留观察）。
