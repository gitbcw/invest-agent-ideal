# W0：权威源与迁移基线

依赖：无。对应 v3 的 W0。只读，不改代码、生产数据或真实 Workspace。

## 目标与产物

为 `mg`、`111`、`dyk` 建立可重复的迁移输入基线。产物放在 gitignored、权限受限的运行目录：

- `manifest.json`：逐项记录 `scope`、源路径/asset/version、sha256、size、classification、proposedTarget、consumers、contextEntrypoints、disposition、confidence、evidenceRefs。
- `backup-coverage.json`：逐源记录外部备份路径、hash、可读恢复结果；字节未核对不得标记 covered。
- `context-entrypoints.json`：每条路径标记 `default-load`、`on-demand`、`history-only` 或 `unknown`，附代码/运行证据类型。
- `REVIEW.md`：阻塞项、冲突、未覆盖范围和不应自动迁移项。

## 规则

允许分类：`data_asset`、`method`、`private_skill`、`system_skill_copy`、`task_dependency`、`conversation_or_state`、`history_archive`、`duplicate_alias`、`unclassified`。目录名不是分类依据。冲突、草案、无完整 hash、无备份覆盖项不得交给后续导入。

使用只读 DB、query-only、限定 user/project/instance；不得输出密钥或用户正文到普通日志。核对注册根、user assets/versions、任务/运行绑定、对话/状态引用和旧 Workspace 实际入口。有限采样与隔离副本不算完整备份。

## 验收

三用户均有 manifest；每项有来源、hash、处置；`unknown` 不得被写成安全。每个可导入项有外部备份且可读回。`default-load` 必须有直接代码或运行证据；未查到只能 unknown。工作树无产品/生产修改。

交接：报告命令、运行目录、覆盖/阻塞计数和证据边界。W1 只使用 manifest 的权威结论。
