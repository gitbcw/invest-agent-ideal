---
name: invest-agent-indicator-creation
description: Help the user create custom composite indicators. Use when the user asks to add a custom indicator ("加一个 XX 指标", "我想要 XX 信号", "做个主力控盘", "MACD 和量比组合", "KDJ 参数改成 14"). Walks through clarification, complexity tiering (L2 / L3a / L3b), data-source audit, mandatory acknowledgement protocol, dry-run validation, and registry updates. Always writes to the user workspace; never modifies skill files or core service code.
---

# 用户自定义指标创建流程

## Purpose

用户想要标准系统没提供的指标时,这个 skill 把需求翻译成正确的层(L1 / L2 / L3a / L3b)、正确的格式(YAML / TS 脚本)、正确的目录,并且强制执行告知协议。

**这个 skill 是平台级的,永不为单个用户改动**。用户特定的内容全部落在 `workspace/` 下。

## 何时触发

- "我要一个 XX 指标"
- "加一个 XX 信号"
- "MACD 参数改成 14"
- "做个主力控盘指标"
- "5 日均量大于 10 日均量"

## 4 层决策树

| 用户描述 | 归层 | 落地文件 |
|---|---|---|
| 标准指标 + 参数(MA(14)、KDJ(9,3,3)) | L2 | 走 alert_rule 工具,不写文件 |
| 标准信号的布尔/加权组合("MACD 金叉 AND 量比 > 2") | L3a | `workspace/config/composite_indicators.yaml` |
| 循环/递归/多源融合(筹码模型、主力控盘) | L3b | `workspace/scripts/indicators/<key>.ts` + `.registry.yaml` |

**判断不了时默认走 L3a**(YAML 比脚本便宜,可降级)。L3a 不能满足才升级 L3b。

## 流程

### 1. 澄清需求

最少问清楚:
- **触发逻辑**:什么条件算触发?用户期望看到什么结果?
- **数据依赖**:K 线?成交量?换手率?资金流?筹码?
- **参数**:周期、阈值、权重
- **频率**:盘中实时?盘后 1 次?
- **用途**:仅展示?作为建仓/止损依据?(后者强制告知协议)

不要一次问 5 个问题,合并成 1-2 个自然语言问题。

### 2. 数据源核对

对照 `docs/composite-indicator-system.md` 第 5 节,列出所有数据依赖:

| 数据 | 是否可用 |
|---|---|
| 日 K 线(开高低收量) | ✅ 腾讯行情 |
| 实时报价 | ✅ 腾讯行情 |
| 资金流(主力/超大单) | ✅ 东方财富 |
| 换手率 | ⚠️ 历史 K 线没存,需要估算 |
| 筹码分布 | ❌ 无直接源,需衰减模型近似 |
| Level-2 / 龙虎榜 / 大宗 | ❌ 缺失 |

缺失或近似的数据源必须走告知协议(下一步)。

### 3. 告知协议(强制)

只要满足下列任一,**必须**走告知协议:

- 用了 `reliability: experimental` 的 L1 算子(目前只有 `chipDistribution` / `winner`)
- 公式含**经验系数**(无数学证明,例如 `0.3 * volume`)
- 数据源缺失或用近似模型(筹码、换手率估算)
- 输出作为**建仓/止损决策依据**

**强制流程**:
1. 把 `data_source_notes` 全文贴到微信,用大白话解释"这个数据是怎么来的、为什么是近似的"
2. 等用户明确回复"确认"、"我了解"、"同意"等肯定词
3. 用户确认后,在配置里写入:
   ```yaml
   user_acknowledged: true
   acknowledged_at: "2026-06-22"            # 当天 ISO 日期
   acknowledged_via: "weixin-mobile"        # weixin-mobile | dashboard | api
   ```
4. **系统加载时会校验**,缺失则指标不被加载

**绝对禁止跳过**:即使用户说"快点帮我加",也必须先贴 notes。

### 4. 生成指标文件

#### L3a(YAML)

写入 `workspace/config/composite_indicators.yaml`(append 不覆盖):

