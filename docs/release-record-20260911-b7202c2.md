# 发布记录：20260911T111000Z-b7202c2

按 [release-governance-evidence-template.md](./release-governance-evidence-template.md) 口径记录。known-good 已标记。

## 变更摘要

```text
release_id: 20260911T111000Z-b7202c2
commit: b7202c2（main）
branch: main
date: 2026-09-11 11:05–11:11（北京时间，白天发布惯例）
owner: 用户授权（2026-09-11 对话：「按照这个建议去修复，然后使用mgreplay用户做测试」）
agent 执行
change_type: code（服务层格式类不变量，无安全面改动）
```

- 背景：ED-P2 W37 补评（T-457）暴露行业复盘「质量控制失效链」——9-4 追加行列错位（11 列）、9-7 申万二级宇宙漂移+名称截断+资金流「数据缺失」、9-8 超时、9-9/9-10 连续零写入空转均以 succeeded 终态静默通过；巡查 9-7 的「17 列契约通过」验证的实为空契约。
- 根因定性（证据=automation_tool_payloads atrun_65f278cb/atrun_44bf2b5b 全量载荷）：**非服务层序列化 bug**——兜底档模型 qwen3.7-flash 把 number/boolean/object 工具参数字符串化（`"50"`/`"True"`/`"{}"`）被 zod/MCP 校验整批拒绝；同时行业复盘任务因大上下文逐层耗尽 terra/luna/glm 后固定落穿到 qwen。9-10 巡查的「服务层参数序列化 bug 接近 confirmed」被模型自述误导，本次纠正。
- 四项修复（详单见 commit b7202c2）：
  1. 工具入参宽容矫正（`src/mastra/lenient-tool-input.ts`）：严格校验失败时按声明类型（zod shape / MCP jsonSchema）还原字符串后重校验，仅在整体通过时采用；正常路径零改动。内置服务工具与外部 MCP 双通道接入（框架 workspace 工具未包，有 assets.version.read 替代路径）。
  2. 零写入收口：update 任务 `outputSkipped` 必须携带 `skipReason`——`duplicate` 维持成功，`no_data` 抛 `AUTOMATION_RUN_ZERO_WRITE_NO_DATA`（validation_failed）触发 T-479 失败通知，不再静默空转。
  3. expectedSchema 真实列头推导：合并标题行（A1:Q1）被 ExcelJS 铺满 17 格致旧推导把标题行当表头（rev21/rev8 空 schema 的来源，同时污染注入给模型的 spreadsheetContext）；计数剔除合并覆盖格后真实表头行（r2）胜出。
  4. columnRules 列语义校验：枚举白名单/数值/日期/必填/显式缺失标注随契约绑定，appendRows 违规回喂自纠、仍失败则 run 失败；申万一级 31 行业白名单（`scripts/industry-review-column-rules.json`）同时承担口径漂移与截断检测。另：推送正文双层 JSON 信封剥离（与 BC-20260904-001 质量下限同位，落库原文不动）。
- 生产数据动作（owner 已授权，先备份）：`runtime.db.bak-pre-revcut-20260911` 后经 `scripts/align-mg-workbook-schema.mjs` 走服务层 revision 链提交 rev22（行业复盘，17 列 headerRow=2 + 6 条列规则）与 rev9（持仓复盘，10 列 headerRow=2），任务保持 active，行业复盘 next_run=今晚 19:30。`.env`、Workspace、`reviews/`、`.state/`、微信状态零触碰。

## 验证证据

| 门类 | 结果 | 证据 |
| --- | --- | --- |
| 确定性测试/类型检查 | pass | `npm test` 669/669（新增 24 例：矫正器 3、列规则/推导 4、信封 2、契约翻转 15）；`tsc --noEmit` 零错 |
| 零写入契约 | pass | no_data→failed+AUTOMATION_RUN_ZERO_WRITE_NO_DATA+validation_failed；缺 skipReason→自纠一次；duplicate→succeeded（既有幂等判重路径不变） |
| 推导修复回归 | pass | 合并标题行 fixture headerRow=2+真实 17 列头；无标题表行为不变 |
| 列语义校验 | pass | 9-4 列错位形态/9-7 二级宇宙+截断形态被拒并触发自纠；对齐行通过；显式「数据缺失」放行；无规则契约零行为变化 |
| 矫正器 | pass | 生产证据形态（limit:"50"/stage:"True"/input:"{}"）全部还原；非数字串仍拒；声明 string 字段不改型；jsonSchema 成员透传 |
| 生产部署 | pass | deploy-volcano.sh 全流程，PM2 双进程 online，runtime 23655=401 正常鉴权 |
| mgreplay 全链测试 | pass | 镜像任务（17 列契约+列规则）真实执行链：terra 首字超时→轮内兜底 glm-5.3-flash 完成；10 行追加全部 17 列对齐（日期列 2/pt 代码列 3/申万一级名列 4），判重列正确落在复盘日期，白名单零违规 |
| 故障演练 | pass | 回滚=`git revert b7202c2` 重发；rev22/rev9 回滚=重跑 align 脚本按备份 DB 恢复指针（revision append-only，rev21/rev8 原样保留） |

## 灰度与观测

- 观察点（下次巡查顺带）：①今晚 19:30 行业复盘自然 run——首个真实业务全链验证（9-8~9-10 三日缺行是否补录由 owner 裁决，修复未自动补数）；②持仓复盘明晨 09:30 首个 rev9 run；③若再落穿到 qwen，观察其工具调用成功率（矫正器生效证据=automation_tool_payloads 中不再出现 "Tool input validation failed"+字符串参数形态）；④no_data 失败通知（T-479）首例出现时的 owner 体验。
- 遗留（owner 裁决项，未自动处理）：①9-8~9-10 三个交易日行业复盘缺行是否补录；②9-4（11 列错位）/9-7（二级宇宙）已入库行的修正方案——H2 不动历史原则下建议新建修正版本而非改写；③盯盘聚合式简报（80 字）可接受性= T-457 分歧样本待复核。
- 回滚触发：今晚行业复盘 run 失败且归因指向新契约/列规则；或矫正器在生产引发正常调用误改型（设计上仅严格失败时介入，理论不可能，仍留观察）。
