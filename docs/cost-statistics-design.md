# 开销统计重建设计（Cost Statistics Design）

状态：**2026-08-16 币种重述为人民币 + 上线统计起点切换**（用户裁决：①计价币种改人民币；②过往统计本就不准，上线时点用 `mastra-cost-archive-reset.mjs --purge` 把旧 trace 归档 JSONL 后整体移出统计表——token 与成本都从上线从零累积，不回填历史；上线后新 trace 按人民币表写入时计价。归档在服务器 `data/archives/agent-trace-cost-*.jsonl`，迁移重跑后须再执行一次）；C1-C4 机制不变，npm test 480/480
关联：[mastra-architecture-baseline.md](./mastra-architecture-baseline.md) D24/E10、[mastra-main-parity-verification.md](./mastra-main-parity-verification.md)
裁决来源：D24（2026-08-15 用户提出：ACP 时代开销统计一直不准，换内核后须重建配套，含按模型计费）；2026-08-16 用户裁决（人民币口径）

## 1. 问题与现状事实

ACP 时代不准确的根源与换内核后的现状（2026-08-15 盘点）：

| # | 事实 | 位置 |
| --- | --- | --- |
| F1 | **原料已准**：每回合 trace 落 `agent_model` + `usage_source=actual` + input/output/thought/cached_read/cached_write/total tokens（含缓存读分离） | `agent_traces`（实证：trace id16 输入 98k 其中缓存读 65k） |
| F2 | **费用从不落库**：`cost_amount`/`cost_currency` 系统性 null；网关不回传费用 | 同上（4 条近期 trace 全 null） |
| F3 | **计价表硬编码且不分模型**：单一费率 $5/$30/$5/$0.5 每百万 token，全模型统一价，调价=改代码 | `src/admin/platform-ui/pricing.ts` |
| F4 | **费用在客户端现算**：admin 视图 JS 内 `tokens × PRICING_RATES`，服务端聚合 API 返回的 `costAmount` 字段被无视 | `view-cost.ts` + `PRICING_JS` |
| F5 | **聚合服务已支持按模型分组**：`groupBy=model` 已实现，费用 SUM 字段已在返回结构里 | `src/services/agent-usage.ts` |
| F6 | **网关是纯解析层**：模型描述符仅 id/url/apiKey，无定价；映射层已支持网关费用直通（`record.cost.amount`，当前恒缺） | `src/mastra/model-gateway.ts`、`run-turn.ts mapMastraUsage` |
| F7 | **落库单点**：所有 trace（对话与定时任务）都经 `recordAgentTrace`，已带 cost 直通字段 | `src/runtime/trace.ts` |

结论：**差的不是数据，是计价**。原料（模型 × 精确 token）逐回合在库，费用是可以在服务端权威化、且历史可回填的。

## 2. 设计原则

1. **服务端权威**：费用由服务层计算并落库，admin 视图只读不再现算（消除 F3/F4 的口径漂移与客户端可信问题）
2. **写入时计价**：trace 落库即定格费用——"账"不随后续调价漂移；调价只影响未来的回合
3. **价格是配置数据**（D9 哲学）：费率表 = 服务层版本化静态注册表（随 Git 管理），不是运行时状态；调价是产品决策，走 commit
4. **实际值优先**：若未来网关回传真实费用（F6 直通路径），实际值优先于本地计价；`usage_source` 语义扩展区分

## 3. 计价模型（model-pricing 注册表）

新建 `src/services/model-pricing.ts`（静态注册表 + 纯函数，与 scheduled-task-types/presets 同风格）：

```ts
interface ModelPriceTier {           // 单位：价格 / 每百万 token
  input: number;
  output: number;
  thought?: number;                  // 缺省 = input
  cacheRead?: number;                // 缺省 = input / 10
  cacheWrite?: number;               // v1 不计价，留字段位（开放问题 4）
}
interface ModelPricingEntry {
  model: string;                     // 裸模型名，如 "gpt-5.6-terra"（trace 口径；网关前缀 stripping）
  currency: "USD";                   // v1 全 USD（开放问题 5）
  tier: ModelPriceTier;
}
// 注册表 + DEFAULT_TIER（未知模型 fallback，开放问题 3）
// + computeModelCost(model, usage): { amount, currency, priced: boolean }
```

