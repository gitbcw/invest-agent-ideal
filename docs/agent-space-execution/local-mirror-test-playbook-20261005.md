# 本地镜像常态化测试手册

状态：可执行基线（2026-10-07，默认接入生产只读数据 MCP）

这套环境用于 Portal/Agent 的体验走查、工作流验证和历史数据分析。用户状态来自生产快照的本地副本，行情能力直接连接生产只读 MCP；这不等于生产应用端到端可靠性证据。

本地用户工作流测试默认使用这套镜像。自 2026-10-07 起，标准启动脚本自动接入 `market-data-tool` 和 `qsse-qlib`，不再使用本机 `8000/mcp` 占位服务，也不需要每次手工开启 MCP。

## 1. 启动与健康检查

前提：已安装 Node.js 22 和项目依赖，`.state/production-mirror/mirror-manifest.json` 及镜像数据库存在；本机能通过 SSH 非交互登录生产服务器，并能访问两个生产 MCP 端口。可先验证 SSH：

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 claude@118.145.115.197 true
```

在仓库根目录执行（不必在命令行填写 token）：

```bash
node scripts/agent-space/p0/start-local-mirror.mjs
```

保持该进程运行。另开终端执行：

镜像默认模型为 GLM（网关 ID `glm-5.3-flash`），由启动脚本的 `INVEST_AGENT_AUTO_PREFERRED_MODEL` 设置；仍保留健康降级机制。聊天选择“自动”时使用该优先级，显式选择其他模型会覆盖默认值。2026-10-07 用户因单任务费用与结果稳定性，将默认模型从 DeepSeek 切回 GLM。

```bash
npm run mirror:health
```

通过标准：

- `runtime`：`23670/health` 返回 `200` 且 body 为 `status=ok`；
- `portal`：`3120/chat` 返回 `2xx/3xx`；
- `relay`：`3220` 可连接；
- 浏览器入口：`http://127.0.0.1:3120/chat`。

停止：在启动终端按 `Ctrl-C`。不要用 `killall node`，避免影响其他本地服务。

## 2. 用户与数据边界

镜像用户来自 `.state/production-mirror/mirror-manifest.json`，当前包括 `mirror-111`、`mirror-dyk`、`mirror-mg`、`mirror-mgreplay`、`mirror-primary`。登录密码为 `User@2026`。

切换用户：退出当前账号后，用目标 `mirror-<userId>` 登录；每次记录用户、会话 URL 和测试目的。镜像数据库、Workspace 和运行时目录均位于 `.state/production-mirror/`。

当前启动脚本设置 `INVEST_AGENT_OFFLINE_MODE=false`，允许本地 scheduler 运行；`WEIXIN_AUTO_START=false` 和 `PLATFORM_WEIXIN_AUTO_START=false` 关闭微信自动恢复/监听。不能再将此环境描述为“scheduler/push worker 全部关闭的 OFFLINE 环境”；微信自动恢复关闭也不等于所有投递路径被强制隔离。

生产仅提供两个只读数据 MCP，数据库、资产保存和自动化任务仍使用本地镜像。不要复制完整生产 `.env`、真实 Workspace 或微信登录状态；两个 MCP 的凭据由启动脚本按白名单读取，仅放入本地 runtime 子进程环境，不写入文件或日志。

## 3. 固定测试顺序

每次测试按以下顺序推进，先完成一条再进入下一条：

1. **入口与交互走查**：登录、切换用户、创建会话、查看历史、设置/通知、文件预览。
2. **MG 正常工作流**：以“收盘复盘 → 次日预案”为主线，记录数据来源、耗时、结论可执行性和人工决策负担。
3. **特殊工作流**：数据不足、MCP 超时、工具失败、重复追问、长时间无结果。
4. **输出体验**：判断默认回答是否简洁但不写死条数；不强迫用户理解模型、工具或内部处理过程。
5. **回测/历史数据**：优先调用已挂载的生产 MCP 获取真实历史数据；使用夹具时明确标记。分别记录工具可用、日期覆盖和分析结论，不以成功连接代替完整数据覆盖。

## 4. 每次测试的最小记录

在 `docs/agent-space-execution/` 新建或更新一份记录，至少包含：

