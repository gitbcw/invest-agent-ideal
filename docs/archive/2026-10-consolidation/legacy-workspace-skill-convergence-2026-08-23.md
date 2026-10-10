# 旧 Workspace Skill 收敛记录

日期：2026-08-23
状态：仓库模板已收敛；生产用户副本只读盘点完成，尚未迁移或删除

## 结论

- Mastra 只挂载注册项目根下的 `skills/`，不会发现旧 Workspace 的 `.codex/skills` 或 `skills/`。
- 仓库不再从 `templates/workspace/.codex/skills` 与 `templates/workspace/skills` 播种旧 ACP 工作流。
- 权限、确认、审计、调度、投递、幂等和发布继续由服务代码、工具 schema、任务 prompt 与 runner 强制；Skill 不能成为这些契约的安全边界。
- 旧生产 Workspace 属于用户资产。本次没有覆盖、迁移或删除任何生产文件。

## 标准旧 Skill 的承接

| 旧 Skill | 处理 | 当前承接 |
| --- | --- | --- |
| `service-capability-policy` | 退役 | Mastra L1 指令、工具 schema、服务权限 |
| `conversation-recovery` | 退役 | 权威对话历史与服务确认状态 |
| `investment-onboarding` | 退役 | 服务端 onboarding 状态机与当轮状态提示 |
| `capability-extension` | 拆解后退役 | `automation-task-designer`、L1 方法演化与能力边界 |
| `core-company-fundamental-review` | 重写承接 | `fundamental-analysis` |
| 日、周、月复盘 | 执行流程退役 | typed task、调度 prompt、`reviews.save` 与 runner 校验 |
| `market-watch` | 拆解后退役 | 服务端规则与任务；分析使用技术面、风控方法 |
| `observation-pool` | 重写承接 | `candidate-screening` |

日、周、月不重新建立三个重叠 Skill。若真实评测证明通用复盘方法缺失，再单独设计一个不包含调度和发布职责的 `portfolio-review-method`。

## 生产自定义 Skill 盘点

只读取了 Skill 名称和 frontmatter 描述，并与自动化任务名称、类型、时间以及指令关键词进行对照；未输出或复制正文。

| 用户 | 旧 Skill | 当前判定 |
| --- | --- | --- |
| `111` | `morning-brief` | 未找到可确认的一一承接任务；保留原件，待决定是否仍需交互式晨报方法 |
| `dyk` | `morning-brief` | 有 09:30 盘中简报任务，但定义未确认承接隔夜信息型晨报；不能视为已迁移 |
| `mg` | `morning-brief` | 未找到可确认的一一承接任务；保留原件 |
| `mg` | `market-close-capital-flow` | 现有 17:30 持仓复盘与 19:30 行业复盘均不等同于全市场收盘资金报告；保留原件 |
| `mg` | `screen-trend-strength` | 现有任务定义未出现 V2.0/趋势强度承接标记；保留原件 |

后续若采用其中任何一个能力，必须逐用户、逐文件读取和重写：方法类进入 Mastra `skills/`，定时工作流进入自动化任务，旧工具名、旧路径和服务写入步骤不得原样迁移。采用前备份原文件，并对目标用户做单点验收。
