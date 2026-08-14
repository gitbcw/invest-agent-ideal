# Mastra Workspace 承接工作包验收审查

审查日期：2026-08-13
审查依据：[mastra-workspace-exit-mapping.md](./mastra-workspace-exit-mapping.md)、[mastra-long-work-package.md](./mastra-long-work-package.md)
审查范围：迁移分支 `feat/mastra-migration` 的 WP0-WP7 技术交付与本地候选；不包含用户 H1 体验判断、生产发布或真实微信切换。

## Acceptance Verdict

**Status: Partial / H1 pending**

WP0-WP7 的可自动验证部分有直接代码、测试、构建和隔离运行证据。Mastra runtime、同仓正式 Portal、Relay、服务-owned target、Workspace scope containment、资产/自动化契约和历史失效入口清理均已完成或通过。工作包不能标记为整体 Pass，因为 H1 要求用户实际确认 Portal 对话速度、文件、自动化、审计观感和业务平替程度；该判断尚未发生。复杂双口径表格请求曾出现 `MASTRA_EMPTY_RESPONSE`，提高服务端步数预算后可成功，但约 162 秒的响应时间仍不可视为体验通过。随后补充的 `spreadsheet.create` 已使 Agent 能以结构化数据生成真实 XLSX；该能力仍需由 Portal 对话实际调用、展示并下载后才能作为 H1 证据。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| WP0 | 基线、构建、回归和隔离边界可追溯 | Pass | `npm test` 445 pass；typecheck/build/diff check；执行记录 `12.50` | 当前工作树保留用户改动，未修改生产源 |
| WP1 | Mastra runtime 不依赖旧 Workspace runtime 状态 | Pass | Workspace registry/manifest/containment 测试；Mastra 默认 backend；主路径静态审计 | 用户项目资产仍按设计保留，不宣称已物理删除 Workspace |
| WP2 | 核心业务事实进入 service-owned projections | Pass with caveats | strategy、portfolio、runtime preferences、review/memory target 导入和 cold-start 证据 | 正式生产迁移未执行；冲突门仍只适用于正式数据切换 |
| WP3 | Portal 文件/资产/自动化契约可用且 scope 安全 | Pass with caveats | asset/attachment/file tests；Portal 文件页；`workspace.file.*` scope 修复回归 | 旧 workspace file compatibility surface 仍保留为只读兼容，不是当前 UI 必需权威源 |
| WP4 | 正式 Portal 与 runtime 同仓、独立进程/端口 | Pass | `apps/portal` 来源记录；Portal 43/43、typecheck/build；runtime 23656、Portal 23657、Relay 23658 | 尚未把 runtime 目录移动到 `apps/runtime`，当前等价同仓形态已可独立启动 |
| WP5 | 备份快照副本可重复导入临时 target | Pass with caveats | 分域 mapping/import、target cold-start、target write smoke、幂等和源隔离记录 | 仅使用备份副本；没有生产 DB/Workspace/微信写入 |
| WP6 | 失效 ACP/Codex 入口不再暴露为当前运行命令 | Pass with caveats | package/scripts 清理；convergence scan 通过 | 历史 DB 字段、迁移/备份/回滚证据仍保留，最终物理归档窗口未决 |
| WP7 | 本地候选可启动并覆盖核心技术链路 | Pass with caveats | health、登录、conversation、文件、automation、trace、模型回合；`agent_traces` 为 Mastra success | 复杂回合约 162 秒；`spreadsheet.create` 的 Portal 实测仍 pending；真实微信/push 保持关闭 |
| H1 | 用户确认 Portal 实际体验达到平替预期 | Unknown | 尚无用户体验结论 | 必须由用户访问 `http://127.0.0.1:23657/login` 后确认 |

## Findings

- **[P1] H1 未验收**：Portal 的实际业务等价、对话速度和审计观感不能由自动化完全代替；当前工作包应停在 H1。
- **[P2] 候选模型响应偏慢**：复杂表格请求已成功回合耗时约 162 秒。它证明链路可用，但不证明用户可接受的交互性能。
- **[P2] Excel 工具链待 Portal 实测**：`spreadsheet.create` 已在 service/Mastra tool registry 中生成和校验真实 XLSX，但还没有由 Portal 的 Agent 对话成功调用并完成文件可见性/下载确认。
- **[P2] 发布边界未执行**：真实微信、push、生产数据迁移、部署包和新服务器端口均按计划未执行，不应在 H1 前推进。

## Verification Performed

- `npm test`：445 tests passed, 0 failed/cancelled/skipped。
- `npm run typecheck`、`npm run build`、`npm run portal:typecheck`、`npm run portal:build`：通过。
- `npm run portal:test`：43/43 通过。
- `npm run scan:convergence`：3 项责任检查通过。
- `git diff --check`：通过。
- 隔离运行：`GET 23656/health`、`GET 23657/api/health` 均 200；23655/23656/23657/23658 监听关系符合隔离拓扑。
- 隔离 trace：`agent_backend=mastra`、`agent_model=gpt-5.6-terra`、`status=success`。

## Follow-Up Checklist

- [ ] 用户访问 Portal 并确认 H1 体验。
- [ ] H1 通过后，再单独决定真实微信/push 恢复、历史兼容物理归档和 R1 发布授权。
- [ ] 在 R1 授权前不制作部署包、不连接新服务器、不切换端口、不写生产数据。
