# 复合指标系统设计

> Created: 2026-06-22
> 状态:核心 L1/L3a/L3b 与告知协议已落地；调度器联动、衍生信号和 UI 仍按路线图延期
> 关联文档:`table-ownership.md` / `ideal-refactor-plan.md` / `23-multi-user-sandbox-design.md`
> 第一个用例:客户主力控盘指标(基于通达信筹码模型)

## 1. 背景与动机

当前 `indicator_definitions` 表只承载了 16 个内置标准指标,且 `formulaType` 字段虽预留了 `expression` / `script`,但**没有实现求值器**。第一个真实客户直接提出需要"主力控盘度"这类**用户私有的复杂复合指标**,无法用标准指标参数化覆盖。

本设计目标:**在不污染 SQLite 平台表、不引入自由代码 eval 的前提下,让每个用户能定义自己的复合指标,且数据落到自己的工作空间**。

## 2. 设计目标

1. **可扩展**:用户能定义新指标,无需改代码、无需改 Skill
2. **安全**:用户写的内容不能影响主进程或他人
3. **可审计**:指标定义和执行结果都能追溯
4. **知情同意**:用估算数据时强制告知,用户必须显式确认
5. **算力可控**:复杂指标不拖垮巡检频率
6. **Skill 稳定**:流程定义在 Skill 里,**Skill 不为单个用户改动**

## 3. 概念分层(五层)

```
L0 原子算子    纯数学(EMA/SMA/MAX/MIN/STD/CROSS),散落在 indicators.ts,不单独建表
    │
    ▼ 组合
L1 技术指标    标准金融指标(MACD/KDJ/BOLL/WINNER...)
              代码内置,平台级元数据进 SQLite indicator_definitions
              outputSchema 必须落地(当前最大缺口)
    │
    ▼ 字段比较
L2 信号       布尔判定(MACD金叉/KDJ超买/突破BOLL上轨)
              可平台内置,可用户参数化
              作为 alert_rule 的 indicator_key
    │
    ▼ 组合
L3a 规则树    yaml 写组合("MACD金叉 AND 量比>2")
复合指标      workspace/config/composite_indicators.yaml
              求值器自研,纯 TS,无 eval
              覆盖 80% 复合场景
    │
    ▼ 不够用时降级
L3b 沙箱脚本  TypeScript 文件实现复杂算法(主力控盘)
复合指标      workspace/scripts/indicators/<key>.ts
              isolated-vm 沙箱执行,纯数学,无 Node API
              覆盖 20% 复杂场景
```

## 4. 落盘归属(对接 table-ownership.md)

| 层 | 数据 | 落哪 | 理由 |
|---|---|---|---|
| L1 算子定义 | name/formula/paramsSchema/outputSchema/dataRequirements/reliability | **SQLite `indicator_definitions`** | 平台元数据,跨用户共享 |
| L1 算子实现 | TS 函数 | **代码 `src/services/indicators.ts`** | 代码内置 |
| L2 信号定义 | 平台内置信号 | SQLite + 代码 | 标准信号跨用户共享 |
| L2 用户参数 | 阈值/周期 | SQLite `alert_rules.params` | 调度器高频读,WP4.10 决策 |
| L3a 规则树 | yaml 配置 | **workspace `config/composite_indicators.yaml`** | 用户私有判断 |
| L3b 脚本 | TS 文件 | **workspace `scripts/indicators/<key>.ts`** | 用户私有代码 |
| L3b 注册表 | 脚本路径 + 元信息 | **workspace `scripts/indicators/.registry.yaml`** | 用户私有 |
| 算子/指标计算结果 | 数值产物 | **workspace `reports/metrics/indicators/*.json`** | 已在 table-ownership.md 划定 |
| 缓存(筹码分布等) | 增量状态 | **workspace `cache/<key>/<stockCode>.json`** | 用户私有运行时状态 |

**SQLite 边界守住**:用户私有的复合指标定义、脚本、缓存、计算结果**全部不进 SQLite**。

## 5. L1 算子规范

### 5.1 当前已有(待参数化)

`src/services/indicators.ts` 内:
- `ma(closes, period)` ✅ 已参数化
- `macd(closes, short, long, signal)` ✅ 已参数化
- `volumeAnalysis(volumes, currentVol)` ✅

