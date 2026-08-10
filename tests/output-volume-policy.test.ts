import assert from "node:assert/strict";
import test from "node:test";

import { OUTPUT_VOLUME_POLICY, SPREADSHEET_OUTPUT_POLICY } from "../src/acp/spreadsheet-output-policy.js";

test("shared output volume policy caps screening and workbook display by default", () => {
  assert.match(OUTPUT_VOLUME_POLICY, /量化选股默认最多展示工具返回顺序的前 100 个候选/);
  assert.match(OUTPUT_VOLUME_POLICY, /默认单个 Excel 工作簿最多保留 100 条数据行/);
  assert.match(OUTPUT_VOLUME_POLICY, /明确说明已截断/);
  assert.match(OUTPUT_VOLUME_POLICY, /只有用户明确要求全部结果、完整名单、不要截断或指定更大数量/);
  assert.match(SPREADSHEET_OUTPUT_POLICY, /表头不计入/);
});
