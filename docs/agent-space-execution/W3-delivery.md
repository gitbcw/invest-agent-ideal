# W3 交付：技能目录、发布与安装

状态：本地实现与隔离 DB 验证完成；未迁移真实用户内容、未接线运行时、未改 Portal/调度/生产配置、未新增任何代码执行面或工具注册。
依据：[W3-skill-catalog.md](./W3-skill-catalog.md)、W1 域契约（R1-R9 已通过验收）。执行说明：与 W2 由同一执行 Agent **顺序**执行（W2 先提交 `b3b7466`，W3 随后），共享文件无并行写入。

## 0. 范围与不变量

- 来源三分：system（owner 令牌治理）/ market（显式发布的 public release）/ user_private（默认私有）。
- 发布不可变：release 冻结 (version_id, checksum, visibility)；同 skill 重复 releaseVersion 明确冲突（`IDEMPOTENCY_CONFLICT`，UNIQUE(skill_id, release_version) 物理兜底）；私有后续版本不改变已发布行（测试断言发布行钉住原版本）。
- 私有不可枚举：目录/详情只呈现 public+published；private/shared 不进任何目录面，跨用户详情 fail-closed（与安装同一可见性判定）。
- 默认技能只产生初始清单：`applyDefaultSkillManifest` 是受信策略入口（默认目录由 owner 治理——is_default 仅系统域发布可携带）；幂等（同 skill 存在任一状态安装行即跳过）；默认升级/新默认发布不触碰存量安装；移除后重跑默认清单不复活；升级与移除都是用户的显式授权决定。
- 市场安装后的定制 = 私有派生：`derivePrivateSkillFromRelease` 在派生者 scope 内建私有技能，首版内容必须是派生者自己的真实资产版本（不跨 scope 复制字节）；血缘列（skill.derived_from_release_id / version.derived_from_version_id）+ 审计可追溯；来源发布可见性规则与安装一致（private 跨用户拒绝）。
- 运行只返回已安装固定版本：`resolveInstalledSkillContent` 只认安装行钉住的 versionId（私有后续升级不影响已安装 Agent）；未安装/已移除 `NOT_FOUND`；draft 拒绝；跨 scope Agent `SCOPE_MISMATCH`；字节读取经 checksum 校验（user_asset 走 scoped 校验读取，system_template 走模板根包含 + 字节校验）。
- 内容形状：本域不存在代码执行面——技能内容只是版本化资产引用 + 元数据；目录/详情不吐正文；不凭文本扩权（无任何由文本驱动的权限判定）。

## 1. Schema 变更（ensureColumn 演进，幂等）

| 表 | 列/约束 | 用途 |
| --- | --- | --- |
| `agent_space_skill_releases` | `is_default INTEGER NOT NULL DEFAULT 0`（+ 既有 UNIQUE(skill_id, release_version)） | 默认清单标记；发布唯一性物理兜底 |
| `agent_space_skills` | `derived_from_release_id TEXT` | 派生技能 → 来源发布血缘 |
| `agent_space_skill_versions` | `derived_from_version_id TEXT` | 派生首版 → 来源版本血缘 |

## 2. 新增 API

**`src/services/agent-space/skills.ts`**

| API | 语义 |
| --- | --- |
| `publishSkillRelease(…, isDefault?)` | 默认标记仅系统域；重复 releaseVersion 明确冲突 |
| `listSkillCatalog()` | 市场目录：public+published（slug/name/domain/checksum/isDefault），元数据 only |
| `getReleaseDetailForInstaller(installerScope, releaseId)` | 可见性判定的发布详情（与安装同规则） |
| `derivePrivateSkillFromRelease({scope, releaseId, slug, name, contentRef, actor})` | 私有派生：来源可见性校验 + 派生者自有内容引用 + 血缘落列 + 审计 |
| `readSkillVersionContentBytes(version)` | 技能版本字节读取（user_asset scoped 校验 / system_template 模板根校验） |
| `listDefaultReleases()` | 默认清单候选：is_default+published+public，按技能取最新（rowid 决胜） |

**`src/services/agent-space/agents.ts`**

| API | 语义 |
| --- | --- |
| `applyDefaultSkillManifest({scope, agentId, actor})` | 初始清单：受信策略入口（approval_ref='default-manifest' 是来源标记非凭证）；幂等；不触碰存量安装/不复活移除 |
| `removeInstalledSkill({scope, agentId, skillId, approvalRef, …})` | 显式移除：授权凭证（operation=skill.remove，绑定 agentId+skillId），R9 契约（重放返回原结果零副作用）；安装行保留 removed 状态 |
| `getInstalledSkillManifest(scope, agentId)` | 安装清单读模型：每技能一行固定版本 + 内容定位元数据 + 派生血缘 |
| `resolveInstalledSkillContent(scope, agentId, skillId)` | 运行时固定版本解析：安装行钉住的版本 + 校验字节；未安装/越权/draft 拒绝 |

## 3. 测试证据

`tests/agent-space-domain.test.ts` 新增组 "W3: catalog privacy, release immutability, default manifest, derivation, removal, runtime pinned resolution"。fixture 扩展：系统模板根落真实模板文件（checksum 由真实字节计算）。

覆盖断言：private 不进目录、跨用户详情拒绝；重复 releaseVersion 冲突、私有后续版本不改发布行；is_default 用户域拒绝；默认清单首发/幂等/新 Agent 拿新默认/老 Agent 存量不动；授权移除→运行解析拒绝→重放零审计→重跑默认不复活→重装新行；公开发布可派生（血缘断言）、私有发布派生拒绝、slug 冲突拒绝；运行解析钉住安装版本（私有升级后仍返回 v2 字节）、系统模板安装读出校验字节、未安装/跨 scope 拒绝。

```
node --import tsx --test --test-concurrency=1 --test-force-exit tests/agent-space-domain.test.ts   # 25/25
npm test    # 715/715（~47s 自终止）
npm run build && npx tsc --noEmit   # 0 错误
```

## 4. 待决项（不在本单元范围）

- shared 可见性的授权模型（市场审核策略未冻结，v3 §8）——跨用户 shared 派生/安装/详情均 fail-closed。
- 运行时装配接线（W4）：`resolveInstalledSkillContent` 已提供固定版本读取，装配注入由 W4 接。
- 默认清单的 owner 治理面（is_default 的发布/撤回 UI）；owner 令牌生产注入方式（settings 键）沿用 W1 待决项。
- Portal 技能目录页面（IA 未定）；市场发布与 task dependency 发布授权读取统一（W1 遗留注记）。
