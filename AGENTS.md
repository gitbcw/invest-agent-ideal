# Invest Agent 开发 Agent 入口

Invest Agent 是一个网页端（Portal）优先的投资决策助手，微信作为推送渠道与轻量沟通渠道。本文件只保留开发 Agent 必须始终遵守的项目红线；当前文档索引见 [docs/README.md](docs/README.md)，需要项目事实或领域契约时再按索引查找。

## 全局红线

- 不得未经用户明确授权替换、删除或迁移生产 `.env`、SQLite、真实 Workspace、`reviews/`、`.state/` 或微信状态；普通发布只能同步代码、模板和构建输入。
- 真实 Workspace 的 `AGENTS.md`、Skills、方法、配置和产物属于用户实例。模板差异只能报告；采用具体模板资产必须逐用户、逐文件确认并先备份。
- 访问控制、scope、确认、审计、调度和推送等安全保证必须由服务/MCP 层强制，不能把 Skill 或文档文本当作安全边界。
- `main` 是唯一维护与生产发布基线。快照、冻结标签和历史收敛分支仅用于审计、比较和回滚；生产紧急修复也必须回写 `main`。
- 正式 Portal 的唯一本地仓库是 `/Users/combo/MyFile/projects/invest-agent-portal`，生产目标是 `/home/claude/invest-agent-portal`。`test-projects/` 下的任何项目均不得作为 Portal 实现、验收证据或生产发布源；操作 Portal 前必须先核对该仓库根目录和 `package.json` 项目身份。
- `docs/archive/` 仅用于考古，除非当前权威文档明确引用。不得根据历史方案推翻当前契约。
- 保留用户已有工作树改动；不得用 reset、checkout、批量覆盖或无关重构清除它们。

命令以 `package.json` 为准；当前运行时职责以 [docs/system-overview.md](docs/system-overview.md) 为准；可重复的工程与运维流程以项目 `.codex/skills/` 为准。
