# Portal 并发核心资源写入一致性交接计划

## 1. 背景与当前决定

Portal 本地已支持同一用户最多两个并发对话。产品判断是：用户通常不会在两个对话中同时处理同一项投资状态，且持仓、策略、预案等重要修改已有草案和确认流程，因此真实冲突概率很低；但服务层仍应为少数核心资源提供确定性保护，避免极端情况下出现丢失更新或 stale revision 覆盖。

本次采用窄范围资源锁，不串行整个 ACP turn：

- 普通行情研究、问答、选股和不同报告继续并发。
- 只串行核心资源的完整“读取 -> confirmation/revision 校验 -> 写入 -> 审计”过程。
- Portal 并发上限仍为 2，不在本任务中调整。
- 先完成本地实现和验收，不部署生产。

## 2. 必须遵守的边界

- 阅读并遵守 `AGENTS.md`、`.codex/skills/service-api-change/SKILL.md`、`docs/service-tools-mcp.md`、`docs/23-multi-user-sandbox-design.md`。
- 服务层拥有确定性写入、确认、revision 校验和审计；不要把一致性寄托在 prompt 或用户警觉上。
- 不要给整个 workspace 或整个 ACP 对话加锁。
- 不要改变普通微信消息的 workspace ACP 直通架构。
- 不要声称已经保护 Codex 的任意直接文件写入。ACP 当前仍是 `sandbox_mode="workspace-write"`，本方案只硬保护经过具名 MCP、onboarding worker 和已接入兼容 HTTP adapter 的核心写入。
- 不要部署、连接或修改生产环境。
- 当前 worktree 有大量与本任务无关的用户修改，不得还原、覆盖或顺手整理。

## 3. 已完成但尚未最终验收的代码

以下改动已写入当前 worktree：

### 3.1 跨进程资源锁

新增 `src/services/resource-mutation-lock.ts`：

- 使用共享 `RUNTIME_DATA_ROOT/resource-mutation-locks/` 下的原子目录锁。
- 能协调主运行时、不同 ACP/MCP 子进程和 onboarding worker；不能退回仅进程内 `Map/Promise` 锁，因为每个并发 ACP 会话拥有独立 MCP 子进程。
- 多资源键排序后依次获取，避免相反顺序造成死锁。
- 默认等待 30 秒，超时抛出 `ResourceMutationLockTimeoutError`，不会绕过锁继续写。
- owner 信息记录 pid、hostname、token 和获取时间；仅在同机 owner 进程已不存在时清理遗留锁。
- lock identity 当前按 `userId + resourceKey`，没有用 `instanceId` 分裂物理 workspace 文件锁。原因是 `WorkspaceStore` 当前按 user 解析同一个 workspace；同一 user 的兼容 instance 也不能并发覆盖同一文件。

### 3.2 操作到资源键的统一映射

新增 `src/services/mutation-resource-keys.ts`，当前映射包括：

- `portfolio.apply_changes`、watchlist add/remove、plans set/watch-conditions/remove -> `portfolio`
- onboarding portfolio -> `portfolio` + `onboarding-state`
- onboarding step -> 按 step 获取 `strategy`、`schedules`、`notification`、`watch` 和 `onboarding-state` 的必要子集
- onboarding draft commit -> 一次获取所有核心 onboarding 文件键和 `watch-rules`
- strategy/profile writes -> `strategy`
- watch-rule create/update/delete -> `watch-rules`
- method-change propose/decide -> `method-changes`
- daily review save/generate -> `daily-review:{date}`
- 市场读取和普通研究 -> 不取锁

注意：自选、持仓和个股预案目前都通过 workspace backend 读改写同一个 `portfolio.yaml`，所以不能安全地只按 `plan:{stockCode}` 分锁。若未来把预案改成真正的 per-stock 文件或 SQLite 原子 upsert，再考虑细化锁键。

### 3.3 已接入的入口

- `src/mcp/service-tools-core.ts`：在 `callServiceTool()` 外层根据操作映射加锁，因此确认校验、revision 检查和写入都发生在锁内。
- `src/services/onboarding-drafts.ts`：后台 frozen draft commit 使用同一套多资源锁。
- `src/routes/sandbox.ts`：新增 `sandboxMutationSafe()`，核心兼容 HTTP 写入口使用与 MCP 相同的资源映射。
- `docs/service-tools-mcp.md`：已补充跨进程核心资源锁契约说明。

