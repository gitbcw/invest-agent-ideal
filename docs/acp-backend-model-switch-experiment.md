# ACP 后端模型切换实验：DeepSeek-V4-Flash 接入

> **状态**：实验验证完成（2026-07-31），配置方式已沉淀，可作为切换任意 codex-compatible 模型的范本。
> **分支**：`exp/model-switch`（实验环境，配置不入库；本文档为可复现经验）。
> **关联**：[system-overview.md](./system-overview.md)、[service-tools-mcp.md](./service-tools-mcp.md)、[external-mcp-registry-generalization-plan.md](./external-mcp-registry-generalization-plan.md)

## 1. 实验目标

验证将 ACP（Agent Client Protocol）底层模型从默认 codex-ai 网关切换到 DeepSeek-V4-Flash 后，整套投资助手链路（service-tools MCP、外部只读 MCP、onboarding、安全边界）仍能正常工作。

## 2. 关键机制：ACP 底层模型由谁决定

**这是最容易误解的一点，必须先讲清楚。**

ACP 底层模型**不是由项目的 `.env` 里的 `LLM_PROVIDER` / `DEEPSEEK_*` 决定的**。那套配置（`src/services/deepseek.ts`）只服务复盘 handler 的 `safeAi()`，与 ACP 聊天主链路无关。

真正的决定链路是：

```
项目 src/acp/stdio-agent.ts
  └─ getCurrentAcpAgent() 按 backend id（codex/hermes）spawn 子进程
  └─ buildCodexRuntimeEnv(): CODEX_HOME = <workspace>/.codex
  └─ ensureCodexHome(): 把 CODEX_SOURCE_HOME 的 config.toml symlink 到 <workspace>/.codex/
  └─ codex 子进程读 config.toml 的 model + model_provider → 这才是真正的底层模型
```

核心环境变量（`src/lib/config.ts`）：

- `CODEX_SOURCE_HOME`：codex 配置的**源目录**，会被 symlink 到每个 workspace 的 `.codex/`。默认 `~/.codex`（生产）。
- `CODEX_MODEL` / `CODEX_COMPLEX_MODEL`：模型名，经 `-c model="..."` 注入 codex 启动参数。

**结论**：切换 ACP 底层模型 = 给 codex 子进程提供一份指向新模型的 `config.toml`。最小侵入的方式是用独立的 `CODEX_SOURCE_HOME`，不动生产 `~/.codex`。

> ⚠️ `.env.example` 里的 `ACP_MODEL_ROUTER_ENABLED` / `ACP_SIMPLE_MODEL_ENABLED` / `CODEX_SIMPLE_MODEL` 是**死配置**——代码完全不读，别指望用它们切换。

## 3. 接入步骤（可复现）

### 3.1 准备独立 codex home（隔离生产）

```bash
EXP_HOME="<worktree>/.codex-deepseek-exp"   # 或任何独立路径
mkdir -p "$EXP_HOME"
```

该目录必须在本地忽略（含 token，绝不能入库）。

### 3.2 写 config.toml（按 DeepSeek 官方 Codex 集成文档）

官方文档：<https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex>

```toml
preferred_auth_method = "apikey"
forced_login_method = "api"

model = "deepseek-v4-flash"
model_provider = "deepseek"
model_reasoning_effort = "medium"

[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com/"
wire_api = "responses"
experimental_bearer_token = "<DEEPSEEK_API_KEY>"   # sk- 开头，不入库
```

**要点（踩坑记录）：**
- `wire_api = "responses"`，不是 `chat`。DeepSeek 官方 Codex 集成走 Responses API，与 codex 协议契合，**无需协议适配**。
- `base_url` 末尾带 `/`（`https://api.deepseek.com/`）。
- 认证三件套缺一不可：`preferred_auth_method = "apikey"` + `forced_login_method = "api"` + `experimental_bearer_token`，否则 codex 会要求 ChatGPT 登录流程。
- token 走 `experimental_bearer_token` 字段（写在 config.toml），**不走 `auth.json`**——这是 codex 对自定义 provider 的机制，与 codex 原生 auth.json 不同。

### 3.3 配置 worktree 本地 .env（gitignored）

```bash
ACP_BACKEND=codex
CODEX_SOURCE_HOME=<worktree 绝对路径>/.codex-deepseek-exp
CODEX_MODEL=deepseek-v4-flash
CODEX_ACP_CWD=<worktree 绝对路径>
CODEX_ACP_COMMAND=/Users/combo/.local/bin/codex-acp
```

