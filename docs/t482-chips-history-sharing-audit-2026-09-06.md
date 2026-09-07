# T-482 核对报告：P-27 与 P-29/qsse-qlib 筹码历史数据共享与可复用范围

> 2026-09-06 · P-33 · 任务 T-482 · 全程只读（生产查询仅 SELECT/scp 拉取，未修改任何生产数据、任务、接口）

## TL;DR

1. **已有可复用的历史筹码序列**：qsse-qlib 侧（P-29）有 2026-05-25 起的全市场真实腾讯筹码序列（主 CSV 60 日满覆盖 + 归档 12 个有值日，约 70 个交易日 × ~5200 只）。P-33 控盘度 S1 **不需要从零等待积累**。
2. **两条链数值同源等价**：P-27 快照库与 qsse-qlib CSV 在同股同日逐字一致（600519/000420 双样本验证），都来自腾讯网关 `stock_quote_snapshot` 的 Chip* 字段。
3. **P-27 的「无法回填」结论是错的**：其调用不传 `date` 参数所以只拿到最新快照；qsse-qlib 的调用传 `date` 且实测当前可回看到 2026-05-20。P-27 快照库 8 月初~9 月初的机会性缺口**可以回补**。
4. **存在每日重复采集**：同一天全市场筹码被采两遍（16:00 qsse-qlib + 17:00 P-27 cron），上游同源、数据等价，建议 P-27 定时采集改读 qsse CSV、腾讯仅兜底。
5. 建议：**extend**（细节见 §7）。

## 1. 跨项目数据流图（现状）

```
腾讯自选股网关 proxy.finance.qq.com（体系A，逆向自 westock-data）
│  route=stock_quote_snapshot，fields=MainNetFlow…,ChipProfitRate,ChipAvgCost,
│  ChipConcentration90,ChipConcentration70；带 date 参数→历史，不带→最新快照
│
├─(A) P-29 qsse-qlib 每日采集（火山云 16:00，PM2 qsse-collector）
│     qsse_qlib/data/tencent_api.py:105  ← 调用传 date
│     → data/quotes_history.csv（滚动60日，18列含4筹码列）
│     → 裁剪行归档 data/archive/quotes_archive.csv（365日保留）
│     → 重建 qlib bin 池（选股/回测用）
│
├─(B) P-27 market-data-tool 降级源（常驻，仅最新值）
│     src/market_data_tool/sources/qsse_qlib_source.py ← 只读 (A) 的 CSV
│     环境默认路径=/home/claude/qsse-qlib/data/quotes_history.csv（生产同机即达）
│     fetch_profile(chips) 只取 CSV 最新一日 → 作为 tencent 源失败时的兜底
│
├─(C) P-27 腾讯源（常驻）
│     src/market_data_tool/sources/tencent_source.py:403  ← 调用【不传 date】
│     → get_stock_profile(chips) 最新快照 + 机会性落库
│
└─(D) P-27 定时采集（火山云 cron 每交易日 17:00，T-481，09-04 首跑）
      scripts/snapshot_chips.py → 全市场 ~5200 只 → chips_snapshot.db
      （降级链 tencent→qsse CSV；同日幂等；保留 3 年）
      读取方：MCP get_chips_history / get_stock_profiles_chips（快照兜底）

消费方：P-33 控盘度（mg）——T-478 已证实筹码链 Excel↔生产快照库逐字一致=exact，
        但快照缺口使 5 日方向判定不严格（本报告解的就是这个缺口）
```

## 2. 能力矩阵