### 3.4 已新增测试

- `tests/resource-mutation-lock.test.ts`
- `tests/fixtures/resource-lock-child.ts`
- `tests/mutation-resource-keys.test.ts`

覆盖目标：同资源串行、不同资源并发、不同用户互不阻塞、多资源排序、异常释放、独立子进程争用和资源映射。

## 4. 当前验证状态（不要误报）

暂停前已确认：

- `npm run typecheck` 通过（在最后一次测试夹具修改之前）。
- `npm run build` 通过（在最后一次测试夹具修改之前）。
- `tests/portfolio-apply-changes.test.ts` 通过，原有 revision-bound 持仓事务未被破坏。
- 资源映射测试、同进程串行/并发/异常释放测试通过。

尚未确认：

- 跨进程测试第一次因 Node `-e`/TypeScript loader 方式失败，不是锁断言失败。
- 已把子进程改为 `tests/fixtures/resource-lock-child.ts`，随后又修复了该夹具的 CJS top-level await 问题，但用户此时要求暂停，因此修复后尚未重跑。
- 全量 `npm test`、`npm run verify` 和相关 smoke 尚未运行。
- 本地 PM2 runtime 尚未按最终代码重启和健康检查。
- 尚未进行两个 Portal 对话同时写同一核心资源的真实交互验收。

## 5. 后续执行步骤

### Step 1：先复核当前 diff

1. 运行 `git status --short`，确认并保留所有无关用户改动。
2. 只审查本计划第 3 节列出的文件和此前 Portal 并发相关文件。
3. 运行 `git diff --check`。
4. 检查 `resource-mutation-lock.ts` 的释放逻辑不会因 operation 抛错而遗留当前 owner 的锁。
5. 检查 HTTP 的 `sandboxMutationSafe()` 只包裹写入口，没有误包裹普通读取。

### Step 2：重跑最小测试并修复夹具

先运行：

```bash
NODE_ENV=test DB_PATH=./data/test.db WORKSPACE_ROOT=./data/test-workspaces RUNTIME_DATA_ROOT=./data/test-runtime \
node --import tsx --test --test-concurrency=1 \
tests/resource-mutation-lock.test.ts \
tests/mutation-resource-keys.test.ts \
tests/portfolio-apply-changes.test.ts
```

验收要求：

- 跨进程子测试必须证明 child 持锁时 parent 未进入；child 释放后 parent 才进入。
- 如果子进程仍失败，先把 stderr 纳入断言错误信息，修复测试启动或夹具问题，不要删除跨进程测试，也不要降级成同进程测试。
- 测试结束后临时 lock root 必须被清理。

### Step 3：补充关键一致性回归（推荐）

在现有 `tests/portfolio-apply-changes.test.ts` 基础上增加一个并发场景：

1. 为同一 user/workspace 创建两个基于同一 revision 的已确认变更。
2. 让第一个调用持有 `portfolio` 锁并完成写入。
3. 第二个调用等待后再执行 revision 校验。
4. 断言第二个因 stale revision 被拒绝，而不是覆盖第一个结果。
5. 断言失败的 confirmation 未被错误消费，并有 error audit。

如果直接控制 `callServiceTool()` 内部时序过于侵入，可给锁模块增加仅测试使用的可控 hook，或通过预先持有同一资源锁来稳定安排顺序；不要在生产代码加入固定 sleep。

### Step 4：检查入口覆盖是否完整

重点搜索：

```bash
rg -n 'writePortfolio|writeStrategy|writeSchedules|writeNotification|writeWatch|writeTradingStrategy|removeTradingStrategy|saveSkillDailyReview|planBackend\.(upsert|remove)|watchlistBackend\.(add|remove)|createWatchRule|updateWatchRule|deleteWatchRule' src
```

逐项判断：

- Portal/微信正常 ACP 写路径是否已经过 `callServiceTool()`。
- scheduler/onboarding worker 是否有绕开 MCP 的核心写路径。
- compatibility HTTP adapter 是否使用 `sandboxMutationSafe()`。
- Platform 管理写入口若能修改同一物理资源，也必须使用同一锁；若当前不存在或只读，在计划结果中明确说明。
- 普通 Agent 直接写 workspace 方法、Skill、知识和研究报告不属于本次核心域锁，不要无边界扩张。

