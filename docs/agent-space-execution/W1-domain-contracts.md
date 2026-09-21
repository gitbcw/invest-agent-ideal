# W1：新对象契约与数据库基础

依赖：W0 验收。只改 schema/migration、领域服务、scope/audit 契约和隔离测试；不改 Portal、调度行为、真实数据。

## 必须表达

`Agent`、`Method`/正式版本、`Skill`/私有与发布版本、`AgentSkillInstallation`、`AgentMethodBinding`、`AgentAssetGrant`、`TaskDependency`、不可变 `TaskRunSnapshot`，以及 T-524 的 Fact/Lesson/Workflow/Commitment/履约引用。既有 user asset/version、automation、trace、review-memory 继续作为事实源，不复制正文。

每个用户对象都有 user/project/instance scope；系统 Skill 与用户 Skill 分域；正式版本不可变；引用版本不得静默替换或删除。服务层校验生命周期、审批、授权、幂等和审计。

## 验收

隔离 DB 可重复升级，失败有恢复说明；跨 scope 读写、批准、安装、发布、引用全部拒绝；草稿不可安装/运行；版本固定；运行快照可表达 Agent、Skill、Method、资产和状态依赖；测试覆盖生命周期、幂等、审计与 scope。不得碰生产 DB。

交接：schema 映射、迁移说明、状态表、API 列表和隔离测试证据。未知字段列为待决，不自行扩展。
