# Invest Agent 能力平面渐进式抽离计划

> 状态：待执行
> 范围：`market-data-tool`、`research-tool`、`indicator-tool`
> 核心目标：让领域能力可以脱离完整 Invest Agent 运行时独立开发、调试和测试，同时保持现有 ACP、MCP、安全、状态与生产调用契约不变。

## 一、背景与问题

Invest Agent 已形成 Workspace ACP 与服务层分工：Workspace ACP 负责对话、推理和投资判断；服务层负责确定性能力、持久状态、安全约束、调度与交付。

当前剩余问题是服务层内部仍混合了多种职责。以数据与计算能力为例，行情、外部研究和指标计算都位于完整服务代码中，并直接被 MCP、HTTP、scheduler、review 等调用。修改单个 provider 或指标实现后，开发者往往需要在整套运行时下验证，导致反馈慢、故障定位困难、测试成本高。

当前代表性模块约 3,700 行：

- `src/services/market-data.ts`
- `src/services/market-data-providers.ts`
- `src/services/external-market-providers.ts`
- `src/services/external-evidence-search.ts`
- `src/services/indicators.ts`
- `src/services/script-indicator-engine.ts`
- `src/services/composite-indicator-engine.ts`

本计划不以减少代码行数为目标，而是建立稳定的能力边界和轻量测试入口。

## 二、目标

1. 市场数据、研究检索和指标计算可以不启动微信、Portal、ACP、scheduler、SQLite 写入链路而独立运行。
2. 独立 runner 与现有 MCP/HTTP/内部调用复用同一份类型与业务契约，避免双实现。
3. provider、搜索后端和指标算法可以使用固定 fixture 做确定性测试，也可以通过显式命令执行 live probe。
4. Core Service 继续统一负责身份、scope、权限、确认、审计、持久写入、调度、推送和跨资源锁。
5. 第一阶段保持生产行为与部署拓扑不变；只有证据表明需要故障隔离或独立扩缩容时，才进入子进程或独立部署阶段。

## 三、非目标

- 不在第一阶段引入远程微服务、服务注册中心、消息总线或通用工具代理层。
- 不改变 Workspace Agent 当前可见的 `invest-agent-service-tools` MCP 工具名和输入输出语义。
- 不把 provider 凭据、内部 URL、任意 HTTP 调用或 vendor-specific 工具直接暴露给 Workspace。
- 不移动 SQLite、真实 Workspace、`reviews/`、`.state/` 或微信状态。
- 不把 confirmation、audit、resource lock、scheduler、push queue 或用户资产写入拆到 capability tool。
- 不同时重写全部 provider、research 和 indicator 实现。

## 四、设计原则

### 4.1 先接口解耦，再进程解耦

执行顺序固定为：

```text
稳定 contract
  -> 独立 runner
  -> 现有调用方迁移到 contract
  -> 独立测试和观测成立
  -> 评估是否需要子进程/独立部署
```

只有 contract 和测试稳定后，才允许讨论 IPC、MCP 子进程或远程服务。

### 4.2 Core Service 保留控制权

Capability 只回答“查到什么、算出什么、缺了什么”。Core Service 决定“谁可以调用、何时调用、如何审计、是否写入或推送”。

Capability 禁止：

- 直接修改用户 Workspace 或服务 SQLite；
- 自行完成用户 scope、权限或 confirmation 判断；
- 自行创建推送、定时任务或持久审计记录；
- 读取未通过参数或受控依赖显式提供的用户状态；
- 返回凭据、内部网络地址或未清洗的 provider 原始响应。

### 4.3 独立运行不等于复制实现

CLI、测试、MCP、HTTP 和 scheduler 必须调用同一个 capability contract。独立 runner 是适配器，不拥有第二套领域语义。

### 4.4 结构化失败优先

能力输出必须区分：

- 可用完整结果；
- 可用部分结果；
- 空结果；
- provider 限流或权限不足；
- 超时或网络错误；
- 输入不合法；
- capability 内部错误。

不能把所有失败压成普通字符串，也不能通过空数组静默掩盖 provider 故障。

## 五、目标边界

```text
Workspace ACP
  -> invest-agent-service-tools MCP
      -> Core Service policy adapter
          -> market-data capability
          -> research capability
          -> indicator capability

Core Service owns:
  identity / scope / permission / confirmation / audit
  SQLite and Workspace durable state
  scheduler / idempotency / locks / push delivery

Capability Plane owns:
  provider access and normalization
  research retrieval and source provenance
  deterministic indicator computation
  typed warnings and capability-local diagnostics
```

建议的初始代码形状如下。执行 Agent 可根据现有 import 关系微调，但不能改变职责边界：

