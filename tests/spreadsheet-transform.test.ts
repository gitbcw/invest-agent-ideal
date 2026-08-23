import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("spreadsheet.transform applies structured changes to a staged workbook", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-sheet-transform-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { initDb } = await import("../src/db/index.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
    const { checkToolScope } = await import("../src/mastra/tools/scope-guard.js");
    const ExcelJS = (await import("exceljs")).default;

    initDb();
    const workspace = path.join(tempRoot, "staging");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(workspace, { recursive: true });

    const seed = new ExcelJS.Workbook();
    const sheet = seed.addWorksheet("热点");
    sheet.addRow(["周次", "主题", "代表标的"]);
    sheet.addRow(["2026-W32", "AI 算力", "中际旭创"]);
    const seedBytes = Buffer.from(await seed.xlsx.writeBuffer());

    await mkdir(path.join(workspace, "inputs"), { recursive: true });
    await writeFile(path.join(workspace, "inputs", "1-tracker.xlsx"), seedBytes);

    const context = { userId: "sheet-transform-user", instanceId: "invest-agent-sheet-transform", projectId: "invest-agent", workspacePath: workspace };

    // scheduled-automation 会话（只读 grant）必须能用它，否则自动化更新绑定工作簿无解。
    const scope = checkToolScope("spreadsheet.transform", { ...context, taskType: "scheduled-automation" });
    assert.equal(scope.allowed, true, `scheduled-automation must grant spreadsheet.transform: ${scope.reason}`);

    const result = await callServiceTool("spreadsheet.transform", {
      inputPath: "inputs/1-tracker.xlsx",
      outputPath: "outputs/tracker-v2.xlsx",
      changes: {
        // 嵌套数组形态（多行塞进一个 appendRows 项）必须展开为多行，而不是压进一个单元格。
        appendRows: [
          { sheet: "热点", values: [["2026-W33", "储能政策", "宁德时代"], ["2026-W33", "AI 算力", "中际旭创"]] },
        ],
        setColumnWidths: [{ sheet: "热点", column: 2, width: 24 }],
      },
    }, context) as { ok: boolean; outputPath: string; bytes: number };
    assert.equal(result.ok, true);
    assert.ok(result.bytes > 0);

    const reopened = new ExcelJS.Workbook();
    const outputBytes = await readFile(path.join(workspace, "outputs", "tracker-v2.xlsx"));
    await (reopened.xlsx.load as unknown as (input: ArrayBuffer) => Promise<unknown>)(
      outputBytes.buffer.slice(outputBytes.byteOffset, outputBytes.byteOffset + outputBytes.byteLength) as ArrayBuffer
    );
    const rows = reopened.getWorksheet("热点")!.getSheetValues().filter(Boolean);
    assert.equal(rows.length, 4, "nested appendRows must expand into one row per record");
    assert.equal(String(rows[2][1]), "2026-W33");
    assert.equal(String(rows[3][2]), "AI 算力");
    // 每个单元格必须是标量，不允许整行被压成 JSON 字符串。
    assert.ok(!String(rows[2][1]).startsWith("["));

    // 越界路径必须被拒绝（暂存目录之外不可读写）。
    const escape = await callServiceTool("spreadsheet.transform", {
      inputPath: "inputs/1-tracker.xlsx",
      outputPath: "../escape.xlsx",
      changes: { appendRows: [{ sheet: "热点", values: ["x"] }] },
    }, context) as { ok: boolean; error?: string };
    assert.equal(escape.ok, false);
    assert.equal(escape.error, "spreadsheet_transform_failed");
    // 输出路径与输入相同必须被拒绝，保持暂存输入不变。
    const samePath = await callServiceTool("spreadsheet.transform", {
      inputPath: "inputs/1-tracker.xlsx",
      outputPath: "inputs/1-tracker.xlsx",
      changes: {},
    }, context) as { ok: boolean; error?: string };
    assert.equal(samePath.ok, false);
    assert.equal(samePath.error, "spreadsheet_transform_failed");

    const automationContext = { ...context, taskType: "automation-execution" };
    const reservedInputOutput = await callServiceTool("spreadsheet.transform", {
      inputPath: "inputs/1-tracker.xlsx",
      outputPath: "inputs/tracker-v2.xlsx",
      changes: { appendRows: [{ sheet: "热点", values: [["2026-W34", "机器人", "测试标的"]] }] },
    }, automationContext) as { ok: boolean; error?: string; message?: string; hint?: string };
    assert.equal(reservedInputOutput.ok, false);
    assert.equal(reservedInputOutput.error, "spreadsheet_transform_failed");
    assert.match(reservedInputOutput.message ?? "", /reserved for automation inputs\/helpers/);
    assert.match(reservedInputOutput.message ?? "", /staging root/);
    assert.equal(existsSync(path.join(workspace, "inputs", "tracker-v2.xlsx")), false);

    const reservedHelperOutput = await callServiceTool("spreadsheet.transform", {
      inputPath: "inputs/1-tracker.xlsx",
      outputPath: "automation-sheet.mjs",
      changes: { appendRows: [{ sheet: "热点", values: [["2026-W34", "机器人", "测试标的"]] }] },
    }, automationContext) as { ok: boolean; error?: string };
    assert.equal(reservedHelperOutput.ok, false);
    assert.equal(reservedHelperOutput.error, "spreadsheet_transform_failed");

    const automationRootOutput = await callServiceTool("spreadsheet.transform", {
      inputPath: "inputs/1-tracker.xlsx",
      outputPath: "tracker-automation-v2.xlsx",
      changes: { appendRows: [{ sheet: "热点", values: [["2026-W34", "机器人", "测试标的"]] }] },
    }, automationContext) as { ok: boolean; outputPath?: string; bytes?: number };
    assert.equal(automationRootOutput.ok, true);
    assert.equal(automationRootOutput.outputPath, "tracker-automation-v2.xlsx");
    assert.ok((automationRootOutput.bytes ?? 0) > 0);
    assert.ok((await readFile(path.join(workspace, "tracker-automation-v2.xlsx"))).length > 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
