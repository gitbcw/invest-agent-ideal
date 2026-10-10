# T-196 Platform UI 展示重构 · 设计方案

> 状态：设计方案已确认，进入实施（第一批进行中）。
> 决策基线：视觉方向=**现代化升级（澜策品牌赋魂）**；统计增强=**前端聚合补充**（不新增后端接口、不改业务逻辑与路由）。

## 0. 品牌定义：澜策

产品名 **澜策**：

- **澜**：市场如水般的变化、周期与流动；
- **策**：基于信息分析形成策略与判断。

合起来寓意：**在变化的市场中看清趋势，形成更有纪律的投资决策。**

视觉意象四要素（配色与图标的语义来源）：

| 意象 | 含义 | 配色映射 |
| --- | --- | --- |
| 浅蓝天空弧线 | 开阔视野、持续观察与复盘校准 | 天空蓝 = 品牌主色（导航 / 主 CTA / 选中态） |
| 中央灯塔 | 长期目标、风险边界与关键时刻的方向提醒 | 灯塔白 / 墨蓝 = 稳重结构（卡片 / 标题 / 正文） |
| 金色灯光 | AI 提炼出的重点信号与关键判断 | 金色 = 高亮（关键指标 / AI 信号 / 重点数据） |
| 下方周期水波 | 市场与资产价格的涨落周期、持续跟踪 | 水波青 = 趋势 / 周期类数据 |

灯塔与水波共同构成**锚**的意象——既尊重市场变化，也帮助用户锚定投资原则，不因短期波动偏离目标。锚意象是 logo / 空状态图的情感基调。

## 1. 目标与范围

把 Platform 后台从两个单文件字符串模板（Owner `platform-page.ts` 1724 行 / Partner `partner-platform-page.ts` 154 行）重构为**模块化 SSR + 统一设计令牌**，全部 9 个视图（Owner 5 + Partner 4）翻新。

- **保留**：全部 9 视图现有功能点（逐条对等核对）、Partner 脱敏聚合与字段白名单、登录/权限/RBAC/强制改密行为、所有路由。
- **不做**：独立 SPA / 前端框架 / 构建管线；改后端 API 行为或权限契约；给 Partner 开放成本数据（T-181 范围）。
- **取舍优先级**：① 现有功能与权限/脱敏不破坏 ② 数据统计准确 ③ 视觉与交互翻新 ④ 代码结构优雅。

## 2. 技术形态

- **SSR 模板拆分**：保持服务端拼装 HTML 字符串，无前端框架、无打包器。
- **拆分手段**：把两个超大函数拆成「共享层 + 视图模块」的纯函数集合，每个模块导出返回 HTML 字符串的函数，由入口函数组合。仍是 TS 字符串模板，`tsc` 编译，零运行时依赖。
- **设计令牌**：用一份共享的 `:root` CSS 变量层替换 Owner 的硬编码色值与 Partner 的 8 变量雏形，作为两者统一视觉的唯一来源。

## 3. 模块拆分结构

新增目录 `src/admin/platform-ui/`，承载全部共享层与视图模块；现有两个入口文件改为薄壳，只负责组装 + 注入配置，逻辑全部下沉到模块。

```
src/admin/platform-ui/
  tokens.ts            设计令牌：输出统一 :root CSS 变量字符串 + JS 侧色彩常量
  shell.ts             共享布局壳：shell/sidebar/nav/topbar/notice/modal-backdrop 骨架
  primitives.ts        共享原子：escape()、badge()、stat()、metric()、pct()、empty()、pill()
  tables.ts            共享表格：kv-table / 通用 data-table 渲染
  icons.ts             内联 SVG 图标集合（视图标题、状态、操作按钮用）
  owner/
    platform-app.ts    Owner 入口：组合 5 视图 + 共享壳，导出 renderPlatformPage
    view-instances.ts  视图 A：用户助手（列表/详情/投资状态/微信面板）
    view-cost.ts       视图 B：成本统计（总览/各用户两 Tab）
    view-source.ts     视图 C：数据源质量
    view-audit.ts      视图 D：日志审计（对话/推送时间线）
    view-rules.ts      视图 E：规则巡检
  partner/
    partner-app.ts     Partner 入口：组合 4 视图 + 共享壳 + 登录/改密卡片
    view-overview.ts   经营总览
    view-customers.ts  客户与助手
    view-quality.ts    产品质量
    view-runtime.ts    运行与触达
```

