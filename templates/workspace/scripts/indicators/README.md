# L3b 沙箱脚本指标

本目录存放**用户私有的复杂复合指标**(L3b 层),每个指标是一个 `.ts` 文件,在 isolated-vm 沙箱内执行。

## 何时用 L3b

| 场景 | 用 L3b 吗 |
|---|---|
| 标准指标 + 参数(MA7、KDJ(14,3,3)) | ❌ 走 L1 算子 + alert_rule 参数 |
| 标准信号的布尔组合("MACD 金叉 AND 量比>2") | ❌ 走 L3a 规则树(yaml) |
| 多源融合 + 循环/状态(主力控盘、筹码模型) | ✅ 用 L3b |

## 编写指南

1. 复制 `double_ma_cross.ts` 作为起点
2. 只允许 `import ... from 'invest-agent-runtime'`(helpers 白名单)
3. 必须 export `definition` 和 `compute(ctx)`
4. `compute` 必须返回 `{ values: {...} }`,字段对应 `definition.outputSchema`

## 沙箱限制

- 内存:64 MB
- 超时:5 秒/股
- 禁止:`fs` / `process` / `require` / `eval` / 网络
- 允许:`invest-agent-runtime` 暴露的所有 L1 算子

## 注册

每新增指标,必须在 `.registry.yaml` 加一条 entry,否则系统不会加载。

完整规范见 `docs/composite-indicator-system.md` 第 8 节。
