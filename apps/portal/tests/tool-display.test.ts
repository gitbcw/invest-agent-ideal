import assert from "node:assert/strict";
import test from "node:test";

import { toolDisplayName } from "../src/components/chat/tool-display";

test("tool display names translate known market tools into user language", () => {
  assert.equal(toolDisplayName("get_hist_kline"), "查询历史行情");
  assert.equal(toolDisplayName("get_industry_fund_flow_matrix"), "查询行业资金流");
  assert.equal(toolDisplayName("get_sector_list"), "获取行业板块列表");
});

test("tool display names hide unknown implementation identifiers", () => {
  assert.equal(toolDisplayName("some_internal_tool"), "执行分析步骤");
  assert.equal(toolDisplayName("workspace.file.get"), "读取工作文件");
});
