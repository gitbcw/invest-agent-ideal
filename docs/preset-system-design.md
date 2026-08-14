# 预设对象体系设计（Preset System Design）

状态：v1 已采纳并部分实施（2026-08-14）——用户授权按最优判断落地，核心锁定"通用能力 + 个性化配置"
已落地：预设注册表与 `applyPreset`（`src/services/presets.ts`，含低打扰复盘型）、任务类型注册表（`src/services/scheduled-task-types.ts`）、schedule 扩展 monthly/windows、任务表 `task_type` 列；开放问题裁决：windows 多时段（一任务多触发点）、v1 不组合、copyPack 仅追加段
未落地：applyPreset 创建的任务为 paused（等执行器激活）；compat 偏好双写在执行器转正后移除
关联：[mastra-architecture-baseline.md](./mastra-architecture-baseline.md) §7.5、[scheduled-flows-to-automation-design.md](./scheduled-flows-to-automation-design.md)

## 1. 定位与原则

**系统只提供通用能力**：身份与 scope、持仓/自选数据、资产库、自动化引擎、投递通道、安全层（确认/审计/锁）。内核中没有"复盘"、"盯盘"、"19:00"——这些全部是**任务实例**，不是系统能力。

**预设 = 一组预置的配置数据对象**。用户可以选择策略包、节奏包或其他包——这取决于我们想做什么产品。它们的本质相同：把一组任务模板、参数与文案打包成一个命名、版本化的对象。

**语义归属原则（用户裁决 D9）**：诸如"通知偏好"（低打扰/主动盯盘/晚间汇总）这类语义**只属于某个预设**（如低打扰复盘型），不是系统语义。系统级只存在通用的"投递通道与频控能力"（能不能推、防轰炸、免打扰窗口），不存在"应该多吵"的观点。

## 2. 预设对象模型（schema 草案）

```ts
interface Preset {
  id: string;                 // "low-disturbance-review"
  version: string;            // 语义版本，升级需迁移策略
  kind: "usage-mode" | "strategy" | "rhythm" | "content";  // 使用方式/策略/节奏/内容包
  name: string;              // "低打扰复盘型"
  description: string;
  requires?: { portfolio?: boolean };   // 应用前置条件
  taskTemplates: PresetTaskTemplate[];  // 应用时批量实例化的自动化任务
  deliveryPolicy?: {         // 投递策略默认值（写入通用投递设置，非系统语义）
    defaultPushMode?: "exception_only" | "scheduled_intraday_brief";
    quietHours?: { start: string; end: string };
  };
  copyPack?: {               // 文案包：任务 prompt 片段覆盖（空 = 用系统默认文案）
    [taskType: string]: string[];
  };
  conflicts?: string[];      // 互斥预设 id（usage-mode 之间互斥）
}

interface PresetTaskTemplate {
  taskType: "review-daily" | "review-weekly" | "review-monthly" | "market-watch" | string; // 复用任务类型注册表
  name: string;
  schedule: { frequency: "daily"|"trading_days"|"weekdays"|"weekly"|"monthly"; time?: string; windows?: string[]; timezone: string };
  output?: object; delivery?: object;   // 透传 automation task 模型
}
```

要点：
- **预设不发明新执行机制**——taskTemplates 完全复用自动化任务模型（D3 任务化是前置，见关联设计稿）
- **copyPack 是受控的 prompt 补丁**：必须登记进 baseline §10.3 补丁地图（预设文案 = 第一种"可插拔"的 prompt 补丁）
- kind 为后续扩展留位：策略包（交易策略实体已存在）、节奏包（只含调度模板）、内容包（方法论文案）

## 3. 第一个预设：低打扰复盘型

内容 = 现在 onboarding 末尾写入的全部语义，对象化：

| 现状写入（onboarding/preferences） | 预设内对应物 |
| --- | --- |
| `notification.preference.mode = low_disturbance/evening_summary` | `deliveryPolicy.defaultPushMode = exception_only` + 免打扰窗口 |
| `schedules.daily_review {19:00, trading_days}` | taskTemplate `review-daily` |
| `schedules.weekly_review {Saturday 09:00}` | taskTemplate `review-weekly` |
| `schedules.monthly_review {day_1 09:00}` | taskTemplate `review-monthly`（依赖 schedule 枚举补 `monthly`） |
| `schedules.market_watch {windows 09:55/11:20/14:30}` | taskTemplate `market-watch {frequency: trading_days, windows}` |
| `watch.only_push_on_exception` | `deliveryPolicy`（任务级 push policy） |
| `schedulerActivation = enabled` | **废除**——任务存在即启用 |
| 复盘/盯盘 prompt 文案（§10.3 补丁） | `copyPack`（初版为空 = 沿用系统默认） |

## 4. 预设生命周期

| 操作 | 语义 | 冲突策略（待审） |
| --- | --- | --- |
| apply | 原子操作：批量创建任务（source 标记 `preset:<id>:<version>`）+ 写投递策略 | 同 taskType 已存在用户任务：**跳过并报告**（默认，不覆盖用户自建） |
| switch（usage-mode 间） | pause 旧预设任务 → apply 新预设 | 产物保留 |
| remove | pause/删除预设来源任务；投递策略恢复系统默认 | 产物（复盘/资产）保留 |
| upgrade | 按版本 diff 增量更新预设来源任务；用户改过参数的任务**不自动覆盖**，标记待确认 | 待审 |

存储：预设定义 = 服务层静态注册表（代码内，随版本管理）；用户应用状态 = 任务的 `source` 字段（`{kind:"preset", presetId, version}`），**不新增用户级预设表**——任务是唯一事实源。

## 5. 与 onboarding 的关系（新 onboarding 草案方向）

```
账号 → 持仓导入（可选，可跳过）→ 选择使用方式
   ├─ 低打扰复盘型（applyPreset）
   ├─ 自主配置（进 Portal 自建任务）
   └─ 裸框架（什么都不选，纯对话使用）
```

- 现有 7 个 draft 工具 + 3 个 confirm 工具服务的"对话式灌输节奏"流程，在预设模型下收缩为：`applyPreset` 单操作 + 持仓导入；draft 状态机去留在新 onboarding 设计中定（Portal 化候选）
- "走完 onboarding 即可调度"语义平移为"应用预设即有对应任务"

## 6. 开放问题（请审）

1. **可组合性**：usage-mode 互斥没问题；但"节奏包 × 策略包"能否叠加（如低打扰模式 + 某趋势策略包）？v1 建议不组合，先立单预设语义
2. **升级策略**：预设出新版本时，用户已修改过参数的任务如何处理（默认不动+标记差异，是否足够）
3. **文案包边界**：copyPack 允许覆盖到什么深度（仅任务级补充段落，还是可覆盖系统默认任务 prompt 的任意部分）——建议 v1 仅允许"追加段"
4. **预设的发现面**：Portal 呈现（选择页/任务模板库）属 G21 后续 Portal 设计，一并考虑

## 7. 实施依赖顺序

1. D3 任务化先行（review/market-watch 成为合法 taskType + schedule 补 monthly/windows）
2. preset 注册表 + applyPreset 服务操作
3. 把现有 onboarding 末尾改为 applyPreset("low-disturbance-review")（行为等价重构，语义显名）
4. Portal 选择面 + 新 onboarding（另行设计）
