# 复合指标系统当前契约

本文件描述已实现的 L1、L3a、L3b 指标能力与安全边界。历史路线图、客户公式样例、未落地的创建 Skill 和执行提示见
[`archive/composite-indicator-system-pre-consolidation-2026-07-28.md`](./archive/composite-indicator-system-pre-consolidation-2026-07-28.md)。

## 分层与所有权

| 层级 | 当前职责 | 权威实现 |
| --- | --- | --- |
| L1 | 标准、可复用的确定性指标算子 | `src/services/indicators.ts` |
| L3a | YAML 声明式复合指标 | `src/services/composite-indicator-engine.ts`、`src/services/l3a-indicator-runner.ts` |
| L3b | 受限 JavaScript/TypeScript 指标脚本 | `src/services/script-indicator-engine.ts`、`src/services/l3b-indicator-runner.ts` |
| 告知门槛 | 对实验性或带数据源说明的指标要求用户确认 | `src/services/indicator-acknowledgement.ts` |

L2 信号可以作为领域概念存在，但当前文档不把未统一落地的信号目录声明为独立运行时契约。

## L1 算子

L1 算子接收规范化行情序列并返回确定性结果。新增或修改算子时必须：

- 明确输入窗口、空值和样本不足语义；
- 输出结构稳定，避免调用方解析展示文本；
- 不在算子内部静默补造行情；
- 为边界输入提供测试。

算子和参数的实际支持集合以 `src/services/indicators.ts` 为准，不在文档中维护第二份清单。

## L3a 声明式复合指标

Workspace 配置位于：

```text
workspace/config/composite_indicators.yaml
```

解析器校验定义后，由求值器组合底层条件。当前支持的组合模式包括：

- `and`
- `or`
- `majority`
- `weighted_sum`

配置必须有稳定 key、可验证参数和明确输出。未知算子、非法权重、缺少依赖或无法满足的数据窗口应返回可诊断错误，不得降级成猜测结果。

L3a 适合能够用有限规则树表达、需要审计每个子条件的复合逻辑。它不是任意公式语言。

## L3b 沙箱脚本指标

L3b 使用 `isolated-vm` 隔离执行，并由 esbuild 编译缓存。当前默认资源限制为：

- 内存：64 MB
- 单次执行：5 秒

脚本只能使用运行器显式注入的数据和能力，不能访问 Node.js 内建模块、文件系统、网络、环境变量或宿主进程对象。输出必须可序列化并通过运行器的结构校验。

脚本与注册信息位于 Workspace 的指标脚本区域；具体目录和 registry schema 以 `src/services/script-indicator-engine.ts` 为准。缓存属于可再生运行产物，不能作为权威配置。

## 用户告知与确认

当指标被标记为实验性，或定义包含必须披露的数据源说明时，运行前必须通过 acknowledgement gate。确认应绑定用户、实例与指标版本/内容，配置改变后不能沿用旧确认。

必须向用户清楚区分：

- 使用了哪些数据；
- 哪些部分是确定性计算；
- 数据缺口或近似处理；
- 指标输出不是收益承诺或自动交易指令。

## 运行红线

- 不将用户脚本放到主 Node.js 上下文直接执行。
- 不允许脚本自行联网或读取 Workspace 之外的文件。
- 不用缓存结果替代当前配置和输入事实。
- 不在数据不足时伪造精确指标值。
- 未实现的创建工作流、公式翻译能力或未来算子不得写成现有产品能力。

## 验证

相关变更应按范围运行现有 smoke：

```bash
npm run smoke:indicators
npm run smoke:composite-indicator
npm run smoke:script-indicator
npm run smoke:indicator-acknowledgement
npm run verify
```

脚本名称以 `package.json` 为准；缓存清理使用其中现行的 indicator cache 命令。
