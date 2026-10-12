# 生产 Agent Space 全量迁移验证（本地镜像重建）

日期与环境：2026-10-10 晚；本地镜像（Portal 3120 / runtime 23670 / relay 3220），数据源为生产当日 22:22 一致性快照（VACUUM INTO），经 `import-local-backup-mirror.mjs` 重建 + `seed-local-mirror-portal.mjs` 生成 mirror-111/dyk/mg 登录。

## 验证目标

2026-10-10 生产全量切换装配模式并执行迁移（系统技能种子、安装、策略方法化迁移）后，确认无数据丢失与功能异常。

## DB 层（快照即生产现状）

- 系统技能 7 个（定时任务设计、宏观政策流动性、Skill 创建器、仓位与风控、基本面、技术面、候选筛选），status=active / 版本 approved / release published
- 安装 3 用户 × 7（mg/dyk/111 各自 agent），全部 installed
- 方法绑定 3 条全 active：mg=控盘度综合评分（pinned）、dyk/111=strategy-rules（current）
- 方法版本内容引用 user_asset_version，user_assets / user_asset_versions 悬空引用为 0
- 自动化任务：111（3 active + 4 archived）、dyk（5 active）、mg（7 active + 2 paused）、mgreplay（1 active + 2 needs_attention + 13 paused）
- 会话 202 / 消息 2689 / projects 5

## API 层（三用户登录后）

- `/api/strategies`：每人 1 条迁移策略，active、isPrimary=true、版本 approved
- `/api/skills?view=installed`：每人 5 项非核心技能；「Skill 创建器」「定时任务设计」为 is_core=1，被 portal-actions.ts 的安装视图按设计过滤（非丢失）
- `/api/skills`（默认 private）为空属预期；catalog 为空=非核心技能已全部安装
- `/api/automations`：任务与排期正常（nextRunAt 恢复至 10-11/10-12）
- `/api/attention`：111/dyk 空；mg 1 条历史 automation_failure（日复盘 dependency_unavailable，生产真实数据）

## 端到端

mirror-mg 发送「你当前加载了哪些分析类技能」，agent 正确回答含已安装技能名并区分核心流程类技能——证明迁移后的技能注入了运行时装配上下文。

## 人工结论

Pass。迁移目标全部达成，未发现数据丢失或功能异常。

观察项（非迁移缺陷）：本地镜像 start 脚本的进程监督存在孤儿看门狗自动重启行为（PPID=1 的监督进程接管端口），清理重复实例时镜像短暂中断后自愈，不影响生产。
