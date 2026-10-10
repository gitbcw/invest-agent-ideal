# T-574：全持仓筛选数据准备编排

日期：2026-10-06  
范围：MG 交互式全持仓/组合筛选请求的最小程序编排。

## 实现

新增 `src/runtime/screening-preparation.ts`，并接入 `src/runtime/agent.ts`：

- 只有识别到全持仓、全部持仓、组合筛选/复盘等请求时才启用；普通对话和单股请求不改变。
- 程序读取当前投影，去重并分离股票与 ETF。
- 股票统一预取一次 `get_hist_klines`（120 条、日线、前复权）。
- ETF 不进入股票批量工具，单独预取实时快照。
- 结果压缩为带来源、时点和缺口的证据包注入 Agent。
- 预取成功后隐藏本轮重复的历史/实时/均量工具，保留资金流、筹码、新闻等补充工具。
- 编排失败自动回退原有 Agent 自主路径，不改变请求可用性。

程序不决定候选、评分或行动状态；Agent 仍负责解释证据、处理缺口并作出“继续观察/准备行动/暂不处理”判断。

## 验证

本地镜像通过临时生产 MCP 桥接做了一次全持仓请求：

- 预取：`get_hist_klines` 1 次、`get_realtime_quote` 1 次；
- 后续 Agent 没有再调用 `get_hist_kline` 或重复 `get_realtime_quote`；
- 后续调用仅为 `get_fund_flows`、`get_stock_profiles_chips`、`get_trading_calendar` 和补充单股资料；
- 该轮在约 242 秒时人工停止，说明重复行情取数已消除，但策略/工作文件读取和补充判断仍然较慢；
- 未写入资产、策略、预案或提醒。

判定：数据准备编排 `Pass with caveats`；完整全持仓交付仍为 `Partial`，不把 Agent 长思考问题伪装成编排已解决。

