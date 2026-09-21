# W0 独立验收与返工单

日期：2026-09-20。依据：W0-migration-baseline.md、v3 总纲、执行报告及 `.state/agent-space-w0/` 实物。仅本地只读核对，未重扫生产、未修改执行产物。

## 结论

**Partial，暂不放行 W1。** 原始文件清单有价值，保留并定向补齐；不能把现有 manifest 作为唯一权威迁移输入。以下是已约定要求的缺口，不新增市场或运行功能。

## 验收矩阵

| 条件 | 结果 | 证据 |
| --- | --- | --- |
| 三用户文件清单及四份交付存在 | Pass | 111=6010、mg=6176、dyk=6200，共18386项，JSON可解析 |
| 每项来源、hash与处置 | Partial | 16项无hash，需要显式非普通文件/错误状态与导入阻断；不能把全部项称为已逐文件hash验证 |
| 按内容、来源、消费者分类 | Fail | build-manifest.py 按 assets/migrated 前缀整体标记 no-migrate-history；与已整理方法价值冲突 |
| 上下文入口一致且证据充分 | Fail | manifest中442项 migrated 文件为on-demand，入口汇总却为history-only；大小写匹配遗漏实际SKILL.md元数据默认加载 |
| 数据库资产、版本及任务引用基线 | Partial | DB脚本主要查询计数，文件项无assetId/versionId、具体task/revision绑定；消费者主要是泛称 |
| 逐源备份可读回 | Partial | check_backup仅比对备份manifest中的hash；报告明确只抽样读回9项；backup-coverage只有用户汇总，无逐项可读回状态 |
| 权限受限、gitignored | Partial | gitignored已验证；实际根目录0755、manifest/报告0644，与报告0700不符 |
| 无产品改动 | Pass（本地范围） | git status只显示已有文档及新增设计文件；不据此证明全部远端行为 |
| 全部生产操作无副作用 | Unknown | 采集脚本可读且DB readonly；未独立检查完整远端会话。脚本注释称query-only，但DB脚本无pragma query_only |

## 必须修正

### R1：区分两代物理根与本次退出对象

Codex旧目录与当前Mastra混合工作根是不同对象。旧目录不活跃，不能证明v3要退出的混合Workspace已退出。活注册根仍挂载整个根目录（src/mastra/workspace-registry.ts:173）。mtime不变、日志未命中也不能证明零读取。

修正 REVIEW、入口文件和逐项清单的一致性：分别标明“是否可读取”“是否默认注入”“是否观察到实际使用”；无证据为unknown。注册清单由服务读取，不等于正文注入模型。修正 `skill.md` 对实际 `SKILL.md` 的大小写遗漏，分别记录metadata与body。

### R2：不能按迁移目录批量判定历史无价值

三个 `assets/migrated/knowledge/methods/fundamental.md` 均被标为no-migrate-history。之前整理已识别dyk完整六维模型、mg基本面风险评估等具体用户价值。与 `.local/workspace-reconciliation/runs/2026-09-20T03-28-34-377Z/disposition.json`、FOLLOWUP.md交叉核对，并标注来源时点，不能机械照搬旧候选。

对相关方法、配置、私有技能和计划补采用证据及实际消费者；不能仅凭跨用户内容不同断定用户亲自修改，也不能仅凭两张空表断定计划未被其他后端承接。结论不足时用候选/unknown。不会因为这些待定项而要求全部内容先获批准，但它们必须明确禁止自动导入。

### R3：补对象引用基线

只读导出 scoped assetId/versionId/head、taskId/revision/input-output绑定、run实际版本引用、conversation/state权威引用元数据。关联文件项与DB对象，列明可复用、不迁移、待判定。现有脚本只按user过滤；补project/instance实际身份验证，不用拼接字符串代替核实。无需导出所有聊天正文。

### R4：逐项备份证据和导入门禁

为每项提供可关联的源ID、备份路径、期望hash、实际读回hash、读回时间/错误、coverage与blockedReasons。至少将全部可导入候选逐项读回校验；其余可维持manifest-only/unknown，不能宣称全部恢复可读。

对数据库引用区分“备份DB完整性通过”和“本次采样行在备份中存在且一致”，两者不可互替。covered-stale、无hash、冲突、未批准草案和无备份项必须被机器规则排除，不能仅在REVIEW中口头说明。不要重跑生成器就声称校验通过：当前若干恢复成功标签写死在生成器里，需链接实际验证结果。

### R5：修正产物权限与报告

目录0700、文件0600，并检查实际权限；保留原始采样和本次验收记录。只同步项目W0产物，不修改全局记忆；执行报告中提及的记忆更新不属于W0授权。是否曾修改及位置应在返工交接中如实列出，不擅自回滚其他记录。

## 复验方式

- 离线校验JSON、条目引用完整性、入口汇总与逐项一致性及候选门禁；检查全部实际SKILL.md。
- 对可导入项独立读取备份字节计算hash；区分采样时点与当前生产漂移。
- 检查具体DB引用而非计数；复核dyk基本面、mg双算法及111模板/策略分离未被目录规则吞掉。
- 检查权限和gitignored；生产数据、任务、配置仍不得改动。

## 给执行Agent的返工提示

> 继续W0，按本报告R1-R5定向返工，保留原始采样，不重做无关全量探索，不进入W1、不清理测试用户、不修改生产配置或记忆。提交逐项修正说明、可复跑的验证命令和机器结果。无备份历史日志可以保持阻塞；不能为通过W0删除或伪造覆盖。复验通过后由主reviewer决定W1放行。