```text
src/capabilities/
  shared/
    result.ts
    errors.ts
  market-data/
    contract.ts
    capability.ts
    providers/
    runner.ts
  research/
    contract.ts
    capability.ts
    providers/
    runner.ts
  indicators/
    contract.ts
    capability.ts
    engines/
    runner.ts

scripts/capabilities/
  market-data.mjs
  research.mjs
  indicators.mjs

tests/capabilities/
  fixtures/
  market-data.test.ts
  research.test.ts
  indicators.test.ts
```

不要求第一阶段一次性创建上述全部文件。每个阶段只添加当前能力所需的最小结构。

## 六、统一能力结果契约

三类能力应共享最小结果信封，但领域数据类型分别定义：

```ts
type CapabilityResult<T> = {
  status: "complete" | "partial" | "empty";
  data: T;
  sources: Array<{
    provider: string;
    fetchedAt: string;
    asOf?: string;
    confidence?: "high" | "medium" | "low";
  }>;
  warnings: Array<{
    code: string;
    message: string;
    provider?: string;
    retryable?: boolean;
  }>;
};
```

约束：

- 复用并兼容现有 `MarketSourceMeta`、provider telemetry 和 data-gap 语义，不为了统一而丢失已实现字段。
- `fetchedAt`、市场数据对应时间 `asOf` 和缓存返回时间必须可区分。
- provider 原始异常在 capability 边界内分类和清洗；Core Service 只接收稳定错误码和必要诊断。
- 对外 MCP 兼容层可继续维持现有响应形状，内部 contract 不要求一次性穿透到 Workspace Agent。

## 七、分阶段执行计划

### Phase 0：建立基线与依赖清单

目标：在移动代码前明确当前行为和耦合点。

任务：

1. 列出 `market-data`、`research`、`indicator` 的全部生产调用方。
2. 标记每个模块对以下资源的直接依赖：环境变量、网络、SQLite、WorkspaceStore、用户 ID、缓存、telemetry、logger、审计。
3. 为现有关键输出保存脱敏 fixture，覆盖成功、部分失败、空结果、限流和无权限。
4. 记录现有命令能验证的范围，包括 `npm run smoke:mcp-service-tools`、`npm run probe:market-data-live` 和指标 smoke。
5. 定义迁移前的行为基线，禁止在抽离过程中顺手改变 provider 优先级、数据质量策略或指标算法。

交付物：

- 当前调用关系清单；
- capability 依赖矩阵；
- fixture 清单和脱敏规则；
- 迁移前验证记录。

完成条件：执行者能回答每个能力是否依赖用户状态、是否有副作用、由哪些正式入口调用。

### Phase 1：抽离 `market-data-tool`

这是第一优先级，也是整个方案的可行性验证。

#### 1A. Contract 与 provider 边界

1. 从 `src/services/market-data.ts` 提取调用方真正依赖的公开类型和 capability 接口。
2. 保留 provider 归一化、来源信息、warning、fallback 和 partial-result 语义。
3. 将用户 portfolio/watchlist/plan 聚合与纯市场数据查询分开：
   - quote、K-line、indices、calendar、capital flow、sector/theme、fundamentals 属于 capability；
   - 从 Workspace 读取持仓并组成 `market.snapshot` 仍由 Core Service 编排。
4. provider telemetry 的持久化归 Core Service 或受控 adapter；capability 通过注入的 telemetry sink 报告事件，不直接假设数据库或目录。

#### 1B. 独立 runner

增加轻量入口，至少支持：

```text
quote
kline
indices
calendar
health
```

runner 要求：

- JSON 输入、JSON 输出；
- 无需启动 Fastify、ACP、scheduler 或微信连接；
- fixture 模式默认不联网；
- live 模式必须显式开启；
- stdout 只输出机器可读结果，诊断写 stderr；
- 不打印 token、完整凭据 URL 或未清洗 provider 响应。

建议命令：

```text
npm run capability:market-data -- quote --codes 600519,000001
npm run capability:market-data:test
npm run capability:market-data:live -- quote --codes 600519
```

最终命令名以 `package.json` 的项目风格为准。

#### 1C. 调用方迁移

按以下顺序迁移，且每一步单独验证：

1. standalone runner；
2. `invest-agent-service-tools` MCP market read tools；
3. sandbox HTTP market adapter；
4. scheduler/watch-rule/review 等内部调用方。

现有 MCP 工具名、scope、安全校验和审计行为保持不变。Core Service 在 capability 调用前后完成 scope、审计和调用级 telemetry。

#### 1D. Phase 1 验收