**问题**:`analyzeIndicators` 调用处写死了 MA5/10/20/60,**参数化未在调用层落地**。

### 5.2 第一批必须补齐的标准算子

| 算子 key | 名称 | 参数 | 输出字段 | 公式来源 |
|---|---|---|---|---|
| `MA` | 简单均线 | `period` | `value` | 标准 |
| `EMA` | 指数均线 | `period` | `value` | 标准 |
| `MACD` | 异同移动平均 | `short, long, signal` | `dif, dea, bar` | 标准 |
| `KDJ` | 随机指标 | `n, m1, m2` | `k, d, j` | 标准 |
| `BOLL` | 布林带 | `period, multiplier` | `up, mid, down` | 标准 |
| `RSI` | 相对强弱 | `period` | `value` | 标准 |
| `WR` | 威廉指标 | `period` | `value` | 标准 |
| `OBV` | 能量潮 | 无 | `value` | 标准 |
| `volumeRatio` | 量比 | `period` | `value` | 标准(已有) |
| `turnover` | 换手率 | 无 | `value` | 标准(已有) |

### 5.3 筹码类算子(主力控盘依赖)

| 算子 key | 名称 | 参数 | 输出 | 数据依赖 | 可靠性 |
|---|---|---|---|---|---|
| `chipDistribution` | 筹码分布 | `granularity` | `Map<price, weight>` | 日 K + 换手率 | experimental |
| `winner` | 获利盘比例 | `price` | `number (0-1)` | 日 K + 换手率 | experimental |
| `cycCostBasis` | CYC 成本均线 | `period` | `value` | 日 K + 成交额 | experimental |
| `ckdConcentration` | CKD 筹码集中度 | `period` | `value` | 日 K + 换手率 | experimental |

**筹码类算子全部标 `reliability: experimental`**,因为是估算模型,不是真实筹码数据。

### 5.4 outputSchema 强制要求

每条 L1 算子定义必须填 `outputSchema`:

```typescript
// SQLite indicator_definitions.outputSchema
{
  dif: "number",
  dea: "number",
  bar: "number"
}
```

**没 outputSchema,L2 信号无法引用 L1 输出字段**——这是当前架构最大隐藏缺口,补齐时必须落地。

## 6. L2 信号规范

### 6.1 信号结构

```typescript
interface SignalDefinition {
  key: string;                    // 如 "macd_golden_cross"
  name: string;                   // "MACD 金叉"
  indicatorKey: string;           // 引用的 L1 算子
  condition: {
    type: "cross" | "compare" | "threshold";
    operator: "up_cross" | "down_cross" | "gt" | "lt" | "between";
    field?: string;               // L1 输出字段,如 "dif"
    targetField?: string;         // 如 "dea"
    value?: number;
  };
  reliability: "stable" | "experimental" | "manual_review";
}
```

### 6.2 标准信号清单(首批)

| 信号 key | 引用算子 | 条件 |
|---|---|---|
| `macd_golden_cross` | MACD | `cross(up, dif, dea)` |
| `macd_death_cross` | MACD | `cross(down, dif, dea)` |
| `kdj_oversold` | KDJ | `lt(k, 20)` |
| `kdj_overbought` | KDJ | `gt(k, 80)` |
| `boll_touch_lower` | BOLL | `lt(close, down)` |
| `boll_break_upper` | BOLL | `gt(close, up)` |
| `rsi_oversold` | RSI | `lt(value, 30)` |
| `price_above_ma20` | MA | `gt(close, value) where period=20` |

### 6.3 当前 14 个 system signal 的迁移

`src/handlers/signal-config.ts` 当前的 14 个扁平信号(如 `price_change`、`breakout_with_volume`、`capital_flow_main`)按本规范重映射,部分转为 L2 信号,部分保留为复合条件。

迁移时机:工作包 5(自演进闭环)之后,不在本 RFC 强制范围。

## 7. L3a 规则树复合指标规范

### 7.1 文件位置

```
workspace/config/composite_indicators.yaml
```

### 7.2 YAML Schema

