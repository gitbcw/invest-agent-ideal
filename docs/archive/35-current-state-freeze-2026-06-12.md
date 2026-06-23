# 35 — 当前工程状态冻结记录（2026-06-12）

本文记录 2026-06-12 对当前工作区的工程状态、验收结果、风险和建议提交分组。目的是在进入提交整理和下一轮真实验收前，先形成一个可审计的状态锚点。

## 当前结论

项目已经从单一投资助手 MVP 演进为多 AI Project 运行平台的早期可用形态。投资助手仍是第一个 project type 和主验证样板；平台侧已经具备 Project Type Manifest、Project Registry、Tool Registry、sandbox token、审计、pending confirmation、Platform Dashboard、Codex ACP 主链路、Hermes 可选后端链路和多 skill bundle 的地基。

补充收敛结论：本文是 2026-06-12 当时的状态冻结记录；后续架构收敛以 `docs/38-runtime-skill-evolution-strategy.md`、`docs/39-invest-agent-ui-workbench-strategy.md` 和 `docs/40-engineering-convergence-plan.md` 为准。Profile 只作为运行时兼容摘要，投资方法论由 Strategy Skill 骨架和实例展开候选承载。

当前 TypeScript 编译和核心 smoke 均通过，但工作区存在大量未提交改动。后续优先级应是先完成工程冻结、提交分组和真实链路验收，再继续扩展功能。

## 已验证项目

| 验收项 | 命令/方式 | 结果 | 备注 |
| --- | --- | --- | --- |
| TypeScript 编译 | `npm run build` | 通过 | 无类型错误 |
| 通用 smoke | `npm run smoke` | 通过 | `Experimental MVP smoke test passed` |
| 客户输出边界 | `npm run smoke:customer-output` | 通过 | `ok=true, cases=4` |
| Hermes 可选后端 smoke | `npm run smoke:hermes-service` | 通过 | `status=ok`, `codexReady=true`, `hermesReady=true` |
| sandbox token | `node scripts/sandbox-token-smoke.mjs` | 通过 | token 生成/验证正常；本地未设置固定 secret 时会使用临时密钥 |
| Platform projects API | `GET http://localhost:22649/api/platform/projects` | 通过 | 返回 5 个项目实例 |
| Platform tools API | `GET http://localhost:22649/api/platform/tools` | 通过 | 返回 tool registry 列表 |

## 当前已观察到的运行状态

- Codex ACP 主链路和 Hermes 可选后端服务健康，`22649` 返回 `status=ok`。
- Platform 项目列表当前包含：主用户投资助手、JR 方法参考实验实例、JR 方法参考实验实例 2、明光投资助手、饮食推荐共享实例。
- Tool Registry 已包含投资看板、持仓、自选、预案、运行时 profile 兼容读取、复盘、提醒、微信推送等 tool id。
- 客户输出清洗已有自动 smoke，能拦截内部端口、路径、API、token 和调试词泄露。
- push queue 存在历史 `dead` 任务：服务 health 摘要中 `dead=19`，需要单独作为运维清理项处理。

## 工作区风险

当前 `git status` 显示大量修改、删除和未跟踪文件，范围包括：

- `.codex/skills` 新增投资/饮食推荐 skills。
- `src/acp` 新增 Codex/Hermes stdio、prompt、trace 等主链路文件。
- `src/platform` 新增 project registry、project types、skill bundles、tool registry。
- `src/routes/sandbox.ts`、`src/routes/platform.ts` 新增 sandbox 和 platform API。
- `src/lib` 新增 sandbox、审计、确认、用户身份、客户输出清洗、profile context 等基础设施。
- 多个 handler、scheduler、dashboard、weixin channel、db schema/index 均有大幅修改。
- 旧 `src/agent/*` 和 `src/router/*` 显示为删除，符合“删除旧 Runtime 主链路”的方向。
- 多份旧文档从 `docs/` 移入 `docs/archive/`，并新增平台化与 JR 方法参考系列文档。

这意味着当前状态虽然能编译并通过 smoke，但还不适合继续堆功能。应优先拆分提交和做独立 review。

## 建议提交分组

建议按以下顺序整理提交，避免一个巨型提交承载全部平台化变化。

1. 文档与项目上下文冻结
   - `AGENTS.md`
   - `CLAUDE.md`
   - `docs/README.md`
   - `docs/15-next-phase-roadmap.md`
   - `docs/16-*`、`17-*`、`18-*`、`23-*`、`24-*`、`25-*`、`26-*`、`28-*`、`29-*`、`34-*`
   - 旧文档移动到 `docs/archive/`

2. skills 迁移与方法论资产
   - `.codex/skills/invest-agent-*`
   - `.codex/skills/diet-recommendation-assistant`
   - 与 skill bundle 对应的说明和约束

3. ACP 主链路与客户输出边界
   - `src/acp/*`
   - `src/lib/customer-output.ts`
   - `src/lib/errors.ts`
   - `scripts/customer-output-smoke.mjs`
   - 旧 runtime/router 删除

4. sandbox、权限和审计地基
   - `src/lib/sandbox-*`
   - `src/routes/sandbox.ts`
   - `src/platform/tool-registry.ts`
   - `scripts/sandbox-token-smoke.mjs`

5. AI Project 平台化地基
   - `src/platform/project-types.ts`
   - `src/platform/project-registry.ts`
   - `src/platform/skill-bundles.ts`
   - `src/routes/platform.ts`
   - `src/admin/platform-page.ts`

6. 微信/backend adapter 与推送队列
   - `src/acp/hermes-stdio-agent.ts`
   - `src/channels/weixin-mobile.ts`
   - `src/services/push-queue.ts`
   - `scripts/hermes-service-smoke.mjs`
   - `scripts/start-hermes-service.sh`
   - `scripts/launchd/*`

7. 投资业务 handler 和复盘闭环
   - `src/handlers/*`
   - `src/scheduler/*`
   - `src/services/stock-news.ts`
   - `src/services/stock*.ts`
   - `src/routes/dashboard.ts`
   - `src/admin/dashboard-page.ts`

8. 数据库 schema 与迁移兼容
   - `src/db/schema.ts`
   - `src/db/index.ts`
   - `.env.example`
   - `package.json` / `package-lock.json` / `ecosystem.config.js`

每组提交后至少运行 `npm run build`；涉及服务链路的提交还应运行对应 smoke。

## 下一轮真实验收建议

主路径按 Codex ACP、sandbox、Strategy Skill 和项目隔离继续补齐以下人工或半自动验收；涉及 Hermes 可选后端时，再按 `docs/28-hermes-project-weixin-acceptance-checklist.md` 补专项回归：

1. 微信真实消息：普通问答不泄露内部词，并能在 `/platform` 看到 trace。
2. 日复盘：微信触发后先回执，再最终推送，且复盘保存可查。
3. 观点追踪：日复盘生成“观点追踪表”，下一轮能回测并更新状态。
4. 选股问答：能区分事实、推断、观察条件和风险。
5. 转自选/设预案/设提醒：写操作走 sandbox、审计和必要确认。
6. 非投资项目调用投资工具：返回 tool not allowed。
7. push queue：清理或复核历史 dead job，确认重试/失败状态在平台可见。

## 建议下一步

先不要继续扩展新业务功能。建议先完成：

1. 按上面的提交分组整理并逐组 review。
2. 修复或确认提交整理过程中暴露的 scope/权限问题。
3. 跑完 28 号验收清单的真实微信链路。
4. 再回到 D4-5、D4-6、D4-10：继续提升日复盘、选股问答和 JR 方法参考层的输出质量。
