# 发布记录：复盘报告格式偏好 + 周/月复盘 HTML 可视化（2026-10-12）

- releaseId：`20261012T024626Z-ac034fe9`，commit `ac034fe`，installedAt 2026-10-12T02:48:19Z，known-good 已标记（接替 20260908T050221Z-b5f065c7）。
- 上一个生产部署：2026-10-11 早（Portal 构建痕迹 `portal-previous-20261010T234456Z`），本次对生产的实质功能增量为 `c3f8d70` 之后的 main 提交。

## 发布内容

1. **周复盘策略进化建议 + 周/月复盘 HTML 可视化（c3f8d70）**：reviews.save 新增 htmlReport（自包含单文件 HTML，内容安全校验禁脚本/外链/iframe/1MB）；artifact 双变体发布（md/html 独立幂等键）；weekly 指令新增「策略进化建议」区块要求；weekly context 注入 methodChangeProposals 防重复提议。
2. **复盘报告格式偏好开关 + 服务门移除（d8fb5a4，owner 2026-10-12 两轮裁决）**：`reviewSchedule.<section>.report_format`（html/markdown/brief/table，中文别名归一化，按日/周/月分段，缺省 html）；Agent 经 preferences.apply 带确认可调（用户对话一句话切换）；generic runner 与旧编排 prompt 注入格式偏好行（存量迁移任务指令冻结也能感知）；`REVIEW_HTML_REPORT_REQUIRED` 强制逻辑整体移除（宽松模式，偶发缺失靠用户反馈暴露），保留 htmlReport 内容安全校验。
3. **文档欠账补登（ac034fe）**：service-tools-mcp.md 补 15 个工具条目（assets.folder.*/assets.move/skill.*/strategy.*/watchlist.add_many）+ strategy-simulation 模板断链修复；演示线文件（seed 脚本 + 迁移验证记录，7e902c2）。

## 验证证据

- 镜像语义验证（SCR tier-2 预检，详见 [weekly-review-html-prerelease-scr-20261011.md](./weekly-review-html-prerelease-scr-20261011.md)）：
  - 偏好缺省 html：mg 存量周复盘 run-now 4m11s 成功，注入行实证进入运行消息，md+html 双产物（8010B，六项安全检查全过），无服务门拒识。
  - Agent 对话调整：确认链走通（登记草案→对话内确认→落库 weekly=brief 分段正确）；再次 run-now 1m36s 成功，注入行切换 brief，html artifact 未被触碰，md 更新为精简文字版。
- 本地测试 809 用例全绿（含偏好开关 8 个新用例）；typecheck、build、boundary 7 项、agent-context 校验通过。
- 发布后验收：/health ok、portal 307、PM2 双进程 online 且无 ACP 覆盖、调度器启动、微信三用户监听自动恢复、Portal connector 全注册、重启窗口无异常错误（仅重启瞬间 socket 断连警告，已自愈）。
- 生产偏好现状：mg/dyk/111/mgreplay 周/月复盘均缺省=html（周六 09:00 周复盘将默认带 HTML，无需数据迁移）。

## 已知范围（如实标注）

- **策略进化建议区块仅对新任务生效**：生产三用户均为迁移任务（revision 指令冻结旧文本），不获得进化建议区块与防重复提议上下文；HTML 可视化经偏好注入对存量生效。存量指令升级（B：逐任务追加 revision）或 runner 类型化注入（C）另行裁决，未随本次发布。
- 周复盘耗时上升（镜像实测约 4~6 分钟，预算内）；brief 偏好下模型执行尺度仍偏完整（七段结构），属后续上下文稳定性调优范畴。
- 观察窗口：下一次真实生产周复盘（周六 2026-10-17 09:00，三用户）为 HTML 首验点；如出现 htmlReport 缺失（宽松模式无拒绝信号），依赖用户反馈暴露。

## 回滚

`npm run release:rollback -- 20261012T024626Z-ac034fe9`（代码回退保留运行数据）；或回上一部署版本。偏好数据为纯增量字段，回滚代码后缺省 html 语义不变，无需数据回滚。