**拆分原则**：视图模块只负责该视图的 DOM 渲染；跨视图复用的结构（面板、卡片、表格、徽标、统计卡）进 `shell.ts`/`primitives.ts`/`tables.ts`；色彩/间距/字号进 `tokens.ts`。`platform-page.ts` / `partner-platform-page.ts` 保留为对外入口（`platform.ts` import 不变），内部变为对 app 模块的委托。

## 4. 视觉方向（现代化升级 · 澜策品牌）

### 4.1 设计令牌体系（tokens.ts）

统一一套语义化 CSS 变量，配色取自澜策四意象（天空蓝 / 金色 / 水波青 / 墨蓝），替换现有全部硬编码色值与 Partner 8 变量雏形：

| 类别 | 令牌 | 取值（澜策） | 意象/用途 |
| --- | --- | --- | --- |
| 墨蓝文字 | `--ink` / `--ink-soft` / `--muted` | `#0e2236` / `#334e68` / `#627d98` | 灯塔稳重 / 正文 / 次要 / 标签 |
| 天空表面 | `--surface` / `--surface-raised` / `--surface-sunken` / `--surface-inset` | `#f0f5fb` / `#ffffff` / `#f7faff` / `#f1f6fc` | 天空弧线底 / 卡片 / 表头 / 输入嵌套 |
| 线 | `--line` / `--line-soft` / `--line-strong` | `#d6e1ef` / `#e8eff8` / `#b9cbe0` | 卡片边 / 分隔 / 输入边 |
| 天空蓝（主色） | `--brand` / `--brand-strong` / `--brand-soft` / `--brand-hover` / `--brand-ring` | `#2c7be5` / `#1665c1` / `#e6f0fc` / `#eef5fd` / `rgba(44,123,229,.16)` | 天空弧线 / 主按钮 / hover / 选中底 / focus ring |
| 金色（信号） | `--signal` / `--signal-strong` / `--signal-soft` | `#e0a82e` / `#b8860b` / `#fbf0d6` | 灯塔金光 / AI 信号 / 关键指标高亮 / 重点数据 |
| 水波青（趋势） | `--wave` / `--wave-soft` | `#2c8f9b` / `#dff1f3` | 水波 / 周期·趋势类数据 / 柱条 |
| 状态 | `--ok` / `--ok-soft` / `--warn` / `--warn-soft` / `--danger` / `--danger-soft` / `--info` / `--info-soft` | 绿/琥珀/红/蓝各一对 | 徽标 / 通知 / 异常 |
| 排版 | `--radius` / `--radius-sm` / `--radius-lg` / `--shadow-sm` / `--shadow-md` / `--gap` / `--gap-sm` / `--gap-lg` | 9/7/10px / 两级阴影 / 14/9/24px | 圆角 / 投影 / 节奏 |

字体族保持现有 system stack；字号阶用 `clamp()` 在移动端自适应。

### 4.1.1 金色（信号）的应用点

金色是澜策的差异化记忆点，需克制使用，避免泛滥：

- **关键统计卡**：顶部统计卡的主数值（如今日对话、成功率等核心指标）用金色或金色趋势位；
- **AI 信号 / 异常条**：经营总览「需要关注」排序条的金色提示点；
- **高亮数据**：表格中被标记为重点的数值（不强求全量，仅核心视图）。

不得用金色做大面积背景或普通文字色（保留给"灯塔照亮的重点"语义）。

### 4.2 视觉升级要点（相对现状的变化）

1. **留白与节奏**：统一间距用 `--gap`/`--gap-sm`，卡片内边距、面板间距不再散落硬编码；统计卡之间、面板之间留白更舒展。
2. **卡片化层次**：面板统一 `--surface-raised` + `--shadow-sm` + `--radius`；统计卡（`.stat`）强化为大数字 + 标签 + 可选趋势位的结构，弱化密集感。
3. **统一交互态**：为按钮/卡片/列表项/可点击行补齐 `:hover` / `:active` / `:focus-visible`（聚焦环用 `--brand-ring`，取代散落的 `box-shadow: 0 0 0 3px rgba(...)`）；`disabled` 统一半透明 + 无投影。
4. **徽标与状态统一**：`badge` 用语义令牌（ok/warn/danger/info/gray），移除逐处写死的背景/前景色对。
5. **表格可读性**：表头加 `--surface-sunken` 底、行分隔用 `--line`、数字列右对齐、金额/Token 用等宽列。
6. **响应式**：保留并统一现有 `@media (max-width:980px)` 断点行为（侧栏转横向滚动、多栏降单栏）。

### 4.3 视觉约束（不破坏现有信息与行为）

