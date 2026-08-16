# 正式上线切换执行手册（2026-08-17 周一 08:00–09:30）

> 本文是唯一执行依据：到点由 owner 发起，Agent 按本文逐步执行，每步带核验点。
> 分工标记：【A】= Agent 执行（本会话），【O】= owner（用户）执行或确认。
> 数据源：2026-08-17 01:00 完成的生产灾备快照（覆盖 8-16 全天）。
> 目标：候选环境（23657）成为正式 Portal；生产 22649 并行不动，微信推送仍走生产。

## 0. 时间线

| 时间 | 事项 | 负责 |
| --- | --- | --- |
| 01:00 | 灾备快照自动完成（Mac 本地 `latest-full`） | 自动 |
| 08:00 | owner 叫 Agent，开始切换 | O→A |
| 08:00–08:50 | 快照校验 → 本地重建迁移目标 → 双读核验 | A |
| 08:50–09:10 | 部署到服务器 + 展示态导入 + 账号种子 + 成本切零 | A |
| 09:10–09:25 | 服务端核查 + 冒烟（登录/对话/自动化/巡检） | A，O 抽查 |
| 09:25 | 通知 mg/dyk/111 启用 | O |
| 09:30 起 | 调度首验（盘中简报 09:30/09:55） | A |

**预算超线处置**：任一阶段超出时间盒且未定位原因，停在当前阶段报告 owner，不盲赶进度；生产不受影响，可改期。

## 1. 前置确认（08:00–08:05）【A】

```bash
SNAP=/Users/combo/MyFile/my-data/backups/invest-agent/disaster-recovery/latest-full
cat $SNAP/COMPLETE                    # 存在且非空
ls $SNAP/databases/                   # runtime.db + portal.db 齐全
(cd $SNAP && shasum -a 256 -c manifest.sha256 | tail -3)   # checksum 通过
node -e "require('better-sqlite3')('$SNAP/databases/runtime.db').pragma('quick_check')"  # ok
```

- [ ] 快照 `metadata.txt` 时间戳为 2026-08-17 01:0x
- [ ] `conversation_sessions` 计数 ≥ 105（含 8-16 新增）
- [ ] 报告 owner：快照规模与关键计数，得到「继续」确认【O】

## 2. 本地重建迁移目标（08:05–08:50）【A】

8-15 验证轮同款流程（产物参照 `data/migration-validation-20260815/`）：

```bash
cd /Users/combo/MyFile/projects/invest-agent-ideal-mastra
WORK=data/migration-golive-20260817
mkdir -p $WORK/target $WORK/reports
cp $SNAP/databases/runtime.db $WORK/target/runtime.db
# 目标库升级到候选分支 schema（建 mastra_* 投影表 + legacy trace 改名迁移）
NODE_ENV=production DB_PATH=$PWD/$WORK/target/runtime.db \
  WORKSPACE_BACKEND=mastra node --experimental-strip-types -e \
  "const {initDb}=await import('./src/db/index.ts');initDb();console.log('schema ok')"
```

分域映射与导入（六域：portfolio / strategy / runtime-preferences / review-memory / assets / strategy-project；用户 mg/dyk/111）：

- P1 dry-run：`scripts/mastra-*-mapping-dry-run.mjs` / `mastra-workspace-prototype-check.mjs`，参数 `--workspace-snapshot $SNAP/workspaces --target-db $WORK/target/runtime.db --target-project-root $WORK/target/projects --batch-id golive-20260817`，映射报告落 `$WORK/reports/`（命名对齐 8-15 报告集）。
- P2 导入：`scripts/mastra-*-target-import.mjs`（同参数 + `--mapping`）——**幂等，双跑验证 inserted→replayed**。
- 偏好→任务：`node scripts/mastra-preferences-to-tasks-migration.mjs`（typed 任务重建，复跑 skipped）。

核验（对齐 8-15 标准）：

- [ ] 六域报告 `unclassified=0`（strategy.yaml 的 profile/methods 拆分属已文档化例外）
- [ ] 双读比对：portfolio / dailyPlans 与源一致
- [ ] `mastra_portfolio_states` mg/dyk/111 三行齐全；strategy 投影无 E1 退役键
- [ ] `target/projects/` 为 scope-digest 根布局（F2 教训）
- [ ] 冷启动冒烟：`tests` 式 smoke 或以临时 env 起 runtime 读健康

## 3. 服务器部署（08:50–09:10）【A】