## 第二次验收：返工 v2（2026-09-20）

结论：**Partial，尚不放行 W1；只需定向修复下列门禁与映射问题，不重扫全部生产。**

本次独立验证：

- 执行 `python3 .state/agent-space-w0/check-consistency.py`，7组自检无失败；但检查尚未覆盖下述语义反例。
- 独立用 Node 逐项读取 readback-results 所指备份，1365项实际SHA256同时匹配源采样hash及记录的读回hash；12项ENOENT与缺失记录一致，0其他失败。没有重写验证文件。
- 递归检查全部产物权限，目录0700、文件0600，0失败。
- 审查 refs采集脚本，readonly/query_only已落实，具体资产版本、任务revision/绑定/run、会话工件元数据已有导出。仍属于采样基线，不证明未来生产状态或所有状态表完整。
- 已修正两代Workspace表述、SKILL.md大小写、备份证据层次和未知分类；记忆越权修改已披露，不要求再次写记忆。

### R6：同一来源必须关联多个整理结论，不能最后一项覆盖前项

实际manifest：

| 源 | 当前关联 | 被遗漏的语义 |
| --- | --- | --- |
| mg methods/strategy-rules.md | mg-fundamental / reconcile-explicit-user-revision | mg-strategy / hold-ambiguous-clauses；整份策略与基本面修订的证据来源不是同一个目标对象 |
| 111 methods/strategy-rules.md | 111-daily-review / extract-existing-requirements | 111-strategy / split-presentation；同一源拆为策略与工作说明两个目标 |

改为源→多条目标/证据关系，记录关系角色（直接内容源/修订证据/拆分来源）、各自目标与处置。不要把证据文件当成该候选的完整正文，不以一个hash相同推断只有一个目标。清单中的consumers也按目标保留，不跨目标合并成已采用结论。

### R7：自动导入门禁必须消费处置语义

`classify_live` 对全部 methods/ 返回 migrate-candidate，空 blockedReasons，覆盖了关联的处置约束。实际 `autoImportable` 包含 mg strategy-rules（未决条款）和旧 KP V1.0（historical-not-default）。这违反W0“冲突不得交给后续导入”的规则。

修复：把已知hold/conflict、拆分未完成、history-only或historical-not-default约束送入机器门禁。历史字节可以保全，但必须与“可成为运行中Method”分开；不能使用一个autoImportable桶同时表达两者。若只是归档复制，应明确目标、运行采用状态和禁止默认加载，不能以此放行运行采用。

增加直接针对反例的检查：

1. mg策略保留hold，不得进入运行对象自动导入；基本面修订证据不覆盖该hold。
2. 111策略源同时关联策略和模板两个目标，拆分未验证前不得自动作为完整新Method采用。
3. 旧KP必须保留历史定位，禁止默认采用；四因子独立保留，不能被KP替换。
4. 门禁检查除backup/hash外，验证目标语义、所有关联处置以及blockedReasons；汇总计数由修正后的实际条目生成。

### 非阻塞的复跑说明修正

REWORK-NOTES远端命令包含省略号且引用已清理的/tmp脚本，应补可复制的完整参数和脚本传送/清理步骤。权限命令不能先递归撤销目录owner访问再find；应在目录仍可遍历时设置目录0700、文件0600。当前权限结果正确，这只是复跑说明问题。

### 下一次交接

只提交R6/R7及复跑说明的修订，保留此次原始数据与备份。无需补备份被排除日志，不需owner逐项裁决所有历史资产，不需新增生产实验。上述门禁反例通过后，可判定W0满足进入W1所需的基线；W6/W7迁移放行仍独立核查。

## 第三次验收：R6/R7 修订（2026-09-20）

结论：**Pass with caveats；W0 作为对象建模基线通过，放行 W1 本地实现及隔离数据库验证。** 不放行真实内容导入、生产发布或 Workspace 切换。

验证证据：

- 重跑 check-consistency.py：10组检查通过，18386项，0失败。
- 独立Node断言检查唯一ID、全部自动项无adoptionConstraints，以及四个反例的目标关联、自动桶/ownerReview归属；全部通过。并审查生成器的一源多目标列表构造及处置约束传播，未只依赖执行方测试结论。
- mg策略同时保留策略hold与基本面修订证据；111策略同时保留策略与工作说明拆分目标，消费者随各自目标保存。
- mg旧KP保留历史定位并被排除；mg四因子保留独立身份与既有任务消费者，仍是导入候选。
- 门禁93项autoImportable、205项ownerReview，其余18088项排除；自动候选不等于新增运行采用授权。
- 递归权限复查0失败。上一轮独立备份读回1365项匹配、12项缺失的证据继续有效；本轮未重复生产采集或备份读回。

仍保留的边界：无备份日志、未知内容、未决采用与计划承接、dyk血缘引用均不因W0通过而解除。采样只能证明当时时点，W6/W7需刷新数据并单独验收。一源多目标关系仍需后续领域服务实现，当前只是迁移映射。不得依据autoImportable自动启用方法或修改生产资产。

W1派发范围：读取v3总纲、W1-domain-contracts.md与本报告最新结论；复用已有权威服务，建立对象/版本/引用及scope、生命周期、幂等、审计基础；遵循项目db-migration流程，仅使用隔离DB。禁止导入mg/111/dyk、修改运行时装配、调度、Portal或生产配置。交付代码位置/提交、schema映射、状态转换、测试命令与结果及恢复说明，再独立验收后进入W2/W3。