```yaml
- key: my_macd_volume_combo
  name: "MACD金叉且放量"
  description: "MACD 金叉同时量比大于 2"
  reliability: stable
  type: rule_tree
  inputs:
    - key: macd_signal
      source: signal.macd_golden_cross
      transform: boolean
    - key: volume_ratio
      source: indicator.volumeRatio
      field: value
      params: { period: 5 }
      transform: raw
  combine: and              # and | or | weighted_sum | majority
  thresholds:
    trigger: { expr: "macd_signal && volume_ratio > 2" }
  outputs:
    triggered: boolean
    score: number           # 可选,用于排序
  schedule: intraday        # intraday | daily_post_market | on_signal
  user_acknowledged: true
  acknowledged_at: "2026-06-22"
```

### 7.3 求值器约束

- 不支持 `eval` / `Function` 构造
- 表达式仅限:`&& || > < >= <= == != +-*/% ()` 和字段引用、数字字面量
- 字段必须先在 `inputs` 声明,白名单制
- 不允许函数调用语法
- 超时 100ms,超出熔断

### 7.4 数据契约(外层调度器 ↔ 引擎)

引擎不直接抓行情,不直接调 L1 算子,不直接读 L2 信号。**外层调度器(scheduler/alert-check 或调用方)负责把所有 inputs 预算好后注入字典**,引擎只做"配置 + 字典 → 触发结果"。

| 字段 | 来源 | 计算方 |
|---|---|---|
| `inputs[].source = "indicator.*"` | L1 算子返回值 | 调度器调 `src/services/indicators.ts` |
| `inputs[].source = "signal.*"` | L2 信号触发结果 | 调度器调 `src/scheduler/alert-check.ts` |
| `inputs[].source = "raw.*"` | 任意预计算数值 | 调度器自行准备 |

这样设计的好处:
- 引擎纯函数,易于测试和缓存
- 调度器复用现有行情抓取、算子计算、信号匹配代码,无重复
- inputs 在调度器层做股票循环和并发,引擎内不再发起 I/O

引擎对外接口:

```typescript
interface CompositeIndicatorContext {
  // 按 inputs[].source 对应字段名预填的字典
  // 比如 inputs.source = "indicator.macd_golden_cross"
  //   → inputs["indicator.macd_golden_cross"] = true
  inputs: Record<string, number | boolean>;
}

interface CompositeIndicatorResult {
  triggered: boolean;
  score?: number;
  notes: string[];
}
```

### 7.5 适用场景

- 标准指标 + 标准信号的组合(80% 用户需求)
- 不涉及循环/递归/复杂状态

## 8. L3b 沙箱脚本指标规范

### 8.1 文件位置

```
workspace/scripts/indicators/<key>.ts      # 脚本
workspace/scripts/indicators/.registry.yaml # 注册表
```

### 8.2 脚本接口

```typescript
// workspace/scripts/indicators/main_force_control.ts
import type { StockKline, IndicatorContext, IndicatorResult } from 'invest-agent-runtime';

export const definition = {
  key: 'main_force_control',
  name: '主力控盘度',
  reliability: 'experimental',
  dataRequirements: ['daily_kline', 'turnover'],
  outputSchema: {
    zzlkp: 'number',      // 主力控盘度 0-100
    zjlrqd: 'number',     // 资金流入强度
    zcmzl: 'number',      // 市场筹码总量
    zshtl: 'number',      // 散户套牢比率 0-100
  },
};

export async function compute(
  ctx: IndicatorContext
): Promise<IndicatorResult> {
  const { klines, turnovers, helpers } = ctx;
  
  // helpers 暴露 L1 算子(白名单)
  const winner = helpers.winner;
  const ema = helpers.ema;
  
  // 实现公式...
  const zlcm = ema(klines.map(k => winner(k.close) * 70), 3);
  // ...
  
  return {
    values: { zzlkp, zjlrqd, zcmzl, zshtl },
    notes: ['筹码分布基于换手率衰减模型估算'],
    reliability: 'experimental',
  };
}
```

### 8.3 沙箱限制(isolated-vm)

| 限制项 | 值 |
|---|---|
| 内存 | 64MB / 股 |
| CPU 时间 | 5s / 股(硬超时熔断) |
| 总执行时间 | 60s / 调度周期 |
| 可用 API | 仅 `helpers`(白名单 L1 算子)+ 纯 JS 数学 |
| 禁用 | `require` / `process` / `fs` / `eval` / `Function` / `setTimeout` / 网络 |

### 8.4 注册表