```bash
# 3.1 停候选两进程（portal 先停，恢复先起 runtime）
ssh claude@118.145.115.197 "pm2 stop mastra-portal invest-agent-mastra"
# 3.2 备份现候选数据（回滚位）
ssh claude@118.145.115.197 "cd /home/claude/invest-agent-mastra && \
  cp data/runtime.db data/runtime.db.pre-golive-20260817 && \
  tar czf data/projects.pre-golive-20260817.tgz data/projects"
# 3.3 上传新数据（.env/.state 不动：微信监听状态保留）
rsync -az $WORK/target/runtime.db claude@118.145.115.197:/home/claude/invest-agent-mastra/data/runtime.db
rsync -az --delete $WORK/target/projects/ claude@118.145.115.197:/home/claude/invest-agent-mastra/data/projects/
# 3.4 起服务
ssh claude@118.145.115.197 "pm2 start invest-agent-mastra && sleep 3 && pm2 start mastra-portal && pm2 save"
```

## 4. 展示态导入 + 账号种子 + 成本切零（09:10 前完成）【A】

```bash
# 4.1 生产门户展示态（软删/归档/置顶/重命名/标签）
ssh claude@118.145.115.197 "cd /home/claude/invest-agent-mastra && \
  rsync/上传 $SNAP/databases/portal.db 到 /tmp/golive-portal.db && \
  node scripts/mastra-portal-presentation-import.mjs --source /tmp/golive-portal.db --target data/runtime.db"
# 核验：mg 可见会话=9、111=30、dyk=6（软删已隐藏）；标签 7 个在库

# 4.2 门户账号种子（portal_users 备份库没有，8-15 为手工种子）
#    mg/dyk/111 三个账号插入 + 随机密码（in-process node 脚本，对齐今日 owner 重置做法）
#    【O】owner 收到三个新密码并分发

# 4.3 platform owner 密码重置（新库带生产 platform_users，与 .env 不同步）
#    in-process scrypt 重置 + 同步 .env PLATFORM_BOOTSTRAP_PASSWORD（对齐今日操作）

# 4.4 成本统计切零（token+成本从上线时点从零累积，不回填）
ssh claude@118.145.115.197 "cd /home/claude/invest-agent-mastra && node scripts/mastra-cost-archive-reset.mjs --purge"
# 核验：agent_traces 计数=0；归档文件落在 data/archives/

# 4.5 微信监听拉起（111）
#    platform API: POST /api/platform/instances/invest-agent-111/weixin/listener/start
```

## 5. 核查与冒烟（09:10–09:25）【A，O 抽查】

- [ ] `pm2 ls` 两进程 online；`curl 127.0.0.1:23655/health` ok；公网 23657 登录页 200
- [ ] runtime-error 日志无新增
- [ ] 冒烟（用 mg 新密码）：登录 → 会话列表（数量与 4.1 核验一致，微信会话带通道标识）→ 发一句「茅台今天怎么样」→ 5-20s 内回复且引用本轮行情
- [ ] 自动化页 4 个任务 active、next_run 正确（周一 09:30/09:55 盘中简报）
- [ ] 巡检页 200、规则列表在
- [ ] 【O】owner 用自己账号过一遍关键页

## 6. 上线宣布（09:25）【O】

- owner 通知 mg/dyk/111：日常使用改走 `http://118.145.115.197:23657`（新密码已分发）；生产 22649 与微信推送不受影响。

## 7. 当日首验（09:30 起）【A】

- 09:30 / 09:55 三个用户盘中简报、19:00 三个日复盘、22:00 每周热点趋势：核验任务状态不进失败计数、复盘落库（reviews）、trace 计价（人民币/峰谷）正常。
- 已知预期差：候选未接微信，推送不送达（生产侧同任务负责推送）；候选侧以落库为验收。
- 持续观察错误日志与 trace，异常即报 owner。

## 8. 回滚（仅在冒烟失败且无法快速定位时）【A→O 批准】

```bash
ssh claude@118.145.115.197 "cd /home/claude/invest-agent-mastra && \
  cp data/runtime.db.pre-golive-20260817 data/runtime.db && \
  rm -rf data/projects && tar xzf data/projects.pre-golive-20260817.tgz -C data/ && \
  pm2 restart invest-agent-mastra mastra-portal"
```

- 回滚后候选回到切换前状态；生产全程未动，无额外动作。
- 回滚需 owner 明确批准后执行。

## 9. 已知边界（不阻塞上线）

- 微信侧对话/推送接入候选：下一阶段。
- 附件 7 天过期清理：不在范围。
- git 分支暂不 push，稳定后一把推。
