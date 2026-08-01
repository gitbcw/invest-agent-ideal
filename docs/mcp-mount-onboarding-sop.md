# MCP Server 标准化接入 SOP（T-243 交付物）

- 任务：T-243（投研助手 MCP/Skills 挂载管理能力标准化）
- 项目：P-17 投研助手
- 日期：2026-08-01
- 状态：**首版**（基于 T-243 方案 B Phase 1-2 机制 + T-235 MinerU 首个真实接入样本）
- worktree：`invest-agent-ideal-mcp-mount` / 分支 `feat/mcp-mount-standardization`

## 适用范围

接入一个新的外部 MCP server（HTTP 或 stdio）到投研助手 ACP 会话。本文是 T-243「统一注册与配置 + 启停管理 + 运行状态可见 + 接入质量门禁」四项能力的操作手册。

> 内部 service-tools 工具（portfolio/watchlist 等）的接入不走本流程，仍在 `src/mcp/invest-agent-service-tools.ts` 硬编码（T-243 方案 C 未采纳，不在首版范围）。

## 四项能力速查

| 能力 | 机制 | 位置 |
|---|---|---|
| ① 统一注册 | 声明式 `activateIf` 规则，无需改 switch-case | `src/acp/external-mcp-registrations.ts` |
| ② 启停管理 | env 基线 + DB 覆盖（`mcp_server_overrides`）+ API + UI 按钮 | `src/services/mcp-control-plane.ts`、Platform UI |
| ③ 运行状态可见 | observer 采集 + 聚合 read API + Platform UI 视图 | `src/services/external-mcp-observer.ts`、`GET /api/platform/mcp-tools/status` |
| ④ 接入质量门禁 | 离线 contract 校验 `npm run mcp:check` | `scripts/mcp-registry-check.ts` |

## 接入步骤（4 步，约 30 分钟）

以 T-235 MinerU 文档解析 MCP 为首个样本示范。

### 步骤 1：声明注册项（能力①）

在 `src/acp/external-mcp-registrations.ts` 新增一个 builder，并加入 `buildExternalRegistrations()` 返回数组。

**关键：声明 `activateIf` 规则，不要在任何 switch-case 里加分支（switch-case 已在 T-243 删除）。**

```ts
// 样本：buildMineruRegistration (T-235)
export function buildMineruRegistration(): McpServerRegistration {
  return {
    id: "mineru",                          // 全局唯一，与 tools/list 的 server 标识对应
    owner: "external",
    enabled: false,                         // 默认关闭，零行为回归
    trustClass: "external-readonly",        // 外部工具一律 external-readonly
    transport: {
      kind: "http",
      url: "<env:MINERU_MCP_URL>",          // <env:NAME> 模板，纯字符串替换，绝不调 shell
      headers: [{ name: "Authorization", envRef: "MINERU_API_TOKEN", prefix: "Bearer " }],
      requiredEnvRefs: ["MINERU_MCP_URL", "MINERU_API_TOKEN"],  // 缺任一 fail-closed
    },
    versionPolicy: { expected: "1.0.0", allowedRange: "^1" },
    sessionKinds: ["interactive"],          // 按场景：interactive/scheduled-read/evaluation
    activateIf: {                           // 声明式激活（T-243 核心机制）
      kind: "env-any-of",
      refs: ["INVEST_AGENT_MCP_MINERU_ENABLED"],  // 精确匹配 "true" 才激活
    },
  };
}
```

加入返回数组：
```ts
export function buildExternalRegistrations(): McpServerRegistration[] {
  return [buildMarketDataToolRegistration(), buildQsseQlibRegistration(), buildMineruRegistration()];
}
```

### 步骤 2：配置 env（能力① 配套）

在 `.env.example` 加配置段（生产 `.env` 由 operator 填，不得自动覆盖）：

```bash
# MinerU 文档解析 MCP (T-235)
INVEST_AGENT_MCP_MINERU_ENABLED=false       # 激活开关，默认关闭
MINERU_MCP_URL=https://mcp.mineru.net/mcp   # MCP 端点
MINERU_API_TOKEN=                            # Bearer token
```

### 步骤 3：跑接入门禁（能力④）

```bash
npm run mcp:check
```

