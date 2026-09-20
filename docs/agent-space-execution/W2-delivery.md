# W2 交付：用户方法与数据资产路径

状态：本地实现与隔离 DB 验证完成（含返工 W2-R1）；未迁移真实用户内容、未接线运行时、未改 Portal/调度/生产配置。
依据：[W2-methods-assets.md](./W2-methods-assets.md)、W1 域契约（R1-R9 已全部通过验收）、[W2/W3 验收返工单](./W2-W3-acceptance-review.md)。执行说明：W2 与 W3 由同一执行 Agent **顺序**执行，共享文件无并行写入。

## 返工 W2-R1（readopt 不得绕过历史定位约束）

`readoptMethodVersion` 与 approve/resolve 统一采用约束校验：`historical-not-default`（BLOCKS_RUN_BINDING）版本**永远不能成为 current，owner 通道也不能通过回退绕过**；拒绝随事务回滚——current/版本状态/凭证/审计均不变；历史读取（`getMethodVersion`/`readMethodVersionContent`）不受影响，不靠运行读取放行修复。反例测试组 "W2-R1: readopt can never make history-only versions current (owner channel included)" 覆盖 owner 与普通授权两条通道、拒绝原子性与历史可读。

> 注：本单元的 diff 能力是**元数据级**（checksum/引用对比），不含正文 Diff 界面。

## 0. 范围与不变量

- canonical bytes 仍在 `user_assets`/`user_asset_versions` 版本链上；Method 域只持引用（asset_id + asset_version_id + checksum），不复制正文。
- 批准且采用才形成正式历史（draft 不进入 `getMethodVersionHistory`）；草稿不注入运行解析（`resolveMethodVersion` 仅 approved/superseded，W1 已强制）。
- 小改动同样形成正式版本：`addMethodVersion` 无内容阈值、无去重合并；同内容两个版本并存、独立固定读取（测试断言 `diff.identical=true` 且两行独立）。
- 回退 = 采用指针变化（`readoptMethodVersion`），版本字节不可变；旧 current 转 superseded 仍可固定重现。
- 历史默认不可发现：`listUserMethods` 只呈现方法 + current 版本（含约束），任何历史 versionId 不出现在默认发现面；历史须显式 versionId 或 `getMethodVersionHistory`。
- 被 run/task/commitment 引用的版本可重现：TaskRunSnapshot 固定 versionId（W1），本单元补 `readMethodVersionContent` 按 versionId 还原字节（测试：快照 → pinned 读取逐字节重现）。
- 方法选择不经过 Workspace list/grep：全部读取走 DB 读模型 + scoped user-assets 字节读取，域内无任何文件系统枚举。

## 1. 新增 API（`src/services/agent-space/methods.ts`）

| API | 语义 | 失败契约 |
| --- | --- | --- |
| `readMethodVersionContent(scope, versionId)` | 固定版本字节读取：版本行 → user_asset_version → scoped 字节读取（复用 user-assets 的路径安全 + size/checksum 校验）；返回 `{version, bytes}` | 篡改 hash → `ASSET_CHECKSUM_MISMATCH`；缺版本/缺文件 → `NOT_FOUND`/`ASSET_NOT_FOUND` |
| `readoptMethodVersion({scope, methodId, versionId, approvalRef, ownerToken, actor})` | 显式回退/重采用：正式版本（approved/superseded）重设为 current；旧 current → superseded；授权走 R9 契约（核验+消耗+指针变更+审计+结果记录同事务，重放返回原结果） | draft/缺失版本 → `VERSION_INVALID`；已 current → `VERSION_INVALID`（明确失败）；retired 方法 → `INVALID_TRANSITION`；hold 类约束非 owner → `ADOPTION_CONSTRAINT` |
| `listUserMethods(scope)` | 默认发现读模型：方法 + current 版本 + 当前约束 | — |
| `getMethodVersionHistory(scope, methodId)` | 显式正式版本链（approved/superseded），含 supersedes/批准时间/约束；draft 不入列 | — |
| `diffMethodVersions(scope, fromVersionId, toVersionId)` | 元数据级 diff：两侧 checksum/asset 引用 + `identical`；不内嵌正文 | 跨方法 → `ARGUMENT_INVALID` |

Schema 变更：无（回退是指针变化，无新表新列）。

## 2. 测试证据

`tests/agent-space-domain.test.ts` 新增组 "W2: method paths — pinned byte reads, readopt rollback, small-change formal versions, drafts outside formal history"。fixture 扩展：scopeA 注册 mastra 测试项目（唯一存储根）并落**真实字节资产**（asset_w2 两个版本，checksum 由真实字节计算，存储路径符合 user-assets 契约）。

覆盖断言：草稿不在正式历史；pinned 读取返回逐字节正文；superseded 版本仍逐字节重现；同内容两版本独立存在且 diff=identical；readopt 后 resolve 回到 v1、旧 current 转 superseded、重放零新增审计、已 current 再 readopt 明确失败、draft 不可 readopt；篡改背书文件 → `ASSET_CHECKSUM_MISMATCH`、恢复后可读；缺版本 `NOT_FOUND`；默认发现不含历史 versionId；快照固定 v2 → 按 versionId 逐字节重现。

```
node --import tsx --test --test-concurrency=1 --test-force-exit tests/agent-space-domain.test.ts   # 含 W2-R1 反例组（28 组全绿）
npm test    # 718/718（~47s 自终止）
npm run build && npx tsc --noEmit   # 0 错误
```

## 3. 交接（W3/W4 引用规则）

- canonical source：`user_asset_versions`（storage_path 在 mastra 项目根下，读取必须走 `readUserAssetVersion` 的 scoped 校验路径）。
- 读取模式：运行/引用侧一律 `resolveMethodVersion`（current 或显式 pin）→ `readMethodVersionContent(versionId)`；历史读取 `getMethodVersion`/`getMethodVersionHistory`，不过运行约束但同 scope。
- 版本固定证据：TaskRunSnapshot 条目（versionId + 服务端盖章 checksum）+ 审计链；W3/W4 只能引用 Method versionId，不得复制正文或绕过 checksum。