- 不启动完整服务即可完成 quote/K-line fixture 测试。
- 修改或增加一个 provider 时，不需要加载 ACP、Workspace、scheduler 或微信模块。
- standalone runner 与 MCP adapter 对相同 fixture 产生语义一致的结果。
- provider 超时、空数据、限流、权限不足和 fallback 都有稳定错误码或 warning。
- `market.snapshot` 仍由服务层完成用户数据聚合，不向 capability 传入任意 Workspace 路径。
- 现有 MCP、HTTP、scheduler、review 和 watch-rule 测试无行为回归。

### Phase 2：抽离 `research-tool`

前置条件：Phase 1 contract 和 runner 模式通过验收，不再频繁变化。

任务：

1. 抽离 news search、web search、web read 的领域接口和 provider chain。
2. 保留当前 SSRF 防护、逐跳 redirect 校验、大小限制、内容类型限制、超时和凭据 URL 拒绝。
3. 将 source provenance、final URL、provider fallback 和 warning 纳入稳定 contract。
4. 增加 fixture 模式，覆盖搜索成功、无结果、primary failure/fallback、恶意 URL、私网 redirect 和非文本响应。
5. MCP 仍只暴露命名后的 `research.*` 能力，不暴露任意 provider 或通用 HTTP proxy。

Phase 2 验收：

- research fixture 测试完全离线；
- 网络 live probe 可独立运行并报告实际 provider；
- SSRF 与凭据泄漏防线未因抽离而下沉到提示词或调用方；
- Core Service 仍持有用户 scope 与正式审计，capability 只返回清洗后的访问事件。

### Phase 3：抽离 `indicator-tool`

前置条件：明确指标运行所需输入，不允许 capability 自行读取任意用户 Workspace。

任务：

1. 将基础技术指标实现组织为尽可能纯的函数：标准化 K-line 输入，确定性指标输出。
2. 明确 composite indicator 定义、script indicator 运行和 acknowledgement 的不同边界：
   - 计算引擎属于 capability；
   - 用户定义读取、版本、授权、acknowledgement 和持久化属于 Core Service/Workspace contract。
3. 对脚本指标保留 `isolated-vm` 沙箱、资源限制、超时和禁止能力，不因独立 runner 而放宽。
4. 固定算法版本、输入精度、缺失值处理和 warm-up 规则，建立 golden fixture。
5. runner 接收显式定义和数据，不接受任意文件路径或隐式 Workspace 搜索。

Phase 3 验收：

- 相同 fixture 和算法版本的输出完全一致；
- 指标引擎测试不依赖数据库、网络或 ACP；
- script indicator 的超时、内存、模块访问和危险 API 测试继续有效；
-用户自定义指标的确认与 acknowledgement 仍由服务层强制。

### Phase 4：评估进程隔离，不默认实施

完成前三阶段后，根据证据决定是否将 capability 迁到子进程或独立部署。

只有满足至少一项时才建议拆进程：

- provider 或指标运行经常导致主服务崩溃、内存增长或事件循环阻塞；
- Python、浏览器、`isolated-vm` 等运行时依赖需要独立生命周期；
- 某能力需要独立扩缩容、限流或升级；
- 多个产品实际复用同一能力；
- 独立故障域带来的收益可量化地超过部署与观测成本。

若进入该阶段，先用本地子进程和版本化 JSON contract 验证，不直接上远程微服务。

## 八、测试策略

### 8.1 测试金字塔

1. 纯函数单元测试：解析、归一化、错误分类、指标算法。
2. fixture contract 测试：provider 原始响应到标准结果。
3. capability runner 测试：JSON 输入输出、exit code、stdout/stderr 和脱敏。
4. adapter contract 测试：MCP/HTTP 与 capability 语义一致。
5. 少量完整链路测试：ACP、scheduler、review、watch-rule 保持原有行为。
6. 显式 live probe：只验证真实 provider，不进入默认测试套件。

### 8.2 默认测试不得依赖

- 公网可用性；
- 真实用户 Workspace；
- 生产 SQLite；
- 微信登录状态；
- ACP 模型响应；
- 第三方付费额度。

### 8.3 Live probe 要求

- 显式命令或环境开关；
- 使用测试标的和只读请求；
- 输出 provider、耗时、数据日期、warning 和错误分类；
- 不把 live 结果固化为永远正确的 golden value；
- 不打印密钥；
- 失败不等同于默认离线测试失败，但必须明确退出状态和诊断。

## 九、兼容与迁移策略

1. 采用 branch-by-abstraction：先引入 contract，再逐个迁移调用方，最后删除确认无引用的旧入口。
2. 旧 facade 可在迁移期作为兼容 wrapper，但不得长期维持第二套逻辑。
3. 每迁移一个调用方都运行对应的已有 smoke/test，不集中到最后一次性切换。
4. provider 顺序、缓存、fallback、warning 和数据精度变化必须单独评审，不能夹带在模块移动中。
5. 第一阶段不修改生产部署单元，因此回滚方式是让 adapter 重新指向旧 facade；不触碰用户数据。