```text
日期与环境：
用户：
入口 URL / conversationId：
工作流目标：
输入与夹具：
观察到的结果：
耗时：
工具调用与失败：
模型 / fallback：
人工结论：Pass / Pass with caveats / Partial / Fail / Unknown
问题登记：
是否需要生产验证：
```

证据分层必须保留：镜像能证明的交互和隔离行为、需要生产 MCP 才能证明的数据链路、需要人工确认的产品体验，分别记录，不用一个“通过”覆盖三类事实。

## 5. 进入生产前的门槛

- 镜像工作流记录没有未解释的 `Fail`；`Partial/Unknown` 已登记并标出影响；
- 生产 MCP 默认通过标准启动脚本接入，保持只读，凭据不写入仓库或长期 `.env`；
- 生产验证单独建立记录，包含时间窗口、用户范围、调用费用/失败数和回滚方式；
- 本地镜像通过不等于生产发布授权，也不等于真实微信送达成功。

## 6. 生产 MCP 默认接入与验收

启动脚本调用 `scripts/agent-space/p0/production-mcp-env.mjs`，通过 SSH 读取 `/home/claude/invest-agent-mastra/.env` 中两个 MCP 的 URL/token。只转换 URL 中的服务器回环地址为生产主机地址，保留端口和路径，并显式启用两个 MCP。2026-10-07 核验端点：

| MCP | 端点 | 已核验能力 |
| --- | --- | --- |
| market-data-tool | `http://118.145.115.197:22640/mcp` | 38 个工具，含 `get_hist_kline`、`get_chips_history`、`get_fund_flow` 及批量接口 |
| qsse-qlib | `http://118.145.115.197:22648/mcp` | 4 个工具：能力查询、表达式校验、筛选、回测 |

`npm run mirror:health` 仅验证 runtime/Portal/relay，不能证明 MCP 已挂载。需要核验数据能力时，在仓库根目录执行以下工具发现检查（不打印凭据）：

```bash
node --import tsx --input-type=module <<'JS'
import { productionMcpEnv } from './scripts/agent-space/p0/production-mcp-env.mjs';
Object.assign(process.env, productionMcpEnv());
const imported = await import('./src/mastra/external-mcp.ts');
const mcp = imported.default ?? imported;
try {
  const { toolsets } = await mcp.resolveExternalMastraToolsets('interactive');
  for (const server of ['market-data-tool', 'qsse-qlib']) {
    const names = Object.keys(toolsets[server] ?? {});
    console.log(server, names.length, names);
    if (!names.length) process.exitCode = 1;
  }
} finally {
  mcp.__resetExternalMcpConnectionsForTest();
}
JS
```

再用 Portal 新会话要求查询单只股票的指定区间筹码历史和主力资金流，检查实际外部 MCP 调用记录、返回日期、来源与缺口；不能用网页搜索替代 MCP 验收。2026-10-07 已实调 ST太重（600169）2026-09-16 至 09-30，两项工具均返回 9 行记录；QSSE `quant_capabilities` 返回 `chip_conc90`、`main_net_inflow`，数据截至 09-30。该样本证明取数成功，不证明所有标的及交易日全覆盖。

排障：SSH/配置读取失败或凭据缺失时，启动脚本直接报错；配置读取成功但 HTTP MCP 连接失败时，现有 runtime 仍可能降级为空工具集。因此 Portal 能打开不代表数据测试环境合格。先查 SSH、端口可达性和 discovery，不要将故障解释为数据源不提供筹码/资金。凭据或生产端点变更后重启镜像即可重新读取，不手工粘贴 token。独立定时只读路径的 QSSE 可用性仍受 `sessionKinds` 限制（QSSE 当前仅声明 `interactive`），定时任务须另验实际挂载。

## 7. 当前已知缺口

本手册固化的是运行闭环，不宣称产品问题已经全部解决。当前仍需在工作流记录中持续跟踪：复盘长时间无结果、数据不足时的降级表达、观察对象与提醒规则覆盖错位、策略版本迭代/确认/回滚，以及真实数据链路下的 MG 主线验收。

费用说明：2026-10-05 的高费用来自豆包模型在工具失败后的重复调用链。豆包已被临时禁用并保留历史计价信息；该事件已处置，不应成为本地镜像测试的常态化阻碍。