### Step 5：完整本地验证

按顺序运行：

```bash
npm run typecheck
npm run build
npm test
npm run smoke:mcp-service-tools
npm run smoke:onboarding-confirm-step
npm run smoke:onboarding-draft-commit
npm run smoke:portal-conversation-log
npm run verify
git diff --check
```

若 `verify` 中存在与本任务无关、由原有 dirty worktree 引起的失败，记录准确命令、失败位置和证据，不得通过回滚用户改动来“修复”。

### Step 6：本地运行时与真实交互验收

只有上述自动化验证通过后，阅读并遵守 `.codex/skills/local-runtime-restart/SKILL.md`，重启本地 `invest-agent-codex`（端口 22655），检查 `/health`。

在 `http://127.0.0.1:3100/chat` 做以下验收：

1. 两个对话同时做只读研究，确认仍能真正并发。
2. 两个对话分别修改不同核心资源（例如一个策略、一个持仓），确认互不阻塞或只产生极短正常等待。
3. 两个对话对同一 `portfolio.yaml` 域发起已确认写入，确认后到达者重新校验 revision，不能静默覆盖。
4. 同一日期复盘并发保存时必须串行；不同日期复盘不因日期锁互相阻塞。
5. 第三个并发任务仍返回既有可重试 `CONCURRENT_TASK_LIMIT`。
6. 对话切换后已完成内容不重新播放流式动画，确保此前 Portal 并发 UX 没有回归。

保留对话日志、sandbox audit、ACP trace 和最终 workspace 文件作为验收证据。

## 6. 完成标准

- 两个 Portal 对话保持并发，第三个仍被限制。
- 同一 user 的同一核心物理资源在所有已接入进程/adapter 间串行。
- 锁覆盖读取、确认/revision 校验和写入全过程。
- stale 并发写明确失败，不发生 last-writer-wins 静默覆盖。
- 不同资源、不同用户和普通只读研究不会被无关阻塞。
- operation 抛错或子进程退出后不会永久死锁；活跃 owner 不会被误删。
- 全量构建、测试和相关 smoke 通过，或只剩有证据的无关既有失败。
- 只完成本地验收，没有生产部署或生产数据修改。

## 7. 风险与后续边界

- 这是单机共享文件系统锁，适用于当前一个本地/火山运行时目录。未来若横向扩成多主机且不共享 `RUNTIME_DATA_ROOT`，必须迁移到数据库 advisory lock、Redis 或单写服务，不能继续声称跨主机一致性。
- 当前锁能避免并发交错，但 onboarding 多文件提交仍不是崩溃原子事务；中途进程崩溃可能留下部分文件已写。现有 frozen draft、验证和 retry 负责恢复，这与“并发互斥”是两个不同问题。
- `portfolio.yaml` 聚合了持仓、自选和预案，导致这些逻辑资源必须串行。若实际争用增加，应先拆物理存储或提供服务层原子 patch，再细化锁。
- 直接 workspace 文件写仍不受此锁硬约束。完整文件级硬白名单属于 `docs/23-multi-user-sandbox-design.md` 中的后续迁移，不在本任务范围。

## 8. Executor Prompt

继续完成 `docs/core-resource-mutation-consistency-handoff-plan.md`。先审查当前 dirty worktree，保留所有无关用户修改；不要重新设计 Portal 并发，也不要部署生产。优先重跑并修复跨进程资源锁测试，然后补充 stale revision 并发回归，核对所有核心写入口是否共享同一资源锁。完成自动化验证后按 local-runtime-restart skill 重启本地运行时，并在两个 Portal 对话中做真实并发验收。最终报告必须区分已验证保证、现有边界和未覆盖的任意直接文件写入。

## 9. Reviewer Prompt

独立审查执行结果是否满足本计划第 6 节。重点寻找：仅进程内锁导致不同 MCP 子进程失效、锁只包住 `writeFile` 而没有包住 revision/confirmation 校验、`portfolio.yaml` 的自选/预案写入口漏锁、多资源获取死锁、异常后遗留锁、误把普通研究串行，以及对直接 workspace 写入或跨主机一致性的过度承诺。没有真实跨进程测试和 stale revision 回归时，不应判定完成。