```yaml
# workspace/scripts/indicators/.registry.yaml
- key: main_force_control
  name: "主力控盘度"
  script: ./main_force_control.ts
  enabled: true
  reliability: experimental
  schedule: daily_post_market
  data_source_notes:
    - "筹码分布基于换手率衰减模型估算"
    - "70/80 系数为原作者经验值"
  user_acknowledged: true
  acknowledged_at: "2026-06-22"
  acknowledged_via: "weixin-mobile"
```

### 8.5 编译与缓存

- 脚本用 esbuild 编译为 CommonJS 后注入 isolated-vm
- 编译产物落 `workspace/cache/build/<key>.js`(避免每次重编译)
- 脚本 hash 变化时重编译

## 9. Skill 流程文档(Codex 辅助创建)

### 9.1 Skill 位置

```
.codex/skills/invest-agent-indicator-creation/SKILL.md
```

### 9.2 Skill 内容大纲

```markdown
# 用户指标创建流程

## 何时触发
用户在微信里说"我要一个 XX 指标"、"加一个 XX 信号"等。

## 流程

1. **澄清需求**
   - 公式或判断逻辑
   - 数据依赖(行情?资金流?筹码?)
   - 参数(周期、阈值)
   - 触发频率

2. **判断复杂度**
   - 能用标准指标 + 参数 → 走 L2(写 alert_rule)
   - 标准信号组合 → 走 L3a(写 yaml)
   - 必须写代码(循环/递归/多源融合) → 走 L3b(写 ts 脚本)

3. **数据源核对**
   - 列出公式所有数据依赖
   - 对照 docs/composite-indicator-system.md 第 5 节
   - 缺失的数据必须告知用户:
     - 用近似算子?→ 显式标注 experimental
     - 用户手动补?→ 在 yaml 里留 placeholder
   - **用户必须显式确认后才能写入 user_acknowledged: true**

4. **生成指标文件**
   - L3a:写 workspace/config/composite_indicators.yaml
   - L3b:写 workspace/scripts/indicators/<key>.ts 和 .registry.yaml

5. **试算验证**
   - 用最近 5 个交易日数据跑一次
   - 把结果贴给用户确认

6. **告知频率限制**
   - 复合指标默认 daily_post_market
   - 不在盘中实时更新

## 绝对禁止
- 修改 .codex/skills/ 下的任何文件
- 跳过 user_acknowledged 流程
- 使用 eval / Function / require
```

### 9.3 Skill 不变性原则

**这个 Skill 写好后永不为单个用户改动**。所有用户特定的内容都落在 workspace。如果流程本身要改(比如新增 L4),那是平台级变更,走 RFC。

## 10. 告知协议(强制)

### 10.1 user_acknowledged 字段

所有 L3 复合指标(literal 3a/3b)必须有:

```yaml
user_acknowledged: true
acknowledged_at: "2026-06-22T10:00:00Z"
acknowledged_via: "weixin-mobile"     # weixin-mobile | dashboard | api
```

### 10.2 触发条件

下列任一情况必须强制确认:
- 用了 `reliability: experimental` 的 L1 算子
- 用了数据源缺失项(筹码/Level-2/龙虎榜/大宗交易)
- 公式含经验系数(无标准数学证明)
- 输出作为建仓/止损决策依据

### 10.3 确认流程

1. Codex 把 `data_source_notes` 全文贴到微信
2. 用户回复"确认" / "我了解" 等肯定词
3. Codex 写入 `user_acknowledged: true`
4. 系统加载指标时校验,缺失则拒绝执行

## 11. 频率与算力策略

### 11.1 频率分层

| 层 | 频率 | 触发方式 | 备注 |
|---|---|---|---|
| L1/L2 标准指标 | 跟随巡检(默认 5 分钟) | 主动轮询 | 数据源:腾讯行情 |
| L3a 规则树 | 盘中触发式 | L2 信号触发时算 | 不主动轮询 |
| L3a 规则树(日级) | 每日盘后 1 次 | 调度器定时 | 收盘后 30 分钟 |
| L3b 沙箱脚本 | 每日盘后 1-2 次 | 调度器定时 | 默认 1 次,可选盘中 |

### 11.2 算力预算

- 单股单指标最长 5 秒
- 单调度周期总时长不超过 60 秒
- 50 股 × 5 个复合指标 = 250 次计算,排到盘后队列
- 超时指标记 `reliability: timeout`,不阻塞调度

### 11.3 触发式计算(L3a 优化)

