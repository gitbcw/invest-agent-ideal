# 模型评测报告：glm-5.3-flash 与 qwen3.7-flash 双层对照实验（2026-08-27）

> 状态：共创期首轮系统化模型评测（owner 发起）。数据、脚本、任务全部留档可复现。
> 范围声明：本文档记录 2026-08-26 晚至 08-27 的一整轮诊断与评测，受测系统为 invest-agent-mastra 生产分支（feat/mastra-migration），受测模型为智谱 glm-5.3-flash 与阿里 qwen3.7-flash（owner 明确排除 DeepSeek 系）。

## 摘要

本报告在真实生产链路上对 glm-5.3-flash（思考档 low/high/max）与 qwen3.7-flash（思考开/关）做了双层对照评测：层1 直连官方 API 测 6 类单次任务（120 样本），层2 在系统内无限制模式（`AUTOMATION_UNLIMITED=1`）下测 2 类真实自动化任务。核心发现四条：**（1）重型结构化任务上思考深度与完成度倒挂**——glm low 档是行业复盘级任务唯一通过的配置（346s/¥0.29），high/max 档耗时 4-8 倍、成本 2-6 倍且全部栽在输出契约的机械细节上；**（2）max 档存在独立于质量之外的不可预测性**——同题三跑耗时极差 173 秒；（3）qwen 的能力分界清晰——中等复杂度扫描任务可用（65s ✅），重型多源契约任务会空转（268 万输入 token ❌）；（4）步数/时间上限实际是成本保护。据此给出模型路由建议表与预算维持建议。实验过程中顺带发现并修复了 4 个系统缺陷、纠正了 2 次误诊，均记录在 §3 编年与 §5 发现中。

## 1. 背景与目标

- **业务背景**：mg 用户的行业复盘自动化任务 2026-08-26 19:30 失败（vision-exp 输出混排 JSON 被判无效）。owner 决策将国产兜底位换为当日新模型 glm-5.3-flash，随后引发连锁诊断与评测需求。
- **评测动机**（owner 原则）：系统处于共同创建阶段，应**先不设限跑出真实轨迹**（耗时/token/成本/步数分布），再反推预算与模型路由的最优解；同时需要量化「思考 vs 不思考」的差价。
- **目标**：①建立可复现的双层评测设施；②跑出两模型×思考档×任务类型的基线数据；③产出模型路由建议、预算建议与成本模型；④发现系统优化点。

## 2. 实验设计

### 2.1 受测系统与环境

| 项 | 值 |
| --- | --- |
| 系统 | invest-agent-mastra（Mastra runtime + AI SDK v5 + openai-compatible provider） |
| 网关 | new-api（阿里云 47.107.151.70:3000，自定义镜像 custom-429fix-v2） |
| glm 通道 | 渠道 id=16 "zai"（type 26 智谱原生适配，open.bigmodel.cn） |
| qwen 通道 | 渠道 id=15 "qwen"（type 1 OpenAI 兼容，百炼 compatible-mode） |
| 评测工作区 | mgreplay 用户（隔离资产副本，不触碰真实用户数据） |

### 2.2 双层架构

- **层1（模型能力层）**：直连两家官方 API（密钥从网关渠道表读出、环境注入、不落盘），完全绕开 new-api——参数任意设、零生产影响。回答「模型本身在不同思考深度下什么表现、多少钱」。
- **层2（系统表现层）**：走完整生产链路（调度→agent 循环→MCP 工具→工作簿提交），用 `AUTOMATION_UNLIMITED=1` 放开限制（attempt 570s→3600s、工具 30→200、步数 30→50），仅注入评测进程环境。回答「在真实系统里、不给预算约束时，各配置的真实轨迹是什么」。

### 2.3 模型与档位

| 格子 | 模型 | 思考档 | 参数写法 | 说明 |
| --- | --- | --- | --- | --- |
| G-low | glm-5.3-flash | low | `reasoning_effort:"low"` | 思考近关 |
| G-high | glm-5.3-flash | high | `reasoning_effort:"high"` | 中等（官方三档的中间档） |
| G-max | glm-5.3-flash | max | `reasoning_effort:"max"` | glm-5.3 官方默认档（深度推理） |
| Q-on | qwen3.7-flash | 思考开 | `enable_thinking:true` | |
| Q-off | qwen3.7-flash | 思考关 | `enable_thinking:false` | |

