# T-235 pdf/excel/word 文件处理能力支持 — 调研报告 + 方案

- 任务：T-235（pdf、excel、word 等文件处理能力支持）
- 项目：P-17 投研助手
- 日期：2026-08-01
- 状态：**已实施——service-tools 内置 file.parse 工具，直连 MinerU REST API**（2026-08-01）。
  路径演进：最初选 MinerU 托管 MCP → 实测 mcp.mineru.net token scope 不通 + 托管 MCP 只支持 URL 不支持本地文件 → 改为 service-tools 内置工具直连 REST API（最轻量，你的 token 直接用，读本地附件，零额外部署）。数据上云已确认接受。Excel/CSV 白名单已放开，微信端暂不动。
- 联动：本任务的挂载实施同时作为 T-243 Phase 3 的"真实工具验证"样本
- worktree：`invest-agent-ideal-mcp-mount` / 分支 `feat/mcp-mount-standardization`

## 1. 任务契约回顾

本质：上传文件（pdf/excel/word/csv/txt）解析现成化，替代 AI 现场写代码。

路径：调研优先 → 有可用方案则选定挂载接入验证；无可用方案则产出立项建议（另行立项）。

验收：挂载后真实样本直接调用现成工具解析正确进对话；或无方案时立项建议经用户确认后关闭。

挂载实施走 T-243 标准化新机制（声明式 activateIf + mcp:check 门禁）。

## 2. 现状摘要（基于本仓库 2026-08-01 实测）

### 文件解析能力 = 零

- `package.json` 依赖里**没有任何**文档解析库（pdf-parse、xlsx、exceljs、mammoth、docx 全无）。
- workspace 模板的 `requirements.txt` 只有 `PyYAML>=6.0`，**没有** pandas/openpyxl/pdfplumber。
- 服务侧 MCP 工具集（~28 个）**没有任何** attachment.read / file.parse 类工具。

### "AI 读文档"的现状 = 靠提示词让 AI 现场写代码，但环境没解析库

附件不会被解析成文本进 prompt，只是给 AI 一个**本地绝对路径**文字提示（`src/acp/agent.ts:194-197`）：

```
【附件上下文】用户随消息发送了附件，附件已保存到当前 workspace 的受控目录。
文档附件：PDF/doc/docx/ppt/pptx/html/md/txt 可以作为本地文件读取；请先概括内容...
```

ACP 后端（Codex）运行在 `workspace-write` + `network_access=true` 沙箱，理论上能现场 `pip install pdfplumber` 解析——但**不可靠、慢、无审计、表格质量随机**。这正是 T-235 要消除的痛点。

### 上传链路的两个缺口

| 缺口 | 位置 | 现状 |
|---|---|---|
| Excel/CSV 不在白名单 | `attachment-store.ts:22-31` | `ALLOWED_DOCUMENT_MIME` 只有 pdf/doc/docx/ppt/html/md/txt，**无 xlsx/xls/csv** |
| 微信端拒收文档 | `attachment-store.ts:105` | 硬编码 `if (type !== "image") throw`，微信连 pdf 都传不进来 |

> Web/Portal 通道已支持 pdf/doc/docx/ppt/html/md/txt 上传（`POST /api/portal/conversations/:id/messages`），Excel/CSV 补白名单即可。

### sandbox 是两回事，都不能用于文件解析

- isolated-vm（跑指标脚本）：`sandbox-runtime.ts:10` 注释"不能 import fs/process"，**读不了文件**。
- `/api/sandbox/*`（业务权限沙箱）：只是 HTTP 鉴权层，**无文件解析端点**。

## 3. 外部方案调研结论

### 首选：Docling（docling-mcp + docling-serve）

| 维度 | Docling |
|---|---|
| 来源 | IBM 官方 / LF AI&Data，MIT 协议，701★，活跃（2026-07-31 push） |
| 格式覆盖 | **PDF/DOCX/PPTX/XLSX/HTML/CSV/TXT/图片/邮件/XBRL 财报** |
| transport | **原生支持 stdio / sse / streamable-http 三种**（源码 `TransportType` 枚举，已核实） |
| HTTP 启动 | `uvx --from docling-mcp docling-mcp-server --transport streamable-http` |
| 鉴权 | `DOCLING_MCP_SERVICE_API_KEY` env（与我们的 Bearer token header 模式兼容） |
| 数据出境 | **否（自托管，local/remote 模式均可数据不出境）** |
| 部署 | Docker 一键：`docling-serve` 容器 + `docling-mcp` 作 MCP 适配层（remote 模式） |
| 解析质量 | 专门 table structure + 扫描件 OCR（tesserocr/rapidocr）+ 图表理解 |
| 成本 | 免费（自建算力） |