L3a 不主动轮询,**L2 信号触发时附带算 L3a**。例:
- "MACD 金叉"信号触发 → 顺带跑引用该信号的 L3a 复合指标
- 这样复合指标的算力开销几乎为 0

## 12. 缓存与落盘

### 12.1 缓存目录结构

```
workspace/cache/
├── build/                           # L3b 脚本编译产物
│   └── <key>.<hash>.js
├── chip_distribution/               # 筹码分布缓存(L1 算子级)
│   └── <stockCode>.json
├── indicator_state/                 # 指标增量状态(L3b)
│   └── <indicatorKey>/
│       └── <stockCode>.json
└── last_compute/                    # 最近一次计算结果
    └── <indicatorKey>/
        └── <stockCode>.json
```

### 12.2 缓存更新策略

| 缓存 | 更新时机 | 策略 |
|---|---|---|
| `chip_distribution` | 每日盘后 | 增量(只注入当日 K) |
| `indicator_state` | 每次计算后 | 整体覆盖 |
| `last_compute` | 每次计算后 | 整体覆盖 |

### 12.3 缓存清理

- 超过 30 天未访问的缓存自动清理
- 用户可在 Dashboard 手动清缓存(触发全量重算)

## 13. 第一个用例:主力控盘指标

### 13.1 客户公式(通达信)

```
ZLCM  := EMA(WINNER(CLOSE)*70, 3);
SHCM  := EMA((WINNER(CLOSE*1.1)-WINNER(CLOSE*0.9))*80, 3);
ZSHTL := SHCM/(ZLCM+SHCM)*100;
ZZLKP := ZLCM/(ZLCM+SHCM)*100;
ZCMZL := MA(ZLCM+SHCM, 13);
ZSHJJ := EMA(ZSHTL, 89);
ZZLJJ := EMA(ZZLKP, 89);
ZJLRQD:= INTPART(ZZLKP - ZZLJJ);
DKB   := IF(ZZLKP-REF(ZZLKP,1) > ZSHTL-REF(ZSHTL,1), 1, 0);
```

核心输出:`ZZLKP`(主力控盘度,0-100)。

### 13.2 数据依赖核对

| 需要 | 状态 | 备注 |
|---|---|---|
| 日 K 线(开高低收) | ✅ | 腾讯行情 250 日 |
| 成交量 | ✅ | 腾讯行情 |
| 换手率 | ✅ | quote.turnover |
| 筹码分布 | ❌ → 自研 L1 算子 | 用 chipDistribution 实现 |
| WINNER 函数 | ❌ → 自研 L1 算子 | 基于 chipDistribution |

**结论:全部数据可得,可完整实现**。

### 13.3 实现落点

| 部分 | 位置 |
|---|---|
| `chipDistribution` / `winner` L1 算子 | `src/services/indicators.ts` + `indicator_definitions` 表 |
| 主力控盘公式 L3b 脚本 | `workspace/scripts/indicators/main_force_control.ts` |
| 注册 | `workspace/scripts/indicators/.registry.yaml` |
| 缓存 | `workspace/cache/chip_distribution/<stockCode>.json` |
| 计算结果 | `workspace/reports/metrics/indicators/main_force_control/*.json` |
| 衍生信号 | L2 信号:`main_force_high` (ZZLKP>75)、`main_force_rising` (ZJLRQD>10) |

### 13.4 必须告知客户的项

```
1. 筹码分布基于换手率衰减模型估算,非真实筹码数据
2. 70/80 系数为原作者经验值,适用性因股而异
3. 换手率取自行情源,异常股票(新股、ST)可能不准
4. 输出每日盘后更新 1 次,盘中不实时
5. 仅作迹象评分,不作为建仓结论
```

客户确认后写入 `user_acknowledged: true`。

## 14. 落地路线图

### 阶段 1:L1 算子补齐(基础,1-2 周)

- [x] 参数化现有 `analyzeIndicators` 调用(保持原签名零破坏,新算子独立导出)
- [x] 补齐 KDJ / BOLL / RSI / WR / OBV
- [x] 实现 `chipDistribution` + `winner`(筹码模型核心)
- [x] SQLite `indicator_definitions.outputSchema` 字段全部填齐(`src/handlers/indicator-definitions.ts`)
- [x] 单元测试覆盖每个算子(`scripts/indicators-smoke.mjs`)