注：glm-5.3 系官方不支持关闭思考（`thinking.type` 仅 `enabled`），只有档位。

### 2.4 任务集

**层1（6 类 8 题，单轮对话，直连）**：chat-short ×2（一句话市场要点；北交所 vs 主板打新规则）、chat-complex ×2（利率-成长股传导路径+反例；散户是否放弃选股的正反论证）、stock-pick（7 持仓+宏观环境的组合评估与加减仓建议）、tech-analysis（茅台 5 日 K 线数据的技术解读）、structured（5 行小 JSON）、structured-big（12 行业大 JSON 表）。

**层2（2 类真实自动化，含工具调用与工作簿提交）**：
- **T-A 行业复盘**（重型）：读绑定工作簿（17 列）→ 拉涨停池/行业资金流矩阵/个股资金流 → 交叉核对 → appendRows 追加。每轮重置到 mg 原始 v9 快照保证档位可比。
- **T-B 技术扫描**（中型）：8 股池 → 批量 60 日 K 线 + MACD/KDJ/BOLL + 实时价 → 11 列技术评估表追加。

### 2.5 指标与定价

每样本记录：总耗时、首块/首正文字时、输入/输出/思考 token、finish_reason、成功率、内容长度。层2 加：工具调用次数（`external_mcp_tool_calls` 表）、运行终态、工作簿版本产出。

定价（元/百万 token，单一价）：glm-5.3-flash 输入 0.8 / 输出 2.8（owner 折算 2026-08-27，glm-5.3 牌价 1/10）；qwen3.7-flash 输入 0.6 / 输出 2.4。思考 token 计入输出。

## 3. 实验编年（含误诊与翻案——方法论部分）

按时间顺序，全部实验留有日志与数据库证据：

| # | 实验 | 结果与结论 |
| --- | --- | --- |
| E0 | 生产事故复现（mg 行业复盘 8-26 19:30 失败） | 根因：vision-exp 输出「英文叙述+裸 JSON」无围栏，解析器整判无效。修复：`parseStructuredAcpResponse` 兜底抽取最后一个顶层平衡 JSON（commit c57eb27） |
| E1 | glm 进链后锁模回放 ×2 | **起跑即炸**：`MASTRA_MAX_STEPS_INVALID:30`——发现 run-turn.ts 与 agent-factory.ts 两道独立的 maxSteps=20 硬顶，与已上线的预算 30 冲突。修复：双守卫放宽至 50（58dd2c9+a8018cb）。**若非回放发现，当晚所有自动化任务都会同签名失败** |
| E2 | 卡死现象调查（3 轮 8 分钟零首字） | 误诊①「传输黑洞」：透明代理实验中 AI SDK 经代理正常完成 3 步，直连零首字，判定 undici 连接层黑洞。**翻案证据**：`external_mcp_tool_calls` 表显示被判「零进度」的直连运行第 300 秒完成 3 次工具调用——全程在推进，死因始终是任务总时长（~640s）超 attempt 预算（480/570s）。Connection:close 修复上线下线（891081f→a88d61f） |
| E3 | 请求级思考档位 A/B | 三档思考量无差异 → 抓包发现请求体根本不含 `reasoning_effort`：智谱渠道（type 26）`pass_through_body_enabled=false` 会**重建请求体**丢弃未知参数；另 Mastra `agent.stream` 会丢 `providerOptions`（GPT 的思考注入同样未生效）。**有效通道是渠道级 `param_override` 字段**（合并进上游请求且智谱执行） |
| E4 | 档位量化（网关渠道级注入） | 中提示思考量：默认 747-1676 → low 0 / high 0-182；重载单步：默认 160-180s → high 131-152s → **low 14-24s**。渠道定 low |
| E5 | 工具清单规模测量（抓包） | 自动化轮请求含 **90 个工具 / 38,743 输入 token**（服务层 allowlist 只在执行时拦截，清单未裁剪）。修复「授权即清单」：按 mcpAllowedTools 裁服务工具 49→11，总清单 90→56、输入 38.7k→24.7k（6d6a5bc，全模型受益） |
| E6 | 误诊②「reasoning 不可见」 | 推测 45s 首字看门狗会掐死长思考轮。**翻案**：极小探针实测 firstToken=6029ms——思考流一直可见（Mastra 透传 reasoning-delta→payload.text，解析器候选字段已覆盖）。真实缺口是**超时轨迹不记 firstTokenMs/toolCalls**（监控盲区，两次误导诊断）。修复：错误轨迹携带 firstTokenMs（4da60c5） |
| E7 | 预算调整 | attempt 480s→570s（570+300 兜底+30 提交=900s 恰满 15 分钟租约；891081f） |
| E8 | 端到端验证 | 渠道 low 档下 glm 完整跑通行业复盘：256s、31 行入表、¥0.20（run atrun_7fbd3631） |

