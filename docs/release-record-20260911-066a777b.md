# 发布记录：20260911T224500Z-066a777b

按 [release-governance-evidence-template.md](./release-governance-evidence-template.md) 口径记录。中间版本 20260911T220500Z-5e13ddba 同晚先行部署（口径归还 agent + qwen3.7 下线），本记录合并覆盖两版。

## 变更摘要

```text
release_id: 20260911T224500Z-066a777b（中间版 20260911T220500Z-5e13ddba）
commit: 066a777b（main）
branch: main
date: 2026-09-11 21:30–22:15（北京时间，owner 在场逐项授权夜间执行）
owner: 用户授权（2026-09-11 对话：「按照你推荐的做吧」→ 口径归还；「现在就用mgreplay用户做测试」；「qwen-3.7 移除」；「我在上游更新了qwen3.8-flash」）
agent 执行
change_type: code + 生产任务修订（rev24）
```

- **行业复盘口径归还 agent 判断区**（5fde450，推翻同日 rev23 扩词表方案 ea1ee19）：rev22/rev23 两代申万词表枚举都违反「服务层只接管格式类不变量」「模型裁判优于硬规则」——一级/二级粒度是业务口径判断。col4 列规则降级为 `kind:text` 格式级（required + maxLength:30 + balancedBrackets 截断特征检测）；口径约束（一级/二级均可、同日一致、名称完整禁截断）写入任务说明。枚举/注释形态匹配保留为通用原语不再绑本任务。**边界坑**：automation-tasks 归一化逐字段白名单拷贝会静默剥新字段，已补 maxLength/balancedBrackets 透传 + 边界测试钉死。
- **mgreplay 全链验证通过后真实任务切 rev24**：镜像任务（mgreplay-industry-chain-test）新建空白工作簿 + rev2 新规则口径说明，手动触发真实执行链——succeeded（3m10s，腾讯板块口径 31 行业 + 东财涨停池 40，前 10 全一级名完整入库，模型自选粒度无词表干预）；rev2 规则字段穿透完整。验证通过后 `scripts/industry-review-caliber-to-agent.mjs` 把真实 mg 行业复盘任务提交 rev24（edit_source_ref=industry-caliber-to-agent-20260912，active，next_run 周一 19:30）。
- **qwen3.7-flash 下线**（5e13ddb，owner 裁决）：文本/图片双链移除、选择器出册；9-9/9-10 行业复盘参数字符串化事故档。model-pricing 条目保留供历史用量计费。生产无任务 pin qwen（已核 instruction 与 settings）。
- **qwen3.8-flash 上架**（066a777，owner 上游开放替代档）：网关探针 `qwen3.8-flash` HTTP 200（`qwen-3.8-next` 无通道，ID 以探针为准），顶回原 qwen 链位（glm 与 deepseek 之间，双链 + 选择器）；计价暂沿用 3.7 档 0.6/2.4 占位**待 owner 确认官方牌价**。

## 验证证据

| 门类 | 结果 | 证据 |
| --- | --- | --- |
| 确定性测试/类型检查 | pass | `npm test` 673/673（含 text 规则 ×2、边界字段存续 ×1、链序 ×2）；`tsc --noEmit` 零错 |
| 边界字段存续 | pass | create/update 归一化后 col4=`{kind:text,required,maxLength:30,balancedBrackets:true}` 不剥离；maxLength=0 边界拒绝 |
| mgreplay 全链 | pass | atrun_6c4255a2 succeeded（13:56–14:00Z）；新工作簿 10 行入库，col4=通信/建筑材料/国防军工/传媒/美容护理/纺织服饰/钢铁/综合/家用电器/环保（完整一级名，日期 2026-09-11）；rev2 规则字段完整 |
| 真实任务 rev24 | pass | rev23→rev24（服务层 revision 链+审计）；col4 格式级、口径行入说明、active、next_run=2026-09-14T11:30Z |
| qwen 探针 | pass | 上游 chat/completions：qwen3.8-flash→200，qwen-3.8-next→503 model_not_found |
| 生产部署 | pass | 两版 deploy-volcano.sh 全流程；末版 release.json=20260911T224500Z-066a777b；runtime /health ok；链快照 terra→luna→glm→qwen3.8-flash→deepseek→doubao，选择器六档 |

## 灰度与观测

- **周一 19:30 行业复盘自然 run 是 rev24 首验**：预期二级名（若当日主线在二级粒度）放行入库、名称截断仍被括号检测/说明约束拦截；mgreplay 镜像任务同档 next_run 作对照组。
- 遗留（owner 裁决项）：①9-8~9-11 四个交易日行业复盘缺行补录（9-11 行卡腾讯网关故障，21:56 起 mgreplay 侧已能取数，真实任务可在网关稳定后手动重跑补当日行）；②9-4/9-7 已入库漂移行修正版本方案；③qwen3.8-flash 官方牌价确认。
- 回滚：代码=`git revert 066a777b/5e13ddb/5fde450` 重发；rev24=重跑 align 脚本按词表恢复（revision append-only，rev23 原样保留）；模型链=qwen3.8 移除即回 3.7 下线态。
