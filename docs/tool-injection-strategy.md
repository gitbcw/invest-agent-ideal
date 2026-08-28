# 工具注入策略：两段式发现（T-400 研究与设计定稿）

> 状态：现行指导文档（2026-08-28 制定，owner 裁决两段式方案）。回答"交互轮该给模型看多少工具、长尾能力如何按需到达"。落地实现与验收记录见 roadmap P2 条目。
> 关联：[model-routing-and-context-governance-roadmap.md](./model-routing-and-context-governance-roadmap.md)（P2 渐进式上下文）、[context-and-prompt-architecture.md](./context-and-prompt-architecture.md)（上下文分层）、[service-tools-mcp.md](./service-tools-mcp.md)（服务工具权威清单）、[model-evaluation-2026-08-27-glm-qwen.md](./model-evaluation-2026-08-27-glm-qwen.md)（E5 工具清单实测）。

## 0. 背景与裁决记录

- **服务端全挂**（owner 2026-08-27 裁决）：market-data-tool 作为独立数据服务把全部能力声明做好（36 工具），不替调用方裁剪；工具挂载数量与调用方注入是两层问题。
- **调用方单侧解决**（owner 2026-08-28 裁决）：不改 market-data-tool 的契约（它服务多个项目），注入策略完全由 P-33 调用方实现。
- **两段式发现**（owner 2026-08-28 选定）：常驻核心工具 + 目录工具 + 调度壳的渐进式披露（progressive disclosure）形态；主题动态组集（roadmap P2 原设想）留作后续叠加，先静态核心集起步。

## 1. 一手实测数据

### 1.1 注入成本

| 项 | 实测值 | 方法 |
| --- | --- | --- |
| market-data-tool 36 工具全量 schema | 23,376 字符 ≈ **7.8k token** | 本机 stdio 直连 `tools/list`（2026-08-28，与生产 af95b01 同版） |
| 交互轮全量工具面 | 90 工具 ≈ **38.7k token** | 生产网关抓包（评测论文 E5，2026-08-27） |
| 工具面构成 | 45 服务 + 36 market-data-tool + 4 qsse-qlib + 7 workspace + 2 skills | 代码盘点（TOOL_SPECS / external-mcp-registrations / workspace-registry） |
| 大头归属 | 服务工具轨道 ≈ 30k（占 4/5），mdt 仅占 1/5 | 38.7k − 7.8k −（qsse/workspace/skills） |

单工具 schema 174~1,274 字符；description 是体积大头——服务端"使用引导"（如 `get_sector_list` 描述 703 字符）全部住在 description 里。**只裁 market-data-tool 收益不足**（38.7k→约 35k，降幅仅 10%），服务工具轨道才是主战场。

### 1.2 生产 30 天调用画像（external_mcp_tool_calls，只读）

约 4,800 次外部 MCP 调用，**典型幂律**：

- 前 7 个工具（get_stock_news 689 / get_realtime_quote 581 / get_stock_profile 547 / get_hist_kline 487 / get_market_summary 391 / get_trading_calendar 248 / get_sector_list 238）占 **约 66%** 调用量。
- 长尾近零：get_industry_crosswalk 12 次、get_sector_limit_up 8 次、aggregate_peer_basket / compare_peers / get_board_fundflow_rank 0 次。
- 整体失败率约 3.3%（get_hist_kline 11% 为最高，属工具可靠性维度而非选择维度）。

结论：**"核心常驻 + 长尾按需"假设被数据支持**。注意长尾调用虽少但业务关键（如 get_industry_fund_flow_matrix 56 次是复盘链路必需）——按需到达必须可靠，不是砍掉。

### 1.3 思考成本（不只是输入成本）

评测论文 F5：多样化工具清单引发约 1 万思考 token，同规模重复文本仅引发 0.5-1.2k。工具面越大，模型"看菜单"的思考开销越高——两段式同时省输入与思考。

