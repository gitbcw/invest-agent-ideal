# W7 决策冻结记录（D1–D11）

窗口执行前必须全部冻结（`status: decided` 且有 owner 确认记录）。**未决决策对应的批次不得开启 resolver。** D1–D7 已于 2026-09-21 冻结；D8–D11 为同日 owner 对 T-530 回放结果的二批裁决。B1/B2/B3 resolver 解锁的前置不变，但 **D11 生效期间（窗口授权前）任何批次不得执行任何生产步骤**。 本文件是授权决策的唯一权威记录；执行侧（导入/注册/开关）只消费此处已冻结的决定。"依据"列只引用 owner 的既有裁决原文，不替 owner 新签。

| # | 决策 | 建议 | 状态 | 依据（owner 既有裁决） |
| --- | --- | --- | --- | --- |
| D1 | mg 四因子 `methods/控盘度综合评分.md` approve+adopt | 采用（无约束、156 次真实读取、任务消费者 at_d64649ad） | decided | owner 2026-09-21 裁决"采用"（本表更新同日） |
| D2 | mg strategy-rules（hold-ambiguity） | 保持 owner-review，不导入不采用 | decided | W0 三验 R7：mg 策略 hold 不得进入运行对象自动导入 |
| D3 | mg 旧 KP V1.0（historical-not-default） | 保持历史定位，服务层永久阻塞 | decided | W0 三验 R7：旧 KP 禁止默认采用 |
| D4 | dyk 撤回策略 strategy-rules.md | 导入后保持 draft 归档，不采用 | decided | W0 reconciliation `dyk-strategy: preserve-current`（保留当前原文，撤回语义） |
| D5 | dyk 核心模型 fundamental.md（restore-candidate） | 继续留 owner-review 队列；**dyk 空方法上下文为其现状预期**（策略已撤回） | decided | owner 2026-09-21 裁决"继续留队列" |
| D6 | 111 strategy-rules（split-in-progress） | 选 b：接受 B3 切换后无方法上下文（日复盘主要由任务模板驱动）；策略继续留 owner-review，拆分裁决留作 W7 后独立工作 | decided | owner 2026-09-21 裁决"接受空方法切 B3" |
| D7 | 205 项 owner-review 其余项 | W7 不处理，继续留可发现队列 | decided | owner 2026-09-20 W6 放行令："owner-review 项继续不得默认采用" |
| D8 | 切换后默认技能面为空集（旧 6 条技能元数据 + skill 工具归零；默认清单依赖 owner 治理的系统发布，生产从未发布） | 接受：按方法绑定与任务模板运行；后续默认技能发布属 owner 独立治理，不阻塞切换 | decided | owner 2026-09-21 裁决"接受切换后默认 Skill 为空"（T-530 回放发现 §5.3） |
| D9 | 生产尚无 agent_space schema（W1-W7 代码未部署过） | T-531 起批次日增加步骤 0：先发布当前 main → 核对生产 agent_space_* 建表 → 才允许导入/注册/resolver | decided | owner 2026-09-21 裁决"T-531 增加步骤 0"（T-530 回放发现 §5.1） |
| D10 | 111 active 任务数（计划表原写 4，事实为 3：monthly-review 已归档） | 按当前事实 3 个 active 任务执行 B3 | decided | owner 2026-09-21 裁决"111 按实际 3 个执行"（T-530 回放发现 §5.2） |
| D11 | 生产窗口授权 | 暂不授权：先修订执行手册、schema 核对命令与发布/回滚边界并回传；owner 再次明确窗口授权前，禁止生产 `--confirm`、resolver 切换、真实消息、真实用户写入 | decided | owner 2026-09-21 裁决"暂不授权生产窗口，先修订" |

冻结规则：每批窗口前，该批用户涉及的决策必须全部 `decided`（本表状态由 owner 逐项确认后更新并注明日期）；`pending` 决策对应的批次只能做步骤 1–6（导入/初始化/注册），**不得执行步骤 8（resolver 切换）**。D11 为全局闸门：窗口授权回传并获 owner 确认前，步骤 0 及一切生产写入同样不得执行。
