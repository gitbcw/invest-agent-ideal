import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Must be set before any module that loads data-backend is imported.
process.env.WORKSPACE_BACKEND = "mastra";

// 2026-08-25 mg 复盘合并回写缺口：对话面没有自动化 runner 的输入落盘环节，
// spreadsheet.transform 只吃 workspace 内路径，导致对话中无法对已保存工作簿做
// 受控编辑后写回同一资产。本测试覆盖修复后的完整对话链路：
// assets.version.read {stage:true} → spreadsheet.transform → assets.version.commit。
test("conversation can stage, transform, and commit a saved workbook back to the same asset", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-workbook-bridge-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { initDb } = await import("../src/db/index.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
    const { mastraWorkspaceRegistry, resolveRegisteredMastraProjectRoot } = await import("../src/mastra/workspace-registry.js");
    const assets = await import("../src/services/user-assets.js");
    const { convertCsvBytesToXlsx } = await import("../src/services/csv-xlsx-conversion.js");
    const ExcelJS = (await import("exceljs")).default;

    initDb();
    const userId = "bridge-user";
    const instanceId = "invest-agent-bridge-user";
    const projectId = "invest-agent";
    await mastraWorkspaceRegistry.bootstrap({ userId, projectId, instanceId });
    const projectRoot = await resolveRegisteredMastraProjectRoot({ userId, projectId, instanceId });
    assert.ok(projectRoot, "project root must be registered");

    const scope = { userId, projectId, instanceId };
    const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const containerBytes = await convertCsvBytesToXlsx(Buffer.from("日期,标的,收盘\n2026-08-24,示例,10\n"));
    const container = await assets.createUserAsset({
      ...scope, name: "持仓明细容器", fileName: "2026-08-24 持仓与关注股日复盘明细.xlsx", mimeType: XLSX_MIME, bytes: containerBytes,
    });
    const detailBytes = await convertCsvBytesToXlsx(Buffer.from("日期,标的,收盘\n2026-08-25,贵州茅台,1500\n"));
    const detail = await assets.createUserAsset({
      ...scope, name: "8-25 明细", fileName: "2026-08-25 持仓与关注股日复盘明细（控盘度V1.1）.xlsx", mimeType: XLSX_MIME, bytes: detailBytes,
    });

    // 对话上下文：无 workspacePath，基座必须回退到用户项目根。
    const conversationContext = { userId, instanceId, projectId, conversationId: "conv-bridge" } as any;

    const stagedContainer = await callServiceTool("assets.version.read", { assetId: container.assetId, stage: true }, conversationContext) as { ok: boolean; stagedPath?: string };
    assert.equal(stagedContainer.ok, true);
    assert.ok(stagedContainer.stagedPath, "stage:true must return a stagedPath");
    assert.match(stagedContainer.stagedPath!, /^staged-assets[/\\]/);
    assert.equal(existsSync(path.join(projectRoot, stagedContainer.stagedPath!)), true, "bytes must land inside the project root");

    const merged = await callServiceTool("spreadsheet.transform", {
      inputPath: stagedContainer.stagedPath!,
      outputPath: "merged-container.xlsx",
      changes: { appendRows: [{ sheet: "数据", values: [["2026-08-25", "贵州茅台", 1500]] }] },
    }, conversationContext) as { ok: boolean; error?: string };
    assert.equal(merged.ok, true, `transform must work without workspacePath via project-root fallback: ${merged.error}`);

    const committed = await callServiceTool("assets.version.commit", {
      assetId: container.assetId,
      fileName: "2026-08-24 持仓与关注股日复盘明细.xlsx",
      filePath: "merged-container.xlsx",
      expectedVersionId: container.currentVersionId,
    }, conversationContext) as { ok: boolean; error?: string; version?: { versionId: string } };
    assert.equal(committed.ok, true, `commit from filePath must succeed: ${committed.error}`);
    assert.notEqual(committed.version?.versionId, container.currentVersionId, "a new version must be committed");

    // 写回后容器必须同时保留 8-24 原始行与追加的 8-25 行（受控合并，非重建）。
    const after = await assets.readCurrentUserAsset({ ...scope, assetId: container.assetId });
    const workbook = new ExcelJS.Workbook();
    const buf = Buffer.from(after.bytes);
    await workbook.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    const sheet = workbook.getWorksheet("数据")!;
    assert.equal(sheet.rowCount, 3, "original row plus appended row");
    assert.deepEqual((sheet.getRow(2).values as unknown[]).slice(1), ["2026-08-24", "示例", "10"]);
    assert.deepEqual((sheet.getRow(3).values as unknown[]).slice(1), ["2026-08-25", "贵州茅台", 1500]);

    // 不带 stage 的读取行为不变，且第二个资产同样可 staged。
    const plain = await callServiceTool("assets.version.read", { assetId: detail.assetId }, conversationContext) as { ok: boolean; stagedPath?: string };
    assert.equal(plain.ok, true);
    assert.equal(plain.stagedPath, undefined, "without stage:true no path is exposed");

    // 越界 filePath 必须被拒绝。
    const escape = await callServiceTool("assets.version.commit", {
      assetId: container.assetId,
      fileName: "escape.xlsx",
      filePath: "../escape.xlsx",
    }, conversationContext).catch((error: unknown) => ({ ok: false, error: String(error) })) as { ok: boolean; error?: string };
    assert.equal(escape.ok, false, "a path outside the workspace must be rejected");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
    delete process.env.INVEST_AGENT_SANDBOX_SECRET_FILE;
  }
});
