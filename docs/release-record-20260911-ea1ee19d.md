# 发布记录：20260911T205500Z-ea1ee19d

按 [release-governance-evidence-template.md](./release-governance-evidence-template.md) 口径记录。

## 变更摘要

```text
release_id: 20260911T205500Z-ea1ee19d
commit: ea1ee19（main）
branch: main
date: 2026-09-11 20:30–20:55（北京时间；owner 在场迭代授权，同 9-3 晚间先例）
owner: 用户授权（2026-09-11 晚对话：「二级行业名本身没问题的……重点在于mg用户这个任务失败」）
agent 执行
change_type: code + 生产任务修订（校验器匹配语义放宽，无安全面改动）
```

- 背景：同日早间 b7202c2 上线的列语义校验当晚即拦截 mg 行业复盘 5 行——模型按指令「当日涨幅前 10 行业」写了申万二级名（通信设备、元件(PCB)、兵装(地面兵装)、电网设备、玻璃玻纤；当日主线在二级粒度，新闻源亦以二级口径表述），被申万一级 31 名单判为口径漂移、整轮失败。owner 裁决：**二级行业名合法**。
- 代码修复（commit ea1ee19）：
  1. `scripts/industry-review-column-rules.json` 第 4 列 enumValues 扩为**一级 31 ∪ 二级 131**（akshare 官方申万清单，自生产 venv 实拉；腾讯网关当晚故障，清单端点不可用）。
  2. `validateRowsAgainstColumnRules` 枚举匹配支持注释形态：尾部括号按主体或括号内取值比对（元件(PCB)→元件、兵装(地面兵装)→地面兵装），比较忽略尾部Ⅱ/II/2 版本后缀（地面兵装Ⅱ≡地面兵装）；**截断值（通信设）仍拒**，截断检测保留。错误文案同步提示可接受形态。
  3. 测试更新：9-7 用例改为截断拒绝；新增二级精确/括号主体/括号内取值/去Ⅱ四种放行形态 + 截断仍拒；全量 671 绿。
- 生产数据动作（owner 已授权）：deploy 后 `scripts/align-mg-workbook-schema.mjs --rules=…industry-review-column-rules.json` 提交 **rev23**（17 列 headerRow=2，第 4 列 162 值白名单），任务保持 active，next_run=2026-09-14（周一）19:30。指令未动（原文即不限一级/二级，限制只来自白名单）。`.env`、Workspace、`reviews/`、`.state/`、微信状态零触碰。
- **当日行（9-11）补录受阻**：腾讯网关 19:30 后整体故障（industry_list_sw1/overview/list 端点 SourceUnavailable，本机与生产 MCP 同源同错），重跑会在取数阶段失败，暂缓。网关恢复后手动重跑一次即可补当日行（非交易日快照仍为 9-11 收盘口径）；否则周一 19:30 自然 run 为 rev23 首验。

## 验证证据

| 门类 | 结果 | 证据 |
| --- | --- | --- |
| 确定性测试/类型检查 | pass | `npm test` 671/671；`tsc --noEmit` 零错 |
| 注释形态匹配 | pass | 元件(PCB)/兵装(地面兵装)/地面兵装(去Ⅱ)/通信设备(精确) 全放行；通信设(截断)仍拒 |
| 生产部署 | pass | deploy-volcano.sh 全流程，PM2 online，/health ok，release.json=20260911T205500Z-ea1ee19d |
| rev23 | pass | 落库核对 17 列/headerRow=2/第 4 列 162 值，通信设备/元件/地面兵装Ⅱ/玻璃玻纤在列；next_run 周一 19:30 |
| 当晚失败样本回归 | blocked | 网关故障无法即时重跑；周一自然 run 或网关恢复后手动重跑补验 |

## 灰度与观测

- 首验：周一 9-14 19:30 行业复盘自然 run（rev23 首个真实业务链）；若网关提前恢复，手动重跑 9-11 当日行即为更早验证点。
- 观察：若模型产出白名单外的自造简称（非截断、非括号形态），校验仍会拦截并自纠——属设计内；bad case 积累后再议是否进一步放宽。
- 回滚：代码=`git revert ea1ee19` 重发；rev23=重跑 align 脚本按旧 JSON（git 历史中 b7202c2 版本）重切 rev24（revision append-only，rev22 原样保留）。
