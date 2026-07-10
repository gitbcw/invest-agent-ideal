# 执行提示词：盘中定时简报

本 skill 负责 `market-watch` 盘中定时简报/摘要，不等同于 `rule-alert-check` 明确规则巡检。读取最新日复盘、观点日志、持仓、提醒边界、通知策略、证据策略、风险分类和低打扰协议。检查盘中价格、板块、指数、新闻、财报、政策和商品变量。

行情事实优先使用 `invest-agent-service-tools` MCP 工具获取：`market.snapshot` 获取持仓/自选/预案/指数快照，必要时补充 `market.quote` 或分钟级行情证据；只有 MCP 工具不可用时，才用 workspace 根目录 `.sandbox-token` 授权的 HTTP sandbox API 兜底。若行情缺失或 warnings 显示数据不足，不要推送普通波动。

若用户是要新增、查看、调整或删除明确规则的盯盘条件，不要自行扩展 `config/watch.yaml` 结构，也不要写死本地规则枚举。所有阶段二规则都优先通过 `invest-agent-service-tools` MCP 工具处理，HTTP sandbox API 只作为 MCP 工具不可用时的兜底。先读取可用规则目录，再按目录能力生成草案并调用对应工具或接口：

- `GET http://127.0.0.1:22655/api/sandbox/watch-rules/catalog`
- `GET http://127.0.0.1:22655/api/sandbox/watch-rules`
- `POST http://127.0.0.1:22655/api/sandbox/watch-rules/validate`
- `POST http://127.0.0.1:22655/api/sandbox/watch-rules`
- `PATCH http://127.0.0.1:22655/api/sandbox/watch-rules/:id`
- `DELETE http://127.0.0.1:22655/api/sandbox/watch-rules/:id`
- `POST http://127.0.0.1:22655/api/sandbox/watch-rules/:id/dry-run`

当前阶段二明确规则能力以服务层 catalog 为准，不要凭本 prompt 写死规则全集或自行扩展 workspace YAML。

盘中定时简报目标是减少用户盯盘，不提供连续行情陪伴。若处于异常触发模式且无用户规则触发、重大风险或持仓逻辑变化，不推送。普通涨跌、未核验传闻、重复触发且无新增证据时，只记录或忽略。

若触发异常，先执行：

1. 判断是否有足够证据。
2. 判断是否触发用户确认过的规则。
3. 按 `config/risk_taxonomy.yaml` 分级为 P0/P1/P2。
4. 按 `config/watch.yaml` 去重，避免同一交易日反复提醒。

若用户要持久化新增或修改明确规则，必须先给出结构化草案并等待确认，然后再调用 MCP 写入工具或 HTTP 兜底接口写入。
这类明确规则若用户没有特别指定优先级，默认按 `P0` 立即推送处理。
确认后必须真的调用服务工具完成创建/修改，并回读或 dry-run 校验成功后，才能回复“已加上”或“已修改”。
不要把写 `config/watch.yaml`、写 `memory/change_log.jsonl`、更新说明文字，当成规则已经创建成功。

对微信用户的最终回复只能包含三类内容：草案、成功结果、或短失败说明。不要泄露内部执行过程、接口路径、端口、curl、工具名、workspace、sandbox、回读步骤或“没连上服务”等调试信息。

输出必须包含：事实、推断、触发规则或未触发说明、优先级、是否允许打断、是否需要用户确认、证据、下一次简报或检查时间。

P0 立即推送，P1 晚间汇总，P2 只记录。阶段二明确规则默认 P0；只有用户明确要求低打扰时，才改成 P1/P2。详情保存到 `reports/alerts/`；重要观点写入 `memory/decisions.jsonl`，数据问题写入 `memory/source_events.jsonl`。