- 不改信息密度语义：每个视图原有哪些数据字段、筛选器、操作按钮，新版一一对等（见 §6 对等清单）；视觉升级只动样式与布局节奏，不删字段、不并功能。
- 内联 `<script>` 逻辑（数据拉取、视图切换、事件处理）行为保持等价，只迁移到与渲染解耦的位置；路由请求路径、请求方法不变。

## 5. 统计口径与新增指标清单（前端聚合，不新增后端接口）

所有「新增」指标均为**前端在现有 4 个 Partner API 与 Owner 现有接口返回数据上的二次聚合**，口径基于已确认的 API 字段，不新增后端接口、不改业务逻辑。

### 5.1 Partner 现有 API 可用字段（已核对 platform.ts:1211-1400）

- `/partner/overview`：`metrics.{customersTotal, customersActivated, activeCustomers7d, activeCustomers30d, onboardingCompleted, onboardingInProgress, onboardingException, conversationCountToday, conversationSuccessRateToday, responseP50MsToday, responseP95MsToday, reviewCoverageToday, pushDeliveryRateToday, qualityExceptionCountToday, dataSourceExceptionCountToday}` + `exceptions[]` + `dataQuality`。
- `/partner/customers`：每条含 `assistantStatus / onboardingStatus / health / wechatBound / pushReachable / conversationCount7d / lastReviewAt / lastPushStatus / notificationPreference / enabledRuleCount`。
- `/partner/customers/:key/operations`：`setup / usage / delivery / quality` 四组。
- `/partner/quality`：`items[]`（conversation_success/error/timeout、repeat_confirmation，含 count/rate/status/affectedCustomers）+ `dataQuality`。
- `/partner/runtime-health`：`items[]`（wechat_reachability / push_delivery / market_data，含 status/count/affectedCustomers）+ `dataQuality`。

### 5.2 新增前端聚合指标清单（需在本方案确认后实施）

| 视图 | 新增指标 | 口径（数据来源） | 落点 |
| --- | --- | --- | --- |
| 客户与助手 | **健康度分布**（健康/关注/异常各多少） | 由 `/customers` 全量分页拉取后按 `health` 字段计数 | 客户列表顶部新增汇总卡组 |
| 客户与助手 | **初始配置分布**（completed/drafting/exception/not_started） | 同上，按 `onboardingStatus` 计数 | 同上汇总卡组 |
| 客户与助手 | **触达可达率** | `wechatBound && pushReachable` 占比 | 同上汇总卡组 |
| 产品质量 | **顶部汇总卡**（成功/错误/超时/重复确认 4 项 count） | 直接取 `/quality.items[]` 现有字段做汇总卡化 | 视图顶部新增统计卡行 |
| 运行与触达 | **顶部汇总卡**（可触达/推送失败/行情数据异常 3 项） | 直接取 `/runtime-health.items[]` 现有字段做汇总卡化 | 视图顶部新增统计卡行 |
| 经营总览 | **异常聚焦排序**（按 affectedCustomers 排序的可视化条） | 取 `/overview.exceptions[]` 现有字段 | 「需要关注」区增强为排序条 |

**口径不变承诺**：overview 视图现有的 4 张统计卡与「今日经营信号」口径完全保留，只增强异常区的呈现。所有新增聚合都不引入现有 API 不提供的字段；若实施中发现某聚合所需字段缺失，按契约停止规则停下问，不自行编造或改后端。

### 5.3 数据缺失处理（沿用现有约定）

- 比率类指标分母为 0 时显示「—」或「无数据」，不显示 0%（沿用 `pct()` 与现有「数据缺失标记部分可用」约定）。
- 聚合为 0 时正常显示 0，不隐藏。

### 5.4 成本费用换算（v2 新增）

成本视图在 Token 统计基础上增加费用换算，费率单位 **$/Mtok（每百万 token）**，口径见 `pricing.ts`：

| Token 类别 | 费率 | 依据 |
| --- | --- | --- |
| 输入 input | $5/Mtok | 用户确认 |
| 输出 output | $30/Mtok | 用户确认 |
| 推理 thought | $5/Mtok | 复用输入费率 |
| Cache Read | $0.5/Mtok | 输入价格的 1/10 |

费用公式：`费用 = 输入/1M×5 + 输出/1M×30 + 推理/1M×5 + CacheRead/1M×0.5`。费率集中在 `pricing.ts` 一处，调价只改这里，owner/partner 成本视图共用。

**Partner 成本视图脱敏边界**（v2 契约）：Partner 仅看「总览统计」大盘（全平台 Token 与费用汇总 + 按日期），**不渲染「各用户统计」Tab 与按实例拆分表**——因为按 instanceId 分组会暴露明文 instanceId，破坏脱敏。按客户的成本明细属 T-181 范围。

