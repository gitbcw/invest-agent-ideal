# 自动化工作簿 schema 契约（T-480）设计与契约

- 依据：T-480 任务契约 + 生产资产只读核实（2026-09-06，隔离快照 2026-09-06T0100）；修复 8-28 appendRows 三连败暴露的"任务与工作簿 schema 无契约绑定"缺口，并落地 [p17-convergence-mg-core-loop-2026-08.md](./p17-convergence-mg-core-loop-2026-08.md) 的 owner 2026-08-31 裁决（T-417：行业复盘现行 17 列，第 11 列为废弃占位）。
- 状态：已实现（2026-09-06）。本文是 schema 契约的权威描述。

## 1. 生产 schema 证据（核实结论，可复核）

| 任务 | 绑定资产（rev） | 实测表头 | 结论 |
| --- | --- | --- | --- |
| 行业复盘 `at_60d62fcb…`（rev20） | `asset_71e25a40…`（2026年09月行业复盘表_序号分段版.xlsx，v1–v3） | 标题行 r1（17 格合并标题）+ 表头 r2：序号/复盘日期/行业代码/行业名称/当日涨跌幅(%)/主力净流入(亿元)/5日主力净流入(亿元)/成交额(亿元)/涨跌家数/涨停公司/**已删除：公司涨幅(%)(占位)**/资金流入较强公司/公司主力净流入(亿元)/趋势判断/主要原因/验证条件\/风险/来源与时间 = **17 列**；8 月旧资产 `asset_525fcdc…` v16 同 17 列同表头 | **17 列为现行正式 schema**（owner 8-31 裁决证实）；"14 列契约"为过时巡查口径（7-31~8-13 旧格式），历史版本原样保留 |
| 持仓复盘 `at_d64649ad…`（rev7） | `asset_c877fcb9…`（2026-09月持仓与观察标的明细.xlsx，v1–v4） | 标题行 r1 + 表头 r2：日期/持仓股/当前价位/当前K线信号/当前控盘度（V1.1 严格四因子）/90%筹码集中度/资金净流入量/重要信息/当前判断/次日计划 = **10 列**；8 月旧资产同 10 列 | 10 列为现行正式 schema |

2026-08-28 的三连败（`row #N has 16 columns; expected exactly 17` / `9 columns; expected 10`）是模型生成的行数据少列，被既有 appendRows 列数校验（`automation-spreadsheet.ts` 运行时表头推导）正确拒绝——校验本身无缺陷；缺陷在于**任务 revision 与工作簿 schema 之间没有持久契约**，schema 漂移（月 rollover 新文件、人工改表）只能靠运行时失败暴露，且 rollover create 新文件完全无结构校验。

## 2. 契约定义

`automation_task_revisions.output_json` 的 update 分支新增可选字段：

```json
{
  "mode": "update",
  "assetId": "…",
  "rollover": { "kind": "monthly", "fileNamePattern": "…" },
  "expectedSchema": {
    "columnCount": 17,
    "headerRow": 2,
    "header": ["序号", "复盘日期", "…"]
  }
}
```

- `columnCount`（必填，正整数）= 工作表列数，与 `sheetSchema` 推导口径一致（`max(物理列数, 表头行最后非空列)`）。
- `headerRow`（必填，1–10）= 表头所在行（标题行工作簿通常为 2）。
- `header`（可选）= 表头单元格文本数组（`normalizeCellText` 归一化后），长度必须等于 `columnCount`；提供时做逐列标签比对（只比文本，不猜语义）。
- **无 `expectedSchema` 的存量任务行为不变**（不校验）——向后兼容。

## 3. 绑定与升级路径

- **自动快照**：创建/编辑 update 模式且目标为 xlsx 的任务时，若调用方未显式提供 `expectedSchema`，服务层从绑定资产当前版本的第一个工作表确定性快照（`inspectAutomationXlsx`，不跑模型）写入 revision。inspect 失败（资产不可读等）时跳过快照并 warn，不阻断编辑。
- **已知合法升级**（如未来 17→18 列）：编辑任务重新保存（或换绑新结构资产）→ 新 revision 自动快照新 schema → 后续 run 按新契约校验。revision append-only，升级历史与回滚依据天然保留。
- **显式提供优先于自动快照**（管理脚本/测试用）。

## 4. 运行时确定性检查

1. **run 前 fail-fast**（模型执行前，`generic-automation-runner`）：revision 带 `expectedSchema` 且绑定输出为 xlsx 时，inspect 绑定资产当前版本，`columnCount`/`headerRow`/`header` 任一不匹配 → `AUTOMATION_SCHEMA_MISMATCH`（invalid_input，不可重试），错误信息含预期 vs 实际与行动指引（"若为已知合法表结构变更，请编辑任务重新保存以更新契约快照；否则请恢复资产版本"）。零模型调用，不烧预算。
2. **rollover create 结构校验**：monthly rollover 新文件提交时，若 revision 带 `expectedSchema`，inspect 新文件比对，不匹配拒绝（`AUTOMATION_RUN_INVALID_RESULT: schema mismatch…`）。新文件结构以 revision 契约为权威，不再无校验放行。
3. **appendRows 既有列数校验不变**（运行时表头推导严格相等）。

## 5. 边界遵守

- 不删除、不重排用户字段；不做列语义推断（只比文本标签）；契约值来自资产实测，不硬编码 mg 的 17/10 列进代码（全局默认不存在）。
- 旧 14 列历史资产版本原样保留；对齐操作走 `updateAutomationTask`（append-only revision + 审计），不直写行、不碰历史。
- 不修改同花顺/策略公式（不涉足）。

## 6. mg 对齐操作

`scripts/align-mg-workbook-schema.mjs`（幂等，支持 dry-run）：对两个 mg 任务读取现 revision 定义与绑定资产实测 schema，显式提交带 `expectedSchema` 的新 revision；目标 revision 已带相同 schema 时跳过。执行前后只读核对（revision 链、绑定、下次 run）。

## 7. 验收对照

隔离测试 `tests/automation-schema-contract.test.ts` 覆盖：①契约兼容（17 列资产 + appendRows 17 列行 → 成功，revision 自动带快照）；②未知不兼容（资产变 18 列 vs 契约 17 → 模型执行前阻断，executor 零调用，错误含行动指引）；③已知升级（编辑任务 → 新 revision 快照 18 列 → run 成功）；④无契约存量任务不校验；⑤rollover create 新文件 schema 不符被拒。
