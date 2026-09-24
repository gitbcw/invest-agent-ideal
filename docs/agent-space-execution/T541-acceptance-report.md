# T-541 验收报告：111 本地端到端验收与旧右侧面板退出准备

状态：**自动化验收 20/20 通过；owner 浏览器复核待进行。** 日期：2026-09-21。
契约：[T541-e2e-acceptance-legacy-panel-exit-contract.md](./contracts/T541-e2e-acceptance-legacy-panel-exit-contract.md)。

## 1. 自动化端到端验收（e2e-acceptance.mjs，20/20）

覆盖契约五组检查，全部通过：

| 检查组 | 结果 |
| --- | --- |
| 侧栏五入口数据面（待处理 open=2 / 自动化 / 我的文件 / 方法 1 / Skills 私有 2+已安装 1 / 偏好） | 6/6 |
| 完整失败处理链（事项 → 详情四块关联 → 问题会话创建+脱敏 system 注入+事项绑定 → 候选提出 → 批准生效 → 离开待确认） | 7/7 |
| 版本与生效分离（编辑成新草稿：当前采用版本不变 + 任务固定绑定不变） | 3/3 |
| 跨 scope（未授权 scope 会话 0 行；浏览器 scope 注入 strict 拒绝） | 2/2 |
| 假投递（OFFLINE；微信 delivery attempts 相对拉取快照零新增 354=354） | 1/1 |

复跑方式：`start-isolated.mjs` → （如候选为空）`seed-issue-candidate.mjs` → `e2e-acceptance.mjs`。

全量测试基线：主仓 752/752、Portal 53/53、双侧 tsc 零错误（T-537~T-540 四任务累计新增 24 个测试）。

## 2. 设计 §11 产品验收对照（agent 预跑结论，owner 复核清单）

| 设计验收条款 | 自动化证据 | owner 复核点 |
| --- | --- | --- |
| 侧栏进入待处理/自动化/我的文件/工作空间；工作空间默认方法可切 Skills | 五入口 API 全通；页面路由与 Tab 完备 | 浏览器实际点一遍五入口与 Tab 切换 |
| 各主管理入口查看/编辑/配置；区分内容已保存与运行已生效 | 方法「保存草稿≠采用」、Skill「编辑成草稿+启用安装显式」经 API 验证 | 页面文案是否清楚（草稿/采用/安装徽标） |
| 方法/Skill 不以普通文件重复编辑；关联可跳转 | 文件页只读跳转 /workspace；方法详情关联资料跳 /assets | 跳转体验 |
| 失败网页可靠可见，微信只是提醒投影 | 待处理页 + 偏好 gate + 投递失败不影响事实（五场景测试） | 卡片字段是否人话 |
| 用户不见内部 scope/checksum/run-basis | 响应 redact + strict 拒绝 + 页面无内部字段 | 页面有无漏出的技术字段 |
| 候选不自动生效、无自主反思调度 | 结构性断言 6/6（approve 不在工具面、无上下文拒绝、draft 不注入） | 候选区块交互 |

## 3. 旧右侧面板退出方案

见 [T541-legacy-panel-exit-plan.md](./T541-legacy-panel-exit-plan.md)：无可替代能力缺口；两阶段移除（410 过渡→删除）、零数据迁移回滚、三个 owner 确认点。**移除实施归生产发布授权任务。**

## 4. 未覆盖证据（本地验证不能证明的，按设计 §11 证据边界）

- 真实微信送达（隔离环境 OFFLINE，仅证明投递失败不影响网页告知）；
- 生产 schema 迁移与回填（attention_items_v1 等新表仅在隔离库；生产迁移归 owner 授权任务）；
- 真实用户采用与长期运行质量；
- Skill 市场/系统 release 的安装升级路径（无真实 release 数据；代码路径已就绪待数据验证）；
- 真实模型对话轮中的候选提案体验（工具面经真实调用验证，完整对话质量属运行观察）。

## 5. 生产发布建议清单（决策输入，非授权）

1. 发布范围建议仍限定 111 scope（`AGENT_SPACE_ASSEMBLY_MODE` 已含 111）；首批页面：工作空间/待处理/设置 + 详情四块 + 候选审阅。
2. 迁移边界：`attention_items_v1` + `notification_preferences`（新表，CREATE IF NOT EXISTS 增量、无回填）；T-479 恢复通知默认静默的策略变化需在发布说明中告知 111 用户。
3. 备份/回滚：新表可 DROP 回滚（无既有数据）；代码回滚走发布快照 SOP；skills/methods 行为零写入（生产 111 为空集，GUI 呈现空列表直到构造或迁移——**发布前建议先在生产 111 经 owner 授权构造或决定空列表上线**）。
4. 观察窗口：发布后首个 19:00 任务周期 + 次日巡查（失败告知链/偏好行为/无微信误发）。
5. 关闭路径：回滚代码 + DROP 新表即可整体退回；Portal 页面入口回退随代码回滚。

## 6. owner 复核入口

```bash
node scripts/agent-space/p0/start-isolated.mjs   # http://127.0.0.1:3110 primary/User@2026
node scripts/agent-space/p0/e2e-acceptance.mjs   # 20/20 复跑
```