## 2. 行业最佳实践对照

### 2.1 Anthropic 官方 Tool Search（主要参照）

机制（[Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)）：工具定义照常提交但打 `defer_loading: true`，初始上下文只进 **3-5 个最常用工具 + 搜索工具（约 500 token）**；模型需要其他能力时先搜索，命中的工具才展开为完整定义进入上下文（平台能力，prompt caching 兼容）。

数据：50+ 工具 72K token 场景从 77K 降至 8.7K（**省 85%**）；准确率**提升**——Opus 4 工具选择准确率 49%→74%、Opus 4.5 79.5%→88.1%。官方启用判据：工具定义 >10K token / 10+ 工具 / 多 MCP server——**三条全中**。

官方最佳实践采纳：①常驻集压小（流程必备 + 高频 top5，而非 20 个）；②系统提示词说明工具类别并引导先搜索；③目录/描述质量是发现质量的地基（mdt 的 description 内建使用引导，质量达标）。

### 2.2 其他参照

- [Maxim AI 实测](https://www.getmaxim.ai/blog/tool-chaos-no-more-how-were-measuring-model-tool-accuracy-in-the-age-of-mcp/)：可用工具 48→25，所有模型选择准确率提升——削减工具面是准确率与成本双赢，不是妥协。
- [MCP-Bench](https://openreview.net/forum?id)（250 工具）/ [MCPVerse](https://arxiv.org/html/2508.16260v1) / [BoR rerank](https://arxiv.org/html/2605.24660v1)（20~3251 工具注册表）：工具数增长 → 选择准确率可靠下降的共识证据。
- [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)（**远期演进，P5 后再评估**）：工具变代码 API、中间结果不过模型、工具定义 150K→2K（省 98.7%）。需要代码执行沙箱，共创期不做。

### 2.3 与官方的必要差异

官方"搜索后注入完整 schema"依赖 Claude API 平台能力（defer_loading）。我们的模型 glm-5.3-flash 经 new-api 网关，无此平台能力 → **调用方自建等价物**：目录工具 + 调度壳。代价：长尾调用失去类型化参数 schema。缓解：目录带参数名与类型要点；服务端结构化错误回喂（调用错了可自纠）；写类服务工具有确认流兜底；验收把关选择准确率。

一处反而更简：我们长尾仅约 60 个，**目录一次全量返回约 1-2k token 即可，连搜索这一跳都省**——比官方还轻。长尾规模上台阶后再引入搜索（正则/BM25 或模型语义检索）。

## 3. 设计定稿：两段式发现

### 3.1 架构

```
交互轮工具面（改造后）
├─ 常驻核心（完整 schema，prompt-cache 友好）
│   ├─ 服务工具核心集 ~21：流程必备 16 + 高频读 5
│   ├─ mdt top5（get_stock_news / get_realtime_quote / get_stock_profile / get_hist_kline / get_market_summary）
│   ├─ 目录工具 ×2（svc.catalog / mdt.catalog，自动生成）
│   ├─ 调度壳 ×2（svc.call / mdt.call）
│   ├─ workspace 7 + skills 2（本就是渐进式披露形态，不动）
├─ 长尾 ~60（服务 ~24 + mdt 31 + qsse 4）：不进清单，经目录发现、经壳调用
└─ 开关：INTERACTIVE_TOOL_DISCOVERY=off 一键回全量（回退保障）
```

### 3.2 核心集构成

| 类别 | 工具 | 依据 |
| --- | --- | --- |
| 服务·流程必备 16 | confirmations.pending / confirmations.request / conversation.history / file.parse / spreadsheet.create / spreadsheet.transform / reviews.save / artifacts.publish / assets.list / assets.version.read / assets.version.commit / assets.conversation.save / assets.attachment.save 及资产核心读写 | 会话流程结构性依赖（确认流/附件/工作簿/复盘/资产），频次无关 |
| 服务·高频读 5 | portfolio.read / watchlist.read / plans.read / research.web_search / research.news_search | W13 持仓台账最高频（~40% 交互）+ 联网检索高频 |
| mdt·top5 | get_stock_news / get_realtime_quote / get_stock_profile / get_hist_kline / get_market_summary | 30 天调用画像前五（占外部调用 ~55%） |
| 目录+壳 | svc.catalog / svc.call / mdt.catalog / mdt.call | 两段式入口 |

长尾走目录的：automation×6、onboarding×4、watch_rules×6、method_changes×2、preferences.apply、写类确认型（portfolio.apply_changes 等，确认流兜底传参错误）、assets 管理类（rename/archive/delete，确认流兜底）、research.web_read、market_watch.snapshot、mdt 其余 31、qsse 4。

### 3.3 目录自动生成（零服务端配合、零人工维护）

- mdt.catalog：从连接层已拉取的全量 Tool 对象生成——每工具一行"名称：描述首句；参数：名列表"，缓存随连接 TTL（10 分钟）刷新。mdt 的 description 质量好（内建使用引导），首句即够。
- svc.catalog：从 TOOL_SPECS（单一真相，有 parity 测试护栏）同样生成。
- 新工具上线即自动进目录，无需同步动作。

### 3.4 调度壳

- mdt.call：闭包持有 observer 包装后的全量 Tool map，delegate 到 `fullToolset[toolName].execute(args)`——**审计（external_mcp_tool_calls）、连接管理、重试全部自动继承，零新审计代码**；未知工具名返回结构化错误并提示先查目录。
- svc.call：走 `checkToolScope`（执行时鉴权兜底）+ `callServiceTool`——确认流、审计、scope 全部继承。
- 提示词引导（agent-instructions.ts 工具使用原则段）："数据与管理类长尾工具先查目录（catalog）确认名称与参数，再用 call 调用"。

### 3.5 收益账

| 方案 | 交互轮工具面 | 降幅 |
| --- | --- | --- |
| 现状（全量） | 38.7k token | — |
| 仅裁 mdt | ~35k | 10%（不够） |
| 两段式（本设计） | **~16-18k** | **~55%**（超 roadmap P2 的 ≥40% 目标） |

## 4. 验收方案（对应任务验收③）

1. **token 实测**：部署后生产 trace 输入 token 前后对照（同任务类型），目标降幅 ≥40%。
2. **工具可得性**：169 轮交互分类语料抽样检查——每轮所需工具均在常驻集或目录可达；mgreplay 沙箱回放速查/复盘任务零"工具缺失"。
3. **选择准确率**：壳调用错误率（error_class 分布）+ 目录查询→调用转化观测；必要时引入 agentdx bench 做静态基准。
4. **回退演练**：开关关闭后恢复全量清单。

## 5. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 壳调用失去类型化 schema，传参错误 | 目录带参数要点；服务端结构化错误回喂；写类确认流兜底；观测壳 error 分布 |
| mastra 对 toolsets 工具名的 serverId 前缀展平 | 实现时先回放验证最终下发命名，目录内名称与展平名对齐 |
| 长尾任务多一跳（查目录再调用） | 目录一次全量返回无搜索跳；高频任务不受影响（常驻） |
| 行为回退需求 | INTERACTIVE_TOOL_DISCOVERY 环境开关一键回全量 |

## 6. 与 roadmap P2 的关系

本设计是 P2「渐进式上下文：工具清单按需供给」的落地形态。原 P2 设想"裁判模型判主题 → 静态映射表注入子集"修订为：**静态核心集 + 目录 + 壳先落地**（简单、缓存友好、数据支持），主题动态组集作为后续叠加选项（裁判模型已在判深度，扩展输出主题标签的改造成本低，待两段式稳定后按摩擦驱动决定）。度量目标不变：交互轮平均输入 token ↓≥40%、工具缺失类 bad case 为零。