### 阶段 2:L3b 沙箱引擎(关键,1 周)

- [x] 集成 `isolated-vm` 依赖
- [x] 实现 `src/services/script-indicator-engine.ts`
- [x] 暴露 `helpers`(白名单 L1 算子)给沙箱(`src/services/sandbox-runtime.ts`)
- [x] 实现 CPU/内存/超时熔断
- [x] 编译缓存(esbuild → workspace/cache/build/)

### 阶段 3:L3a 规则树引擎(1 周)

- [x] 实现 `src/services/composite-indicator-engine.ts`
- [x] 支持表达式:`&& || > < >= <= == != +-*/% ()`(扩展了 RFC 原列表)
- [x] 白名单字段校验
- [ ] 与 L2 信号的触发式联动(待调度器接入时实现,引擎接口已就绪)

### 阶段 4:Skill 与告知协议(2-3 天)

- [x] 写 `.codex/skills/invest-agent-indicator-creation/SKILL.md`
- [x] 实现 `user_acknowledged` 校验逻辑(`src/services/indicator-acknowledgement.ts`)
- [x] Codex 测试场景覆盖(`scripts/indicator-acknowledgement-smoke.mjs`)

### 阶段 5:主力控盘用例落地(2-3 天)

- [x] 实现主力控盘 L3b 脚本(客户公式,`templates/workspace/scripts/indicators/main_force_control.ts`)
- [ ] 衍生 L2 信号(main_force_high / main_force_rising,待调度器接入)
- [ ] Dashboard 展示 ZZLKP 趋势(待 UI 接入)
- [ ] 客户验收(待客户实际部署后)

### 阶段 6:文档与运维(1 天)

- [x] 更新 `docs/README.md`
- [x] 更新 `AGENTS.md`
- [x] 更新当前架构与领域契约文档（关键文件表 + 复合指标系统章节）
- [x] 缓存清理任务(`scripts/clear-indicator-cache.mjs` + `npm run cache:clear-indicator`)

**总工期:3-4 周**

## 15. 风险与开放问题

### 15.1 已识别风险

| 风险 | 缓解措施 |
|---|---|
| isolated-vm 编译失败(平台差异) | 提前在 macOS/Linux 双环境验证 |
| 筹码模型计算量超预期 | 增量更新 + 落盘缓存 + 粒度调粗 |
| 客户公式适用性差 | 强制 `user_acknowledged` + `reliability: experimental` |
| L3a 表达式求值器边界 bug | 严格白名单 + 单元测试 |
| 脚本写入被滥用 | sandbox_audit_logs 记录所有写入 |

### 15.2 已决策问题(2026-06-22)

1. **历史数据长度** → **改 250 日**(`src/services/stock.ts:getKline` 默认值)。理由:EMA(89) 需要足够预热,120 日临界,250 日更稳。数据按需拉取不存盘,改动量仅一行默认值。
2. **L3a 表达式语言是否支持 `if/else`** → **不支持**。需要分支逻辑时降级到 L3b 沙箱脚本。守住"L3a 简单 / L3b 灵活"边界,降低审计压力。
3. **L3b 是否支持多文件脚本(import 其他用户脚本)** → **未来支持,现在不做**。等 L3b 脚本积累到 5-10 个、出现真实复用需求时再立项。
4. **客户公式是否需要"灰度对比"** → **不做**。靠客户日常使用反馈 + Dashboard 展示原始数值,客户自行判断。工程化灰度对比 = 双倍算力 + UI 复杂度,第一个客户不值得。

## 16. 与现有文档的关系

- **`table-ownership.md`**:本设计严格遵守表归属边界,L3 全部数据进 workspace
- **`ideal-refactor-plan.md`**:本设计可作为工作包 5(自演进闭环)的前置依赖
- **`23-multi-user-sandbox-design.md`**:L3b 沙箱脚本写入 workspace 时走沙箱审计
- **`AGENTS.md`**:落地后更新"指标系统"章节,指向本文档

## 17. 一句话总结

**L1 装算子(平台)、L2 装信号(标准判定)、L3a 装规则树(用户组合)、L3b 装沙箱脚本(用户复杂算法)。SQLite 永远只放跨用户共享的算子定义,用户私有判断无论多复杂都进 workspace。Codex 按 Skill 流程把用户需求落到 workspace 数据,Skill 本身永不为单个用户改动。**
