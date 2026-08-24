# 评估覆盖枚举与盲区清单（2026-08-24，T-366）

状态：第一轮枚举。方法：以 `src/mcp/service-tool-classification.ts`（工具风险分类单一真相，45 工具）× 失败模式做组合枚举，标注已覆盖 / 有套件未入册 / 待盘点 / 需行为级回放。**枚举不产样例，产盲区地图**；断言（预期契约）是稀缺资源，数字是结果不是目标（登记表纪律）。

## 失败模式集（按分类适用）

| 模式 | read | final-action | other-write |
| --- | --- | --- | --- |
| 越权 / scope 逃逸 | ✓ | ✓ | ✓ |
| 数据缺口诚实性（空结果≠数据不存在） | ✓ | — | — |
| 依赖失败降级与终态 | ✓ | ✓ | ✓ |
| 未确认写入 / 确认篡改 | — | ✓ | ✓ |
| 幂等 / 重复副作用 | — | ✓ | ✓ |
| 旧 revision / 过期草案 | — | — | ✓ |
| 失败回滚残留 | — | ✓ | ✓ |
| 审计唯一性 | ✓ | ✓ | ✓ |
| 路径逃逸 / 结构校验 | ✓（file.parse） | — | ✓（artifacts/spreadsheet/assets） |

## 覆盖现状

### 已入册 executable（12 条）

| 面 | 证据 |
| --- | --- |
| 方法变更确认/revision/幂等/回滚 | EV-014（method_changes.apply 全链） |
| 外部 MCP 失败降级 | EV-015 |
| 推送终态 | EV-016 |
| 运行诊断链关联 | EV-017 |
| 故障演练 F1/F3 | EV-018 |
| Connector 取消/迟到抑制/越权拒绝 | EV-019（tests/portal-conversation-cancel.test.ts，含 scope 覆写与跨 scope 拒绝断言） |
| 自动化调度终态与互斥 | EV-020（tests/automation-scheduler-reliability.test.ts：任务互斥、过期租约终态+新围栏重试、孤儿回收、超期判败不判成、并发 claim 串行化、同进程去重、并发上限、过期槽不召模型） |
| 自动化生命周期与 scope | EV-021（tests/automation-tasks.test.ts：不可变 revision、归档只读、三 scope 字段强制、资产路径逃逸拒绝、xlsx 结构校验） |
| Trace 观测契约 | EV-022（tests/acp-trace-observability.test.ts：compact 元数据、脱敏、legacy 迁移一次拷贝） |
| 连贯性回放（本机） | EV-010/011/012 |

### 工具面缺口（other-write 25 个按组）

| 工具组 | 确定性断言现状 | 动作 |
| --- | --- | --- |
| method_changes.* | ✅ EV-014 | — |
| automation.* | ✅ EV-020/021 | — |
| portfolio.apply_changes / watchlist.add / plans.set / plans.watch_conditions | ✅ EV-023（确认/revision/并发串行 + 六写操作共享物理资源锁）+ EV-024（通用确认门） | — |
| preferences.apply | ✅ EV-027 | — |
| reviews.save | ✅ EV-025（reportKey 校验含路径穿越拒绝 + kind 绑定）；调度授权面 EV-026 | — |
| confirmations.request | ✅ EV-024 | — |
| artifacts.publish / spreadsheet.* / assets.* | ✅ EV-028（产物发布 47 项：格式校验/原子配额/幂等重试/字节保持）、EV-029（资产库组：scope/删除确认/生命周期/legacy/Portal 契约）、EV-030（表格组：transform/结构/合并行展开） | — |
| onboarding.* | ✅ EV-031（确认写投影/draft commit/共享契约跳步 409/微信引导门） | — |
| watch_rules.* | ✅ EV-032（catalog/退役拒绝/参数归一化/dry-run 生产语义/SSE 与 NOT_CONFIGURED 降级/三类价格事实映射） | — |

### read 19 个

- 越权面：✅ 组合闭合——EV-021（automation 读三 scope 字段强制）、EV-029（资产跨 scope 不可见）、EV-024（跨实例确认拒绝）、EV-026（read 分区=全集）。
- 审计面：✅ EV-033（state 读留轻量审计）。
- 缺口诚实性（EV-013 一般化）：**需行为级验证**（模型表达），走 replay 批次——EV-006/007/008/009 四条 candidate 即此批，加上 EV-013 fixture。
- 依赖失败：外部 MCP 面已覆盖（EV-015）；数据源工具（market_watch.snapshot 等）的失败降级待 EV-013 fixture 一并处理。

## Candidate 队列（优先级建议，待用户裁定）

| 优先级 | 批次 | 预估方式 |
| --- | --- | --- |
| P1 | other-write 高风险组盘点入册（portfolio/watchlist/plans/preferences + reviews.save）：先盘点既有套件，缺的补确定性断言 | 纯确定性，可由 agent 独立完成 |
| P2 | artifacts/spreadsheet/assets/onboarding/confirmations 盘点入册 | 同上，量大但机械 |
| P2 | read 类 replay 批次（EV-006~009 升级 + EV-013 fixture） | 需真实模型回放（消耗 token，需授权）与 fixture 搭建 |
| P3 | watch_rules 确定性批（catalog/validate/dry_run） | 纯确定性 |

## 维护纪律衔接

- 巡检（19:15 自动化）与 bad case 关闭时产出 candidate 挂接本清单；
- 每次盘点后更新「已覆盖/待盘点」列，保持本文件是盲区地图的单一入口；
- 变更门选择规则表的七面在盘点完成后重算覆盖率（当前 25/30 executable；确定性盘点全部闭合 + P2b replay 批次两轮执行完毕：EV-007/008 升 executable、EV-006 待契约放宽裁决、EV-009 立案 BC-20260824-001、EV-013 fixture 阻塞待运维）。