| 能力 | P-29 qsse-qlib | P-27 market-data-tool |
|---|---|---|
| 筹码字段 | 获利比例/平均成本/90%集中度/70%集中度（4 项汇总指标） | 同左 4 项（+收盘价），完全同源 |
| 历史长度（生产实测） | 2026-05-25 ~ 09-04，约 70 交易日 | 全市场仅 09-04 起（首跑 2010 只）；此前零星 1~54 只/日 |
| 保留策略 | 主 CSV 滚动 60 日；归档 365 日（config `archive_retention_days`） | SQLite 3 年（`CHIPS_RETENTION_DAYS=365*3`） |
| 回查接口 | 无对外回查 API（CSV/bin 为内部格式；归档无读取代码消费） | MCP `get_chips_history`（按股按区间）、`get_stock_profiles_chips`（批量最新+快照兜底） |
| 历史回填 | `scripts/backfill_extras.py` 带 date 回补（08-05 实际跑成 60 日） | **无**——`_snapshot_data` 不传 date，被误判为"网关无历史参数" |
| 元数据治理 | 无 source/fetched_at 列 | source/fetched_at/evidence_level/usage_boundary/schema_version 齐 |
| 标的范围 | 东财全市场清单 ~5208-5221 只（含北交所口径以清单为准） | 申万一级成分 ~5200 只（09-04 实采 2010，缺口原因无日志，待观察） |

## 3. 覆盖统计（生产实测，2026-09-06 查询）

**qsse-qlib 侧**（awk 逐日统计 `chip_profit_rate` 非空行）：

| 数据集 | 日期范围 | 筹码覆盖 |
|---|---|---|
| 归档 quotes_archive.csv | 05-12 ~ 06-11（23 日 × ~5209 行） | 05-12~05-22 **全空**；05-25 起 97.7%~100%（分界点） |
| 主 quotes_history.csv | 06-12 ~ 09-04（60 日 × ~5210 行） | 每日 99.3%~100% |

> 05-12~05-22 空值原因：08-05 回填时网关未返回该时段筹码（当时回看窗口约 72 天）。**当前时点实测网关已能返回 05-20 的筹码**（见 §4），窗口并非固定，以逐日验证为准。

**P-27 侧**（chips_snapshot.db，2358 行，source 全部 tencent）：08-05~09-03 为机会性落库（每日 1~54 只，只含被查过的股票）；**09-04 首次全市场采集 2010 只**。cron 部署证据：`0 17 * * 1-5 cd ~/market-data-tool && uv run python scripts/snapshot_chips.py`。

## 4. 关键分歧点核实：腾讯网关是否支持历史筹码

- **支持**。证据链：
  - qsse-qlib `tencent_api.py:105` 传 `date` 参数；`scripts/backfill_extras.py` 08-05 实际回填 60 日成功（`extras_state.json` done_count=60，log「资金流/筹码补采完成: 60 天」）。
  - 本机复测（09-06，只读单股）：2026-05-20/06-15/06-26/08-27/09-04 五个日期全部返回筹码；其中 06-15 获利比例 1.23 / 平均成本 1416.63 / 90集中度 8.41 与 qsse CSV 06-15 行逐字一致 → 返回的是**真实历史数据**，非最新快照。
- P-27 `tencent_source.py:401-403` 的 `_snapshot_data` 不传 date → 只得最新快照 → `snapshot_chips.py` 头注释「腾讯筹码网关只返回最新一份快照、无历史查询参数……无法回填」是**错误结论**（`chips_snapshot.py` 的 `CHIPS_USAGE_BOUNDARY` 同病）。

## 5. 交叉样本比对（同股同日）

| 股票 | 日期 | qsse CSV (profit/avg/conc90/conc70) | P-27 db | 结论 |
|---|---|---|---|---|
| 600519 | 09-04 | 35.31/1370.08/10.65/6.46 | 35.31/1370.08/10.65/6.46 | 逐字一致 |
| 600519 | 08-27 | 20.53/1372.23/10.65/6.46 | 20.54/1372.23/10.65/6.46 | 一致（±0.01 舍入） |
| 000420 | 09-04 | 50.07/3.81/18.12/10.89 | 50.07/3.81/18.12/10.89 | 逐字一致 |
| 000420 | 08-27 | 19.21/3.84/18.72/12.83 | 19.21/3.84/18.72/12.83 | 逐字一致 |

两链等价，可互为备份/迁移源。

## 6. 替代历史筹码渠道（能力核验，未接生产）