`.env` 已被 `.gitignore` 忽略，仅本地生效。

### 3.4 验证链路

```bash
# 1. 直接验证 token + 模型
curl -sS https://api.deepseek.com/chat/completions \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"PONG"}],"max_tokens":20}'

# 2. codex 用独立 home 自检
CODEX_HOME=<EXP_HOME> codex doctor   # 看 default model provider / reachable

# 3. codex 真实调用
CODEX_HOME=<EXP_HOME> codex exec --skip-git-repo-check --sandbox read-only "reply PONG"
```

## 4. 测试结论（2026-07-31 实验快照，全部 PASSED）

| 场景组 | 内容 | 结果 |
| --- | --- | --- |
| 1. service-tools 基础链路 | DeepSeek + codex-acp + service-tools，真实对话 | ✅ |
| 2. market-data-tool (HTTP) | 合约探针 + ACP 工具调用 + 真实行情/板块 | ✅ |
| 3. qsse-qlib (HTTP) 单元测试 | 注册/激活/隔离/能力门控，38 项 | ✅ |
| 4. onboarding + 安全边界 | 4 个 smoke（含 MCP 子进程环境隔离） | ✅ |
| 5. MCP 注册泛化单元测试 | 冲突探测/隔离/evaluation，33 项 | ✅ |
| 6. qsse-qlib 真实工具调用 | HTTP MCP 端到端 + sentinel 一致（data_as_of=2026-07-31） | ✅ |

实验当日单元测试合计 71/71；真实 ACP 业务场景 6 个全通过；生产 `~/.codex` 零改动。以上数量和结果是实验 worktree 的快照，不代表主分支当前测试计数。

**关键观察：** DeepSeek-V4-Flash 在工具调用场景表现诚实——行情查询时「最新价」字段为 `null`（盘后正常），模型如实报告工具返回值，**未编造价格**。

## 5. 性能基准

| 链路 | 平均延迟 |
| --- | --- |
| DeepSeek API 直连（无 codex） | ~1.0s |
| ACP 纯文本（稳态，去冷启动） | ~6.7s |
| ACP 工具调用（稳态） | ~3.7s |
| 冷启动首轮（spawn codex-acp） | ~9.5s |

**瓶颈分析：**
- DeepSeek 模型本身很快（API 直连 ~1s），延迟大头在 **codex-acp 协议层**（session 管理、MCP 装配、JSON-RPC 往返），不在模型推理。
- `model_reasoning_effort`（disable/low/medium）对延迟**几乎无影响**（API 直连下均 0.1–0.24s），不必为提速调低思考档。
- 提速方向是优化 codex-acp 层，而非换模型或调 DeepSeek 参数。

## 6. 已知问题（非阻断）

1. **codex 缺 `deepseek-v4-flash` 元数据**：`warning: Model metadata not found. Defaulting to fallback metadata; this can degrade performance.` 长上下文场景可能降级。
2. **usage 为估算**：DeepSeek 不返回标准 usage，项目用 `usageSource: "estimated"`。依赖精确 token 计费/统计需适配。

## 7. 复用为通用模型切换范本

本实验的方法可推广到任何 codex-compatible 模型（OpenAI 兼容 / Anthropic 兼容）：

1. 建独立 `CODEX_SOURCE_HOME` 目录（隔离生产）。
2. 写一份指向目标模型的 `config.toml`（参考该模型与 codex 的官方集成文档）。
3. `.env` 设 `CODEX_SOURCE_HOME` + `CODEX_MODEL`。
4. 用 `codex doctor` + `codex exec` 验证，再跑项目探针。

**切记：** 切换是本地运行时配置，不影响仓库代码；若要正式接入生产，需按红线规则逐项确认（生产 `~/.codex`、`.env` 属受保护资产）。

## 8. 合并说明

本实验没有需要合并的运行时代码或配置：
- DeepSeek 配置（`.codex-deepseek-exp/`、`.env`）均为本地实验资产，不入库。
- 本文档是实验的经验沉淀；此次只将本文档合并到主分支。

合并到 main 后，主分支 ACP 底层模型**不变**（仍 codex-ai / gpt-5.6-sol），本文档仅为后续切换提供可复现的配置经验。