离线校验注册项契约（不依赖 live endpoint、不需要真实 token）。新增一个 server 会自动多 4 项检查：
- `validateRegistration: <id>`（id 格式 / trustClass 一致性 / 模板 token / 安全边界）
- `activateIf declared: <id>`（必须声明激活规则，否则永远 fail-closed）
- `activateIf refs non-empty: <id>`
- `no service-scope leak: <id>`（external-readonly 不得引用 service scope env）

全过才能继续。失败则修正注册项声明。

### 步骤 4：（按需）业务侧适配

某些工具需要业务侧配合（不是所有都要）：
- **上传白名单**：若工具消费用户上传文件，在 `src/lib/attachment-store.ts` 的 `ALLOWED_DOCUMENT_MIME` + `EXTENSION_MIME` + magic byte 校验里加格式（T-235 给 Excel/CSV 加了白名单）。
- **提示词**：若需要引导 AI 调用新工具，在 `src/acp/agent.ts` 的提示词里提及工具名（T-235 改了附件提示词引导调 mineru）。

## 验证清单

| 验证项 | 命令 | 期望 |
|---|---|---|
| 类型 | `npm run typecheck` | 无错误 |
| 注册门禁 | `npm run mcp:check` | 全过（新增 server 的 4 项 + 原有项） |
| 单元测试 | `npm test` | 全过（建议为新 server 加契约测试，见下） |
| 安全边界 | `npm run test:boundary` | security-boundary + route-uniqueness 过 |
| 完整 | `npm run verify` | 全绿 |

## 启停管理（能力②）

接入后，server 默认由 env 开关控制（基线）。运行时可动态启停，**无需重启**：

- **API**：`POST /api/platform/mcp/servers/:id/enable` 或 `/disable`（body 可带 `reason`）；`DELETE .../override` 清除覆盖回 env 基线。权限 `mcp.manage`（owner 自动拥有，partner 默认无）。
- **UI**：Platform → MCP 工具状态视图，每个 server 有启用/禁用按钮（禁用带理由 prompt）+ 恢复基线按钮。
- **模型**：DB `mcp_server_overrides` 覆盖优先级高于 env 基线；未注册的 server 拒绝覆盖（不能凭空启用未配置的 server）。重启后 env 基线重新生效，DB 覆盖在启动时重新应用。

## 运行状态可见（能力③）

接入并激活后，observer 自动采集该 server 的 `tools/call`（调用量/成功/失败/p95 延迟/最近错误，绝不记 body）：
- **API**：`GET /api/platform/mcp-tools/status?days=7`
- **UI**：Platform → MCP 工具状态视图 → 工具调用统计表

## 给新 server 加契约测试（建议）

在 `tests/acp-mcp-external.test.ts` 照搬 qsse/mineru 的测试模式，覆盖：
1. 注册项字段契约（id/owner/trustClass/sessionKinds/activateIf/transport）
2. HTTP 解析不泄露 token
3. 激活开关大小写敏感 + 默认关闭
4. 不进入非声明 sessionKind

## 安全边界（红线）

- external-readonly server **永远不得**引用 service scope env（`DB_PATH`/`WORKSPACE_ROOT`/`INVEST_AGENT_SANDBOX_SECRET` 等），由 `validateRegistration` + `resolveExternalHttpServer` 双重 fail-closed 保证。
- token 只进入 ACP 会话 / 子进程，**绝不**进入 manifest 摘要、trace 或日志。
- stdio server 的 `<env:NAME>` 模板是纯字符串替换，**绝不**调用 shell。

## 首个真实接入样本：T-235 MinerU

MinerU（文档解析 MCP）是 T-243 新机制的首个真实接入样本，验证了：
- 声明式 `activateIf` 注册，**零 switch-case 改动**（T-243 Phase 1 核心契约成立）
- `mcp:check` 门禁自动覆盖新 server（18/18 全过）
- 安全边界未被破坏（external-readonly + Bearer token + 数据上云权衡已确认）

部署后置——待 operator 在生产 `.env` 配置 `MINERU_API_TOKEN` 并开启 `INVEST_AGENT_MCP_MINERU_ENABLED=true` 后，即可端到端验证真实样本解析。

## 后续演进（T-243 Phase 3+ 待办）

- OTel GenAI semconv emit（observer 对齐 `mcp.*` + `gen_ai.tool.*` 属性，接 Langfuse 或自研 dashboard）
- 接入后健康基线告警（失败率超阈值告警，接 observer 数据）
- catalog digest 漂移检测（跨 release 比对工具集哈希，预警同名/静默 schema 变更）