```yaml
- key: my_macd_volume_combo
  name: "MACD金叉且放量"
  description: "MACD 金叉同时量比大于 2"
  reliability: stable                    # experimental 才需要告知
  type: rule_tree
  inputs:
    - key: macd_signal
      source: signal.macd_golden_cross   # 引用现有 L2 信号
      transform: boolean
    - key: volume_ratio
      source: indicator.volume_ratio
      transform: number
  combine: and                           # and | or | majority | weighted_sum
  thresholds:
    trigger: { expr: "macd_signal && volume_ratio > 2" }
  outputs:
    triggered: boolean
    score: number
  schedule: intraday                     # intraday | daily_post_market | on_signal
  user_acknowledged: true
  acknowledged_at: "2026-06-22"
  acknowledged_via: "weixin-mobile"
```

表达式允许的运算符:`&& || == != < <= > >= + - * / % ()`。**禁止** eval/Function/函数调用语法/字符串字面量。

#### L3b(TypeScript)

写入 `workspace/scripts/indicators/<key>.ts`:

```typescript
import { computeMA, type IndicatorContext, type IndicatorResult } from "invest-agent-runtime";

export const definition = {
  key: "my_indicator",
  name: "...",
  reliability: "stable",                 // experimental 才需要告知
  dataRequirements: ["daily_kline.close"],
  outputSchema: { /* field: type */ },
};

export function compute(ctx: IndicatorContext): IndicatorResult {
  const { klines } = ctx;
  // ... 实现 ...
  return { values: { /* ... */ }, notes: [] };
}
```

约束:
- 只允许 `import ... from "invest-agent-runtime"`(白名单 helpers)
- 必须导出 `definition` 和 `compute(ctx)`
- 必须返回 `{ values: {...}, notes: [...] }`
- 内存 64MB / 超时 5s,沙箱内硬熔断

然后在 `workspace/scripts/indicators/.registry.yaml` 加一条:

```yaml
indicators:
  - key: my_indicator
    name: "..."
    script: ./my_indicator.ts
    enabled: true
    reliability: stable
    schedule: daily_post_market
    data_source_notes:
      - "[缺失数据源] ..."      # 有则填,无则留空
      - "[近似模型] ..."
    user_acknowledged: true
    acknowledged_at: "2026-06-22"
    acknowledged_via: "weixin-mobile"
    description: "..."
```

### 5. 试算验证

创建后立即用最近 5 个交易日数据跑一次:
- L3a:让用户提供各 input 的实际数值,看触发结果是否合理
- L3b:让用户提供一组 K 线数据,跑 `ScriptIndicatorEngine.run()` 看输出

**把结果贴给用户确认**。用户说"对了"才结束;否则迭代。

### 6. 告知频率限制

明确告诉用户:
- L3a 默认盘中触发式(跟随 L2 信号)
- L3b 默认每日盘后 1 次(约 15:30)
- 不在盘中实时刷新
- 单股单指标最长 5 秒

## 绝对禁止

- 修改 `.codex/skills/` 下的任何文件(包括本文件)
- 跳过告知协议流程
- 在 L3b 脚本里使用 `eval` / `Function` / `require` / `process` / `fs`
- 在 L3b 脚本里 `import` 除 `invest-agent-runtime` 之外的任何模块
- 在 L3a YAML 里写函数调用语法 `ident(...)`
- 把 `user_acknowledged: true` 设为默认值(必须用户显式确认后才填)
- 用客户名字命名 key(用业务语义:`main_force_control` 而非 `zhangsan_indicator`)

## 参考文档

- `docs/composite-indicator-system.md` — 完整 RFC
- `templates/workspace/config/composite_indicators.yaml` — L3a 模板示例
- `templates/workspace/scripts/indicators/double_ma_cross.ts` — L3b 模板示例(简单)
- `templates/workspace/scripts/indicators/main_force_control.ts` — L3b 复杂示例(主力控盘,含滚动筹码分布)
- `templates/workspace/scripts/indicators/README.md` — 用户编写指南