## 十、主要风险与缓解

| 风险 | 缓解措施 |
| --- | --- |
| 为了统一 contract 丢失现有来源和 warning 信息 | 先做现有字段清单与 fixture，contract 采用兼容超集 |
| 同时保留新旧实现导致逻辑分叉 | 新 facade 只能委托 capability；设置迁移完成后删除条件 |
| capability 越界读取 Workspace 或写数据库 | 通过依赖注入和边界测试禁止隐式状态访问 |
| 独立 runner 泄露 token 或 provider 原始响应 | stdout/stderr 契约、脱敏测试和固定错误分类 |
| live provider 不稳定拖慢默认测试 | fixture 默认、live probe 独立命令 |
| 过早拆成微服务增加部署负担 | Phase 4 设证据门槛，前三阶段保持同进程部署 |
| 指标计算与用户定义管理混在一起 | 计算引擎与定义/确认/acknowledgement 分层 |
| research 抽离削弱 SSRF 防护 | 安全校验属于 capability 强制代码，并保留 service adapter 的审计与 scope |

## 十一、总体完成标准

本计划完成不以目录移动为准，而以以下行为为准：

1. 三类能力都有稳定、版本可演进的 contract。
2. 三类能力均能脱离完整 Invest Agent 运行时执行 fixture 测试。
3. market-data 和 research 有显式、只读、可诊断的 live probe。
4. indicator 有确定性 golden fixture 和沙箱安全测试。
5. MCP、HTTP、scheduler 和内部调用者复用同一能力实现，没有平行业务逻辑。
6. Core Service 继续强制 scope、权限、confirmation、audit、持久化、锁、调度和推送边界。
7. 默认 `npm test`/`npm run verify` 不依赖公网、真实 Workspace 或生产状态。
8. 修改单一 provider 或指标算法时，可以在能力级测试中完成主要验证，只需要少量 adapter 与完整链路回归。

## 十二、建议工作包

为控制变更规模，建议按以下工作包分别提交和验收：

| 工作包 | 内容 | 预计风险 |
| --- | --- | --- |
| WP0 | 调用关系、依赖矩阵、fixture 和基线 | 低 |
| WP1 | shared result/error contract 与 market-data capability shell | 中 |
| WP2 | market-data standalone runner 和 fixture tests | 中 |
| WP3 | MCP/HTTP 迁移到 market-data capability | 高 |
| WP4 | scheduler/review/watch-rule 调用迁移与完整回归 | 高 |
| WP5 | research capability、runner、安全测试与 adapter 迁移 | 高 |
| WP6 | indicator capability、golden fixtures 与沙箱边界 | 高 |
| WP7 | 是否需要子进程隔离的证据评估 | 低 |

每个工作包必须独立可回滚，不允许 WP1-WP6 以一次大提交完成。

## 十三、待确认问题

以下问题不阻塞 WP0 和 WP1，但应在对应工作包开始前确认：

1. capability runner 主要面向开发者 CLI，还是未来也准备作为本地 MCP 子进程？建议先按 CLI/JSON contract 设计，不承诺部署形态。
2. provider telemetry 的现有文件持久化是否继续由 service adapter 执行，还是抽成注入式 sink？建议采用注入式 sink，默认测试使用内存 sink。
3. `market.health` 是 capability-local provider health，还是 Core Service 综合运行健康？建议拆成两个概念，现有 MCP 兼容层可聚合返回。
4. indicator 的第一批范围是仅基础指标，还是同时迁移 composite/script engine？建议先基础指标，再 composite，最后 script engine。

## 十四、执行 Agent 交接提示

```text
按照 docs/capability-plane-extraction-plan.md 执行当前指定的工作包。先阅读 AGENTS.md、docs/system-overview.md、docs/service-tools-mcp.md、docs/market-data-service-design.md、docs/data-source-policy-decision.md 和相关现有测试。保持生产 MCP 工具名、scope、安全、审计、provider 顺序和数据质量语义不变。不要触碰真实 Workspace、生产 SQLite、reviews、.state 或微信状态。使用 branch-by-abstraction，完成当前工作包的测试和验收后停止，不扩展到后续工作包。
```

## 十五、验收 Agent 交接提示

```text
独立验收当前 capability-plane 工作包。重点检查：是否真的可以脱离完整运行时测试；新旧入口是否复用同一实现；是否保持 MCP/HTTP 行为兼容；capability 是否越界访问用户状态或承担权限、确认、审计、写入、调度和推送职责；fixture、live probe、错误分类和脱敏是否满足计划验收标准。发现目录发生变化但行为目标未实现时，应判定为未完成。
```
