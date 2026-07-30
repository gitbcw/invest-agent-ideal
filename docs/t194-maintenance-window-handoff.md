# T-194 生产备份与代码回退验收交接

## 当前状态

T-194 的阶段 1 和阶段 2 机制已经落地：

- 阶段 1：Mac mini 通过 `launchd` 每日 01:00 从生产只读备份 `111`、`dyk`、`mg` 三个真实 Workspace，并保留最近 3 个成功自然日。
- 阶段 2：`b43402e9e20cba64eb505d8c4d287cd62d6c682a` 包含发布快照、标准代码部署、代码回退、Workspace 只读差异和备份脚本；该提交已在 2026-07-27 发布并接受为 known-good release `20260727T131243Z-b43402e9`。

仍待完成的是一次完整的生产演示：从一个新的、纯文档或等价低风险版本部署，再回退到该 known-good 版本，生成 Workspace 只读差异，最后恢复最新版本并取得用户 human gate。没有这组证据和 Personal OS 状态实际变为 `done` 前，不能把 T-194 表述为完成。

本文件只描述当前剩余验证。历史的“提交 A/提交 B 隔离”、脏工作树和 `6e7e1fa` HEAD 前提已被 2026-07-27 的提交与发布取代，不再是执行条件。

## 权威资料

执行前读取：

- `AGENTS.md`
- `.codex/skills/volcano-ops/SKILL.md`
- `.codex/skills/volcano-ops/references/server-deployment.md`
- [version-snapshot-and-assisted-rollback-plan.md](./version-snapshot-and-assisted-rollback-plan.md)
- [workspace-backup-operations.md](./workspace-backup-operations.md)

生产命令的实现以 `scripts/release-snapshot.mjs`、`scripts/release-deploy.mjs`、`scripts/workspace-rollback.mjs` 和 `scripts/deploy-volcano.sh` 为准。普通发布只同步代码、模板和构建输入，绝不替换生产 `.env`、SQLite、真实 Workspace、`reviews/`、`.state/` 或微信状态。

## 授权边界

本演示需要用户明确授权后才可进行生产写入。授权必须只覆盖：创建快照、标准代码发布、回退到 known-good、恢复最新版，以及 Workspace 的只读备份、预检与差异盘点。

以下事项不在 T-194 演示授权内：

- GitHub push 或 PR；
- 替换生产 `.env`、SQLite、`reviews/`、`.state/`、微信状态或完整运行时数据；
- 应用 Workspace 差异，或生成/执行生产 approval；
- 向真实用户发送测试微信、创建规则、触发主动推送或修改投资数据。

Workspace 演示必须停在只读 `inventory.json`；即使存在差异，也默认 `keep-current` 并只报告风险。

## 执行前门禁

以下条件必须同时满足，否则停止：

1. 用户已明确批准维护窗口，且当前没有另一名执行者或自动化在执行同一发布/回退。
2. 生产 SSH、rsync、Node、Git、PM2 和 Portal/Relay 访问正常。
3. `launchd` 备份最近一次执行成功，错误日志为空。
4. 本地 `npm run release:snapshot:smoke`、`npm run backup:workspaces:smoke` 和 `npm run verify` 均通过。
5. 没有无法解释的 scheduler 命中或 active push job。
6. 生产健康、PM2、Portal/Relay 和三个微信 listener 均处于正常基线。
7. 用于生成新版本的 `main` 工作树干净；快照工具会再次强制检查。

记录开始时间、提交 SHA、release ID、命令退出码和耗时。不要输出 `.env`、token、sandbox 凭据、Codex auth 或微信登录状态。

## 演示序列

1. 从干净的 `main` worktree 创建新的发布快照：

   ```bash
   npm run release:snapshot -- create
   ```

2. 使用新 release ID 执行标准代码发布，并完成下方最小验收：

   ```bash
   npm run release:deploy -- <latest-release-id>
   ```

3. 开始计时，回退到已知可用的 `20260727T131243Z-b43402e9`，再执行完整验收：

   ```bash
   npm run release:rollback -- 20260727T131243Z-b43402e9 \
     --confirm=rollback-code-v1
   ```

4. 仅生成 Workspace 差异库存，审阅 `inventory.json` 的计数、用户范围、越权/符号链接和敏感路径结果；不得 `apply`：

   ```bash
   npm run release:workspace-rollback -- plan 20260727T131243Z-b43402e9
   ```

5. 再次部署步骤 1 创建的最新 release，完成验收后才可接受为 known-good：

   ```bash
   npm run release:deploy -- <latest-release-id>
   npm run release:snapshot -- accept <latest-release-id> \
     --confirm=mark-known-good-v1
   ```

任何一步失败时，停止后续动作，保持或恢复到最近一次已验证的代码版本。不得通过修改脚本门禁、手改生产文件或扩大到数据恢复来完成演示。

## 每次发布或回退后的验收

1. `curl http://127.0.0.1:22655/health` 正常，`pm2 list` 中 `invest-agent` 为 `online`。
2. Portal `/api/health` 和 connector/relay 正常。
3. `npm run smoke:mcp-service-tools` 通过。
4. `111`、`dyk`、`mg` 的 Workspace preflight 没有 blocker；`template_updates` 可以存在。
5. 三个微信实例仍为 `connected`，listener 已恢复；`pushReady=false` 仅按现状记录，不得为变成 true 主动发送消息。
6. active push job 为 0，或每项都有明确来源且不是本次演示产生。
7. 从本次 PM2 uptime 开始没有新 `ERROR`、ACP `ENOENT` 或 scope 回退。
8. 以已授权测试账号完成一次主进程只读 ACP 验收，不输出持仓明细，也不写入投资状态。
9. 确认 `.env`、SQLite、`reviews/`、`.state/`、真实 Workspace 和微信状态未被代码发布替换。

## 证据与收尾

证据包至少包含新 release 和 known-good release 的 ID/SHA、manifest/checksum 校验、`created/deployed/accepted` 状态、回退 recovery run、Workspace `inventory.json`、各步骤耗时、验收摘要、最终生产 release/commit，以及 `Workspace apply = 0` 的明确记录。

通过 `personal-os` 的 `task_report` 追加上述摘要，再向用户请求 human gate：

```text
是否确认本次流程可跑、操作足够简单、用户调整丢失风险可控，并同意申报 T-194 完成？
```

只有用户明确确认并且 Personal OS 的 `task_complete` 使状态实际变为 `done`，T-194 才完成。