随后进入正式评测（§4）。

## 4. 结果

### 4.1 R1：层1 首轮矩阵（8 任务 × 5 格）

| 模型@档 | 成功率 | 平均耗时 | 最长耗时 | 平均思考tok | 平均出tok | 单次成本 |
| --- | --- | --- | --- | --- | --- | --- |
| glm low | 8/8 | 13.0s | 39.8s | 0 | 503 | ¥0.0015 |
| glm high | 8/8 | 16.5s | 43.3s | 202 | 713 | ¥0.0021 |
| glm max | 8/8 | 79.0s | 199.2s | 2,675 | 3,260 | ¥0.0092 |
| qwen 思考开 | 8/8 | 17.5s | 44.2s | 1,827 | 2,307 | ¥0.0056 |
| qwen 思考关 | 8/8 | 5.2s | 13.6s | 0 | 676 | ¥0.0017 |

分任务要点（耗时/思考tok）：stock-pick 上 glm max 199s/5,873 vs low 19s/0；tech-analysis 上 max 184s/6,637 vs low 40s/0；qwen 思考关在全部 6 类任务都是最快档。完整明细见阿里云 `eval-layer1-results.json`。

### 4.2 R2：层2 行业复盘对照（无限制、每轮重置工作簿）

| 配置 | 耗时 | 输入tok | 思考tok | 工具调用 | 成本 | 终态 |
| --- | --- | --- | --- | --- | --- | --- |
| **glm low** | **346s** | 305,343 | 11,709 | ~7 | **¥0.29** | ✅ **通过**（另：限额版 256s/¥0.20 亦通过） |
| glm high ① | 550s | — | — | 8 | — | ❌ 上游连接中断（`terminated`） |
| glm high ② | 1,258s | 1,085,850 | 35,349 | 9 | ¥1.04 | ❌ stagedOutput fileName/base64 不合法 |
| glm max | 1,330s | 473,535 | 63,633 | 16 | ¥0.57 | ❌ **列数写错（16≠17）** |
| qwen3.7 | 331s | **2,682,795** | 16,732 | 4 | ¥1.70 | ❌ update 目标错 |

### 4.3 R3：层1 三遍方差轮（120 样本，100% 成功）

| 模型@档 | 耗时均值±σ(ms) | 思考均值±σ(tok) | 耗时极差(ms) | 成本 |
| --- | --- | --- | --- | --- |
| glm low | 13,311±8,989 | 6±14 | 35,263 | ¥0.0014 |
| glm high | 18,307±16,469 | 179±232 | 50,822 | ¥0.0020 |
| **glm max** | **83,504±56,960** | 2,912±1,884 | **173,382** | ¥0.0098 |
| qwen 思考开 | 18,659±12,813 | 1,569±916 | 41,706 | ¥0.0050 |
| qwen 思考关 | 5,865±5,171 | 0±0 | 16,943 | ¥0.0016 |

「最不稳定格子」Top 6 全部为 glm max（chat-complex σ=29.2s、chat-short σ=20.0s、stock-pick σ=18.4s…）。

### 4.4 R4：层2 技术扫描任务（中型自动化）

| 配置 | 耗时 | 首字 | 输入tok | 工具调用 | 成本 | 终态 |
| --- | --- | --- | --- | --- | --- | --- |
| glm low | 133s | 5,945ms | 117,060 | 11 | ¥0.11 | ✅ 通过（支撑压力取自实际 K 线高低点，来源口径完整） |
| qwen3.7 | 65s | 2,323ms | 293,458 | 17 | ¥0.20 | ✅ 通过（每股金叉/死叉/KDJ 状态为真实判断） |

## 5. 发现（Findings）

