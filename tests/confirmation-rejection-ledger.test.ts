import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/** T-506 P2（owner 2026-09-15 排定）：①登记后立即可执行性检查——watch_rules.create
 * 业务校验、watchlist.add 重复拒绝、assets.delete 资产存在性，让「用户确认过的
 * 草案必然能落地」；②确认流拒绝账本 confirmation_rejections——注册端契约/业务
 * 拒绝与执行端比对拒绝按 stage+reason_code 结构化落库，取代 9-13 排查时的
 * 人肉 grep 计数。 */

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-rejection-ledger-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(tempRoot, "test.db");
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

async function setup(name: string) {
  const { db, initDb } = await import("../src/db/index.js");
  const { conversationSessions, conversationMessages, confirmationRejections } = await import("../src/db/schema.js");
  const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
  const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");
  const userId = `rejection-ledger-${name}`;
  const instanceId = `invest-agent-rejection-ledger-${name}`;
  const conversationId = `rejection_ledger_${name}`;
  const context = { userId, instanceId, projectId: "invest-agent", conversationId, workspacePath: resolveWorkspacePath(userId) };
  initDb();
  await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
  const now = new Date().toISOString();
  await db.insert(conversationSessions).values({
    conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId,
    channel: "web", title: "rejection ledger", createdAt: now, updatedAt: now,
  });
  const ledger = async () => db.select().from(confirmationRejections).then((rows) => rows.filter((row) => row.userId === userId));
  return { db, conversationMessages, callServiceTool, context, userId, instanceId, conversationId, ledger };
}

test.after(() => rm(tempRoot, { recursive: true, force: true }));

test("contract rejection is ledgered; valid registration writes no ledger rows", async () => {
  const { callServiceTool, context, ledger } = await setup("contract");
  await assert.rejects(
    () => callServiceTool("confirmations.request", {
      operation: "method_changes.propose",
      payload: { change_type: "replace", title: "畸形草案" },
      summary: "probe",
    }, context),
    /字段契约/,
  );
  let rows = await ledger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, "register");
  assert.equal(rows[0].reasonCode, "contract_invalid");
  assert.equal(rows[0].operation, "method_changes.propose");
  assert.match(rows[0].detail, /缺少必填字段 proposedChange/);

  const ok = await callServiceTool("confirmations.request", {
    operation: "watchlist.add",
    payload: { name: "平安银行", code: "000001", reason: "合法草案" },
    summary: "valid",
  }, context);
  assert.equal((ok as { ok: boolean }).ok, true);
  rows = await ledger();
  assert.equal(rows.length, 1, "valid registration must not add ledger rows");
});

test("watch_rules.create draft fails fast on invalid ruleType (business_invalid)", async () => {
  const { callServiceTool, context, ledger } = await setup("rule");
  await assert.rejects(
    () => callServiceTool("confirmations.request", {
      operation: "watch_rules.create",
      payload: { stockCode: "600519", stockName: "贵州茅台", ruleType: "not_a_rule", targetScope: "manual", params: {} },
      summary: "probe",
    }, context),
    (error: unknown) => {
      assert.match(String(error), /watch_rules\.create 业务校验/);
      assert.match(String(error), /ruleType/);
      return true;
    },
  );
  const rows = await ledger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reasonCode, "business_invalid");
  assert.equal(rows[0].stage, "register");
});

test("watchlist.add duplicate is rejected at registration (business_invalid)", async () => {
  const { callServiceTool, context, ledger } = await setup("watch");
  const { watchlistBackend } = await import("../src/lib/data-backend.js");
  await watchlistBackend.add(context.userId, context.instanceId, { code: "600519", name: "贵州茅台", reason: "seed", source: "manual" });
  await assert.rejects(
    () => callServiceTool("confirmations.request", {
      operation: "watchlist.add",
      payload: { name: "贵州茅台", code: "600519", reason: "重复添加" },
      summary: "probe",
    }, context),
    /已在自选池中/,
  );
  const rows = await ledger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reasonCode, "business_invalid");
});

test("assets.delete with unknown assetId is rejected at registration (business_invalid)", async () => {
  const { callServiceTool, context, ledger } = await setup("asset");
  await assert.rejects(
    () => callServiceTool("confirmations.request", {
      operation: "assets.delete",
      payload: { assetId: "asset_does_not_exist" },
      summary: "probe",
    }, context),
    /不存在或不属于当前用户/,
  );
  const rows = await ledger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reasonCode, "business_invalid");
});

test("execution payload drift is ledgered at execute stage (payload_mismatch)", async () => {
  const { db, conversationMessages, callServiceTool, context, conversationId, userId, ledger } = await setup("drift");
  const requested = await callServiceTool("confirmations.request", {
    operation: "watchlist.add",
    payload: { name: "宁德时代", code: "300750", reason: "草案理由" },
    summary: "valid",
  }, context) as { ok: boolean; confirmationId: string };
  assert.equal(requested.ok, true);
  await db.insert(conversationMessages).values({
    messageId: `drift-confirm-${Date.now()}`, conversationId, userId, projectId: "invest-agent",
    instanceId: context.instanceId, assistantId: context.instanceId, channel: "web", role: "user",
    content: "确认", createdAt: new Date(Date.now() + 1_000).toISOString(),
  });
  await assert.rejects(
    () => callServiceTool("watchlist.add", {
      confirmedByUser: true, confirmationId: requested.confirmationId,
      name: "宁德时代", code: "300750", reason: "被篡改的理由",
    }, context),
    /confirmation invalid: confirmation payload mismatch/,
  );
  const rows = await ledger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, "execute");
  assert.equal(rows[0].reasonCode, "payload_mismatch");
});