- 费率数值（临时默认，2026-08-15 网络检索，降价后口径）：
  - `gpt-5.6-sol`：$5 / $30；`gpt-5.6-terra`：$2 / $12；`gpt-5.6-luna`：$0.2 / $1.2
  - 其余模型（gpt-5.5/gpt-5.4/deepseek-v4-*/doubao-*）走 DEFAULT_TIER（=terra 档）并在聚合层计 `unpricedCalls` 暴露；**owner 终定后改 `src/services/model-pricing.ts` 一处即可**
- `run-turn` 记录的 `agent_model` 为裸名（`gpt-5.6-terra`），注册表键与之对齐；`gateway/` 前缀在查询时剥离

## 4. 计价管线

插入点：`recordAgentTrace`（F7 单点）——对话与定时任务两条路径自动全覆盖：

```
usage.costAmount 存在（网关实际值）→ 直接落库，usage_source 保持 actual
usage.costAmount 缺失 → computeModelCost(agentModel, usage) 计价落库
  ├─ 模型在册 → cost_amount/cost_currency 落库， priced=true
  └─ 模型未知 → DEFAULT_TIER 计价 + priced=false（不静默：聚合层可识别 unpriced）
```

- `usage_source` 语义扩展：`actual`（token 实测）不变；费用来源以 `usageRaw` 内嵌 `costSource: "gateway" | "priced" | "priced-fallback"` 标记（不改 schema，复用现有 JSON 字段）
- estimated token 回合（无网关 usage 时的字数估算）：照常计价但 `usage_source=estimated` 已可区分，费用视为估算口径

## 5. 历史回填

一次性脚本 `scripts/mastra-cost-backfill.mjs`（对齐偏好迁移脚本惯例）：
- 范围：`cost_amount IS NULL AND (input_tokens>0 OR output_tokens>0)` 的历史 trace
- 按各行 `agent_model` 查注册表计价回写（历史回合按**当时模型**计，费率取当前表——开放问题 2 附带确认）
- `--dry-run` 支持 + 幂等（只补 null 行，重跑无副作用）+ 汇总报告（rows/cost by model）

## 6. admin 费用视图改造

- `agent-usage.ts` 聚合：已 SUM `costAmount`，补充 `unpricedCalls`（tokens>0 且 priced=false）计数
- `view-cost.ts`：**删除客户端 `PRICING_JS` 现算**，全部费用读服务端字段；费率徽标改为服务端下发（usage API 响应附当前生效费率表摘要）
- 新增"按模型"分组视图（`groupBy=model` 已支持，费用列直接可用）——多模型切换（D23 模型选择器在途）后的核心观测面

## 7. 实施分期

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| C1 | model-pricing 注册表 + computeModelCost | 单测：在册/未知/缺省档/thought 与 cacheRead 缺省规则 |
| C2 | recordAgentTrace 计价插入（两条路径自动生效） | 单测 + 隔离候选真实回合 trace `cost_amount` 非空且按模型正确 |
| C3 | 回填脚本 | 幂等重跑不变；--dry-run 报告准确 |
| C4 | 聚合 unpriced 计数 + view-cost 服务端化 + 按模型视图 | admin 视图费用与服务端 SUM 一致；客户端无费率常量 |

（C1-C4 全部在 runtime 侧，无 Portal 交互改动——符合 D23。）

## 8. 开放问题（请审）

1. **费率数值**（硬依赖）：8 个网关模型（gpt-5.6-luna/terra/sol 等）各自的 input/output/thought/cacheRead 价格——需你提供
2. **计价表形态**：代码静态注册表（推荐，随 Git 版本化）vs settings 表运行时可调
3. **未知模型策略**：DEFAULT_TIER 兜底 + unpriced 计数暴露（推荐）vs 记 0 严格化
4. **cacheWrite 是否计价**：v1 记 token 不计价（缺省 0），费率表已留字段位
5. **币种**：全 USD 假设是否成立（网关若多币种计价则聚合需分币种，复杂度上一个量级）
6. **模型清单同源**：Portal 模型选择器（D23 在途 WIP）合入时，模型清单与费率表是否统一由服务端下发（挂模型选择器立项一并定，不阻塞本设计）