- **F1 思考深度与重型任务完成度倒挂**（R2）：low 是唯一通过 T-A 的配置；high/max 耗时 4-8 倍、成本 2-6 倍，且两档四次失败全部是**输出契约违规**（列数、文件名、目标 ID）——思考越多，长途后越容易偏离机械格式。对以结构化输出为主的自动化系统，轻思考不是妥协而是最优。
- **F2 max 档不可预测**（R3）：σ/μ≈68%，同题三跑极差 173s，思考量 σ 最高 ±1,188。即使愿意付出时间成本，体验也是抽奖式的。
- **F3 qwen 能力分界**（R2 vs R4）：中型目标明确的扫描任务可用且最快；重型多源交叉+严格大表契约任务会陷入步数空转（268 万输入 token ≈ 27 轮重读上下文）后仍产出错误目标。
- **F4 预算限制是成本保护**（R2）：无限制模式暴露了空转的真实代价（qwen ¥1.70 vs low 成功轮 ¥0.29）。步数/时间上限在生产中应保留。
- **F5 思考量由任务复杂度驱动而非输入长度**（E2/E5 对照）：21.7k token 重复填充只引发 0.5-1.2k 思考；同规模多样化工具清单引发 ~1 万。
- **F6 生成速度恒定 ~50-60 tok/s**：时间 ≈（思考+输出）÷ 速度。low 档下任务耗时逼近纯内容生成地板（256s ≈ 13.6k 输出 token ÷ 53/s）。
- **F7 思考参数的生效路径是运维关键**（E3/E4）：type-26 渠道重建请求体丢请求级参数；渠道级 `param_override` 是有效注入点（改动需 sudo sqlite3 + docker restart，影响渠道全部模型）。qwen 的 type-1 渠道直连时请求级 `enable_thinking` 有效，网关级未验证。
- **F8 监控盲区会制造系统性误诊**（E2/E6）：超时轨迹曾不记 firstTokenMs/toolCalls，导致「零进度」「零首字」两次误读。修复后判断运行进度的权威数据源是 `external_mcp_tool_calls` 表 + 轨迹取证字段。

## 6. 结论与建议

### 6.1 模型路由建议表（数据支撑版）

| 场景 | 推荐 | 备选 | 依据 |
| --- | --- | --- | --- |
| 日常对话/轻问答 | qwen 思考关 | glm low | 5.9s 均值、¥0.0016、方差最小（R3） |
| 中型分析（技术扫描/选股评估） | glm low（稳） | qwen（快 2 倍、token 多 2.5 倍） | R4 双通过 |
| 重型自动化（行业复盘级） | glm low | vision-exp（链内兜底） | R2 唯一通过 |
| 深度推理（用户明确要慢思考） | glm high 封顶 | — | max 又慢又贵又不可测（F1/F2） |

### 6.2 预算维持建议

attempt 570s / 工具 30 次 / 步数 30 维持不变：成功轮实测 133-346s、4-16 次工具，上限有裕量且挡住空转（F4）。`AUTOMATION_UNLIMITED` 仅评测用，不进生产 .env。

### 6.3 成本模型（月度估算基础）

单次对话 ¥0.0014-0.0098（档位决定）；技术扫描级自动化 ¥0.11-0.20；行业复盘级 ¥0.20-0.29（low）。例：行业复盘每日 1 次 × 30 天 ≈ ¥8.7/月（glm low）。

### 6.4 系统优化沉淀（本轮已上线）

解析兜底（c57eb27）、maxSteps 双守卫 50（58dd2c9+a8018cb）、工具清单授权即清单（6d6a5bc）、attempt 570s（891081f）、错误轨迹 firstTokenMs 取证（4da60c5）、锁模机制（59bd5f3）、不设限开关（272cd46）。

## 7. 局限性

1. 层2 每配置仅 1-2 轮，档位间结论方向明确但样本量小；层1 每格 3 遍仅覆盖当日上游状态，未跨时段。
2. 质量评估以客观指标为主（成功率/格式合规/工具正确性/来源交代），内容深度未做盲评——「深度推理 max 更好」不能被证伪，只证明了「用户要等 80-200s 且方差极大」。
3. qwen 思考开关经 type-1 渠道的网关级透传未验证（层1 是直连）；glm 渠道 param_override 影响渠道全部 4 个模型（glm-5.2/5-turbo 已验证无恙）。
4. 模型为 2026-08-27 快照版本，上游更新可能改变结论；复跑 §9 命令即可刷新。
5. 工作簿状态敏感：层2 必须每轮重置（脚本已内置），否则任务会轻量收尾导致档位不可比。

