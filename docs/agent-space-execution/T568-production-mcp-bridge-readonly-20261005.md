# T-568：生产 MCP 只读桥接验证记录

日期：2026-10-05  
环境：本地 `production-mirror` + 生产主机只读检查  
范围：仅验证连接、MCP discovery 和一条低成本只读调用；不启动本地 scheduler/push，不修改生产配置、数据库、Workspace 或任务。

## 结论

状态：`Pass with caveats`（2026-10-05 复验更新）。

- `qsse-qlib`：`Pass with caveats`。通过临时 SSH 本地端口转发和生产 `.env` 中现有授权，在本地 MCP client 中完成 `initialize`、`tools/list` 和 `quant_capabilities` 单次只读调用。
- `market-data-tool`：`Pass with caveats`。此前的初始化无响应已恢复；通过临时 SSH 转发完成 `initialize`、`tools/list`、`list_capabilities` 和单标的行情读取。
- 因此生产 MCP 桥接已达到“可进入 MG 真实数据主线复验”的门槛，但尚未证明超时/断开降级、调用预算和完整 Agent 端到端消费链路。默认镜像仍保持 OFFLINE。

## 证据

### 1. 生产进程与端口

只读 SSH 检查结果：

| 服务 | 进程 | 端口 | 观察 |
|---|---|---:|---|
| market-data-tool | `market-data-tool-mcp`（PM2 online） | `22640` | 生产机本地监听；公网直连不可达，适合隧道访问 |
| qsse-qlib | `qsse-mcp-http`（PM2 online） | `22648` | `/mcp` 无授权返回 `401`，说明端点和鉴权中间件在线 |

生产环境中两套 MCP URL/token 配置项均存在；本地工作树和镜像目录没有复制这些值。

### 2. QSSE 只读桥接

临时通道：SSH `-L` 转发到生产回环地址，验证后关闭；没有写入本地 `.env` 或仓库。

- `initialize`：通过。
- `tools/list`：通过，发现 4 个工具：`quant_backtest`、`quant_capabilities`、`quant_screen_stocks`、`quant_validate_expression`。
- `quant_capabilities`：通过，返回非空能力文本（约 7.2 KB）；`isError=false`。
- 未执行筛选、回测、写入或生产调度。

### 3. market-data-tool 复验

- 生产 `22640` 进程为 online，Uvicorn 绑定 `0.0.0.0:22640`；本次进程 uptime 约 26 分钟。
- 通过临时 SSH 转发，`initialize` 用时约 70ms，`tools/list` 返回 38 个工具。
- `list_capabilities` 返回非空能力结果（约 30KB）；`get_realtime_quote(symbols=[600519])` 返回 1 条行情，来源标记为 `tencent`。
- 本次未调用写工具、调度或投递工具；单标的读取属于低成本只读验证。

此前无响应现象已恢复，但仍应保留为一次已观察的瞬时可用性事件，后续 MG 复验需记录首字延迟、工具耗时和失败类别。

## 当前禁止动作

- 不把 `MARKET_DATA_MCP_*` / `QSSE_MCP_*` 写入本地长期环境或提交到仓库。
- 不在生产 runtime 开启外部 MCP 开关，不重启生产服务，不重启 market-data-tool。
- 不用 QSSE 的 discovery 结果替代行情数据证据，不开始 MG 真实行情复验。

## 下一步

1. 以本记录的临时隧道方式为基础，为镜像建立一次性进程级桥接环境；不要写入长期 `.env`。
2. 使用 T567 同一候选版本做“本地固定证据 vs 生产真实数据”对照，记录数据完整度、首字延迟、工具耗时、失败类别和费用。
3. 已完成一轮 MG 真实数据主线复验，详见 [T569](./T569-mg-production-mcp-replay-20261005.md)：67.09 秒完成，11 次行情工具调用均成功，结果为 `Pass with caveats`；仍需补超时/断开降级验证。
4. 追加一次超时/断开降级验证；结果仍需标注 `Pass with caveats/Partial/Unknown`，不直接改正式策略。
