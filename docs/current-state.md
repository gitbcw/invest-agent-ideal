# 当前状态总览

更新时间：2026-09-06

## 一句话判断

Invest Agent 已进入生产运行，核心架构和服务边界基本成型；当前处于“产品稳定化 + 治理证据闭环 + 真实客户策略深化”阶段，尚未进入规模化复制或商业化扩张阶段。

## 已经成立的事实

- 当前生产基线是 `main`；Mastra 主线已接管生产运行。
- Portal、微信、Workspace、服务层、MCP、调度、推送、审计和发布/回滚基础已在真实链路运行。
- 服务层负责权限、确认、幂等、审计、调度和投递等确定性边界；Agent 负责理解、规划和投资判断。
- 程序可靠性闭环较强：测试、超时/重试、Trace、巡查、快照和回滚链已具备。
- 客户策略指标化已完成数据与管道基础（S0），但 mg 控盘度策略资产化试点（S1）尚未启动。

## 当前主攻

1. 补齐一次运行的可重构观测：工具载荷、配置编辑来源、trace/run/task/delivery 关联。
2. 把语义失败纳入稳定反馈环：受阻信号、rubric 周评、失败分类、语义回归记录。
3. 用真实客户摩擦驱动产品打磨，优先提升稳定性、可解释性和好用程度。
4. 按需推进客户策略资产化，不把指标化方向变成脱离客户价值的独立主线。

## 尚未毕业的门槛

- 语义错误发现仍慢于程序错误发现；语义回归门已建立两级形态（2026-09-06，semantic-change-regression-gate.md）但首例 SCR 未走、阈值未实战校准。
- 诊断链生产覆盖率已实测（2026-09-06 首轮：99.6% 串通），但微信通道反链断点（GAP-1）与平台指标口径失真（GAP-2）待修复（T-472）；发布记录纪律需下次真实发布起恢复逐次记录。
- 评估样例、用户反馈和跨场景效果证据仍在扩充，不能把局部测试通过等同于可扩大范围（扩大范围三前置条件见 governance-review-2026-09-06.md）。
- mg 策略尚未完成从文档/Agent 执行到版本化、可计算、可复现指标的转化。

## 不属于当前阶段的工作

- P-17 旧路线的 M1-M4 里程碑和 10 月外推门槛。
- 以商业化、泛化多租户或大规模平台化为优先目标。
- 在治理证据不足时继续堆叠与真实摩擦无关的新功能。

## 阅读路径

- 架构与边界：[`system-overview.md`](./system-overview.md)
- 运营环与成熟度：[`ai-application-operating-loop.md`](./ai-application-operating-loop.md)
- 治理证据：[`governance-assessment-matrix.md`](./governance-assessment-matrix.md)
- 客户策略指标化：[`strategy-indicator-roadmap.md`](./strategy-indicator-roadmap.md)
- 项目意图：[`project-intent-pack/00-summary.md`](./project-intent-pack/00-summary.md)

本文是当前状态入口，不替代各领域契约、运行手册或历史记录。