## 8. 产物清单

| 类别 | 位置 |
| --- | --- |
| 层1 脚本/数据 | 阿里云 `/home/admin/eval-layer1.mjs`、`eval-layer1-results.json`（120 样本）、`eval-variance.mjs`、日志 `eval-layer1*.log` |
| 层2 脚本 | 火山 `/home/claude/replay-fresh.mjs`（行业复盘 fresh）、`replay-techscan.mjs`（技术扫描）、`replay-mgreplay-industry*.mjs`、日志 `/home/claude/replay-*.log` |
| 运行证据 | runtime.db：`agent_traces`（含 firstTokenMs 取证）、`automation_task_runs`、`external_mcp_tool_calls` |
| 留档任务 | mgreplay 用户下全部 paused 任务（行业复盘对照-*、技术面扫描（对照-*）等） |
| 网关配置 | 渠道 16 param_override={"reasoning_effort":"low"}（生产现值） |
| 代码提交 | c57eb27 / d43ff85 / 58dd2c9 / a8018cb / 59bd5f3 / 8938c58 / 6d6a5bc / 891081f / a88d61f / 4da60c5 / 272cd46（均 feat/mastra-migration） |

## 9. 复现指南

### 9.1 层1（模型矩阵，阿里云）

```bash
ssh admin@47.107.151.70
cd /home/admin
GLM_KEY=$(sudo sqlite3 /home/admin/new-api/data/one-api.db "SELECT key FROM channels WHERE id=16") \
QWEN_KEY=$(sudo sqlite3 /home/admin/new-api/data/one-api.db "SELECT key FROM channels WHERE id=15") \
QWEN_BASE=$(sudo sqlite3 /home/admin/new-api/data/one-api.db "SELECT base_url FROM channels WHERE id=15") \
node eval-layer1.mjs          # 单遍；脚本已改 3 遍版则直接出 120 样本
node eval-variance.mjs        # 方差汇总
```

### 9.2 层2（系统内自动化，火山）

```bash
ssh claude@118.145.115.197
cd /home/claude/invest-agent-mastra
# 行业复盘（每轮自动重置工作簿到 mg v9 快照）：
AUTOMATION_UNLIMITED=1 AUTOMATION_TASK_LEASE_MS=5400000 \
GENERIC_AUTOMATION_MODEL=glm-5.3-flash \
node --env-file=.env /home/claude/replay-fresh.mjs <标签>
# 技术扫描：
AUTOMATION_UNLIMITED=1 AUTOMATION_TASK_LEASE_MS=5400000 \
GENERIC_AUTOMATION_MODEL=qwen3.7-flash \
node --env-file=.env /home/claude/replay-techscan.mjs <标签>
```

### 9.3 glm 思考档位切换（阿里云网关，影响渠道全部 glm 模型）

```bash
sudo sqlite3 /home/admin/new-api/data/one-api.db \
  "UPDATE channels SET param_override='{\"reasoning_effort\":\"<low|high|max>\"}' WHERE id=16"
docker restart new-api
```

### 9.4 轨迹取证（火山）

```sql
-- 单次运行的完整画像
SELECT status, elapsed_ms, first_token_ms, input_tokens, output_tokens, thought_tokens
FROM agent_traces WHERE trace_id = '<run_id>';
SELECT tool_name, status, elapsed_ms, created_at FROM external_mcp_tool_calls
WHERE run_id = '<run_id>' ORDER BY id;   -- 判断真实进度的权威数据源
```

## 10. 后续计划

- 共创期每周复跑一轮层1 矩阵积累纵向数据；生产 `agent_traces` 作为层2 持续数据源。
- 攒至月底出正式预算定版与模型路由表（数据充足后把 §6.1 从建议升级为契约）。
- 待办：qwen 网关级思考开关验证；层2 增加「盯盘规则」「周报月报」任务类型；内容深度盲评方案。

---

*实验执行：ZCode（combo 会话）；发起与裁决：owner；2026-08-27。*