**为何是首选**：同时满足全部硬约束——数据不出境（投资文件敏感）、HTTP MCP 原生支持（与 market-data-tool 同构）、格式全覆盖（含 XBRL 财报，投资场景加分）、表格+OCR 质量高、开源免费。接入工作量极小：照搬 `buildMarketDataToolRegistration()` 写 `buildDoclingRegistration()`。

### 备选（均不如 Docling，不推荐作主方案）

| 方案 | 不推荐原因 |
|---|---|
| LlamaParse MCP | 数据强制上云；OAuth 鉴权（非 Bearer），与现有 header token 模式不兼容 |
| Unstructured MCP | 数据强制上云；开源版依赖重（libmagic/poppler/tesseract/libreoffice） |
| Citra (pdf-reader-mcp) | 仅覆盖 PDF；可作为未来 PDF 财报表格"可溯源引用"的专项增强补充 |
| 自建 npm 版（pdf-parse+xlsx+mammoth） | 要自己拼多个库 + 系统依赖；pdf-parse 无表格解析；等于重新造 Docling 的轮子 |

**结论：不需要"自建 MCP 立项"**——Docling 已把 MCP 和解析引擎都做好，只需"部署 + 注册接入"，工作量在小时级。

## 4. 推荐方案：Docling 自建 HTTP MCP 接入

### 部署架构（与 market-data-tool 同构）

```
invest-agent 服务
  └─ external-mcp-registrations.ts 新增 buildDoclingRegistration()
       └─ transport: http → docling-mcp-server (streamable-http)
            └─ remote 模式 → docling-serve 容器（解析引擎）
```

推荐 **remote 模式**（docling-serve 独立容器 + docling-mcp 作 MCP 适配）：便于扩缩容、资源隔离（投资 PDF 可能是大文件+扫描件，解析吃 CPU/内存）。

### 代码改造点（4 处，全部复用 T-243 新机制）

| # | 文件 | 改造 | 复用 T-243 |
|---|---|---|---|
| 1 | `external-mcp-registrations.ts` | 新增 `buildDoclingRegistration()`（声明式 activateIf） | ✅ Phase 1 新机制 |
| 2 | `attachment-store.ts` | `ALLOWED_DOCUMENT_MIME` 加 xlsx/xls/csv | — |
| 3 | `agent.ts:194-197` | 提示词改"调用 docling 工具解析附件，不要自己写解析代码" | — |
| 4 | `.env.example` | 加 `DOCLING_MCP_URL` / `DOCLING_MCP_TOKEN` / `INVEST_AGENT_MCP_DOCLING_ENABLED` | ✅ 标准化 |

接入后跑 `npm run mcp:check` 验证注册项契约（T-243 Phase 2 门禁）。

### 验收路径

1. 部署 docling-mcp + docling-serve（Docker，需你在服务器操作）
2. 注册项接入（代码改造，我做）+ `npm run mcp:check` 通过
3. 真实样本验证：上传 pdf/excel/word → AI 调用 docling 工具解析 → 内容正确进对话

> 第 1 步（部署）需要你的服务器环境 + Docker。第 2-3 步我在代码侧完成。若部署暂不可行，可先完成代码接入 + mcp:check 门禁通过，部署验证留到你环境就绪。

## 5. 待用户确认

请确认：
1. **方案选定**：Docling 自建 HTTP MCP（推荐），还是其他？
2. **部署安排**：docling-mcp + docling-serve 的 Docker 部署，现在做还是先完成代码接入、部署后置？
3. **Excel/CSV 白名单 + 微信端文档**：是否一并放开（Excel/CSV 加白名单是必须的；微信端放开文档可选）？

选定后我进入实施：代码改造（复用 T-243 新机制）→ mcp:check 门禁 → 真实样本验证（同时完成 T-243 Phase 3 验收）。