## 6. 9 视图功能对等清单（重构核对依据）

### Partner（第一批）
- **经营总览**：4 统计卡（客户总数/近7日活跃/已完成初始配置/今日对话）+ 今日经营信号（成功率/P50/P95/复盘覆盖率/推送送达率/质量异常）+ 需要关注异常列表 + 「不含投资明细」声明。**增强**：异常区排序条。
- **客户与助手**：表格（客户/初始配置/健康度/通知偏好/近7日对话/最近推送/查看）+ `limit=50` 游标分页「加载更多」+ 「查看运营摘要」展开 12 项脱敏指标 + 「只显示运营状态，不含投资明细」声明。**增强**：顶部汇总卡组（健康度/初始配置/触达分布）。
- **产品质量**：metric-list（4 项质量指标，比率标注，部分可用标记）。**增强**：顶部汇总卡行。
- **运行与触达**：metric-list（3 项运行触达状态，不含消息正文/账号标识/管理操作声明）。**增强**：顶部汇总卡行。

### Owner（第二批）
- **用户助手**：搜索框 + 创建按钮 + 刷新 + 4 统计卡 + 助手列表（名称/instanceId/状态/用户/持仓自选提醒）+ 详情面板（kv + 操作按钮：门户凭证/Workspace/归档/重置）+ 投资状态摘要（持仓/自选/预案/复盘/观点折叠表）+ 微信面板（连接/监听/测试/断开/刷新/二维码/绑定列表）+ 创建助手 Modal。
- **成本统计**：时间筛选（7/30/90/365）+ 刷新 + 双 Tab（总览/各用户）+ Token 用量汇总卡 + 按实例表 + 按日期表。数据源 `/api/platform/audit/usage`。
- **数据源质量**：刷新 + 能力总览 + 能力矩阵表（证据等级 badge）+ Provider 健康 + Endpoint 状态表 + 质量日报 + 告警表。
- **日志审计**：对话/推送 scope 切换 + 用户/助手/条数筛选 + 时间线（原始 vs 清洗双列对比 + 可折叠技术字段 + token/cost badge）。
- **规则巡检**：用户/助手/条数筛选 + 运行总览 + 最近运行表 + 最近命中事件表 + 启用规则表。

**脱敏红线**：Partner 任何视图不得出现 `instanceId`、`userId`、`workspacePath`、`costAmount`、`stockCode`、回复正文等；客户标识必须为 `cus_` 前缀的 `customerKey`（前端只消费已脱敏字段，不自行拼装标识）。

## 7. 交付节奏与门禁

### 第一批：新设计壳 + Partner 4 视图
- 交付：`tokens.ts` / `shell.ts` / `primitives.ts` / `tables.ts` / `icons.ts` + `partner/*` 4 视图 + `partner-app.ts`；`partner-platform-page.ts` 改为委托壳。登录壳与强制改密卡片随壳迁移，行为不变。
- 门禁：`smoke:platform-partner-auth` + `smoke:platform-partner-migration` + `verify` 退出码 0；Partner 4 视图功能对等核对（§6）；脱敏标识 `cus_xxx` 无泄露；[human-gate] 视觉走查（127.0.0.1:22655）。

### 第二批：Owner 5 视图
- 交付：`owner/*` 5 视图 + `platform-app.ts`；`platform-page.ts` 改为委托壳。
- 门禁：`verify` + 两条 smoke 退出码 0；Owner 5 视图功能对等核对（§6）；登录/权限/强制改密行为不变；[human-gate] 视觉走查。

## 8. 待确认项 / 风险

- **Partner 全量现查性能**：客户汇总卡组需分页拉取 `/customers` 全量做分布计数（现有接口 limit≤50 + 游标）。默认本期保留全量拉取方式（与现状一致）；若需优化需另议后端聚合（触及边界，不在本期）。请确认是否接受「保留现状、不优化」。
- **疑似遗留 CSS**：Owner `platform-page.ts` 现含 `.eval-*` / `.review-*` / `.case-meta` 等类（约 60 行），疑似旧评估工作台遗留、当前 HTML 无引用。本期按红线不删除功能点，会原样保留这些类不动（不作为「视觉精简」依据）。请知悉。

---

**请确认**：以上设计方案（页面结构 §3、视觉方向 §4、统计口径与新增指标 §5）是否批准进入实施？若需调整视觉强度、新增指标清单或交付范围，请在确认时一并指出。
