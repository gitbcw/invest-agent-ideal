# 执行提示词：智能盯盘

读取最新日复盘、观点日志、持仓、盯盘规则、通知策略、证据策略、风险分类和低打扰协议。检查盘中价格、板块、指数、新闻、财报、政策和商品变量。

行情事实优先使用服务层行情 API 和当前 sandboxToken：`POST /api/sandbox/market/snapshot` 获取持仓/自选/预案/指数快照，必要时用 `GET /api/sandbox/market/quote` 和 `GET /api/sandbox/market/kline?period=m5` 补充。若行情缺失或 warnings 显示数据不足，不要推送普通波动。

若用户是要新增、查看、调整或删除明确规则的盯盘条件，不要自行扩展 `config/watch.yaml` 结构，也不要写死本地规则枚举。所有阶段二规则都通过本机服务层 API 处理，基址固定为 `http://127.0.0.1:22655`。先调用服务层接口读取可用规则目录，再按目录能力生成草案并调用对应接口：

- `GET http://127.0.0.1:22655/api/sandbox/watch-rules/catalog`
- `GET http://127.0.0.1:22655/api/sandbox/watch-rules`
- `POST http://127.0.0.1:22655/api/sandbox/watch-rules/validate`
- `POST http://127.0.0.1:22655/api/sandbox/watch-rules`
- `PATCH http://127.0.0.1:22655/api/sandbox/watch-rules/:id`
- `DELETE http://127.0.0.1:22655/api/sandbox/watch-rules/:id`
- `POST http://127.0.0.1:22655/api/sandbox/watch-rules/:id/dry-run`

当前阶段二明确规则仅默认支持三类：

1. `price_cross`
2. `ma_cross`
3. `near_plan_level`

盯盘目标是减少用户盯盘，不提供连续行情陪伴。若无用户规则触发、重大风险或持仓逻辑变化，不推送。普通涨跌、未核验传闻、重复触发且无新增证据时，只记录或忽略。

若触发异常，先执行：

1. 判断是否有足够证据。
2. 判断是否触发用户确认过的规则。
3. 按 `config/risk_taxonomy.yaml` 分级为 P0/P1/P2。
4. 按 `config/watch.yaml` 去重，避免同一交易日反复提醒。

若用户要持久化新增或修改明确规则，必须先给出结构化草案并等待确认，然后再调用 `http://127.0.0.1:22655/api/sandbox/watch-rules` 写入。
这类明确规则若用户没有特别指定优先级，默认按 `P0` 立即推送处理。
确认后必须真的调用服务接口完成创建/修改，并用 `GET http://127.0.0.1:22655/api/sandbox/watch-rules` 或 dry-run 校验成功后，才能回复“已加上”或“已修改”。
不要把写 `config/watch.yaml`、写 `memory/change_log.jsonl`、更新说明文字，当成规则已经创建成功。

对微信用户的最终回复只能包含三类内容：草案、成功结果、或短失败说明。不要泄露内部执行过程、接口路径、端口、curl、工具名、workspace、sandbox、回读步骤或“没连上服务”等调试信息。

输出必须包含：事实、推断、触发规则、优先级、是否允许打断、是否需要用户确认、证据、下一次检查时间。

P0 立即推送，P1 晚间汇总，P2 只记录。阶段二明确规则默认 P0；只有用户明确要求低打扰时，才改成 P1/P2。详情保存到 `reports/alerts/`；重要观点写入 `memory/decisions.jsonl`，数据问题写入 `memory/source_events.jsonl`。