| 渠道 | 状态 | 证据 |
|---|---|---|
| 腾讯网关带 date | **可用，主源** | §4 双重验证 |
| akshare `stock_cyq_em`（东财） | 接口存在但**连接失败**（本机 09-06 实测 urllib3 连接层异常） | 与 `docs/EASTMONEY_IP_BAN.md` 风控记录吻合；只可做人工对照，不能当稳定主序列 |
| 同花顺副图 | 无公开 API，仅人工目视（T-478 用作对照基线） | — |
| 通达信本地数据 | 需客户端+文件解析，无云历史 | — |

T-478 提出的「腾讯 vs 东财主序列」口径裁决：以现状证据，**东财不可稳定取得，建议裁决为腾讯主序列**，东财降级为人工抽查对照。

## 7. 结论与建议（extend）

**复用结论**：P-33 控盘度 S1 的筹码历史需求（5 日方向判定窗口）**现在就满足**——直接用 qsse-qlib 主 CSV（06-12~今，满覆盖）即可启动，无需等 P-27 积累；要更长窗口再并归档（05-25 起）。读取方式最低成本：`ssh 只读 scp 拉取 CSV`（T-478 已这么干过）或让 P-27 的 `qsse_qlib_source` 读归档路径。

**重复建设判断**：P-27 cron 与 qsse-qlib 16:00 采集**每日全市场重复打同一上游**（数据已证等价）。不算推倒重来，但应去重。

**建议动作**（均未执行，按边界留待决策）：
1. **P-33 S1：go**——用 qsse CSV 启动，不等 P-27 积累。
2. **P-27 定时采集调整**：17:00 cron 的主路径改读 qsse CSV 当日行（16:00 已采好、等价已证），腾讯上游仅在 qsse 采集失败/当日行缺失时兜底。消除每日 ~5200 只重复请求，也顺带消除 2010/5200 型缺口。
3. **P-27 快照库缺口回补（可选）**：给 `_snapshot_data`/快照链加 date 参数，按日回补 08-05~09-03 缺口（当前实测网关可回看到至少 05-20）。同时修正 snapshot_chips.py / chips_snapshot.py 里「无法回填」的错误注释与 usage_boundary 文案。
4. **qsse 归档的消费缺口**：归档 CSV（365 日保留）目前无任何代码读取，是"只写不读"的沉没资产；P-27 若需要 >60 日窗口，读归档即可，**无需扩容 qsse 主 CSV 的 60 日窗口**（边界也禁止擅自扩容）。
5. **观察项**：09-04 首跑 2010/5200 缺口无日志佐证；下个交易日（09-07 周一）验证 cron 正常日志（logs/chips_snapshot.log）与当日覆盖率。

**风险与边界**：筹码为腾讯加工数据（secondary_evidence），非交易所事实；两条链同源，互为备份不能交叉验证口径（要验证口径得靠东财/同花顺人工对照）；归档 CSV 的 SQLite 化（config `archive_db_path`）只有配置没有实现，属半成品，本报告按 CSV 现状核对。

## 附：证据清单

- 代码：`qsse-qlib/qsse_qlib/data/{tencent_api,pipeline}.py`、`scripts/backfill_extras.py`；`market-data-tool/src/market_data_tool/sources/{qsse_qlib_source,tencent_source}.py`、`core/chips_snapshot.py`、`scripts/snapshot_chips.py`（本机 main 分支）
- 生产：`~/qsse-qlib/data/{quotes_history.csv,archive/quotes_archive.csv,extras_state.json,extras_full.log}`、`~/.cache/market-data-tool/chips_snapshot.db`、`crontab -l`（118.145.115.197，2026-09-06 只读查询）
- 复测：本机调 `tencent_api.fetch_snapshot_batch(['sh600519'], d)` 五日期（09-06）；akshare `stock_cyq_em` 本机连接失败（09-06）
- 关联：T-478 报告 `docs/mg-chip-control-assetization-feasibility-2026-09-06.md`（P-33 repo）
