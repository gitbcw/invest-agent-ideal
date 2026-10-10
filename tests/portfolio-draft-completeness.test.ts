import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * 2026-10-09 fresh 微信录入回归：用户报 4 只持仓（含股数），模型登记草案被
 * expectedLastConfirmedAt 连拒 6 次后降级 payload（丢股数/成本），执行端忠实写入
 * 残缺草案并谎报「已记账」。同会话 10 只观察仓录入因无批量操作，模型串行登记
 * 19 份草案撞 maxSteps，两轮 MASTRA_EMPTY_RESPONSE。
 *
 * 对应修复：
 * - 登记端服务端绑定 revision（expectedLastConfirmedAt 缺省不再拒）
 * - 草案完整性警告（shares/weight/cost 三无持仓）
 * - 执行结果回读写入值 + 汇报指令
 * - watchlist.add_many 批量登记与执行
 */
test("portfolio draft registration binds revision server-side and warns on quantity-less holdings (fresh 2026-10-09 regression)", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-portfolio-complete-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { db, initDb } = await import("../src/db/index.js");
    const { conversationMessages, conversationSessions } = await import("../src/db/schema.js");
    const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");
    const { readMastraPortfolioProjection } = await import("../src/lib/mastra-portfolio-backend.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");

    const userId = "portfolio-complete-user";
    const instanceId = "invest-agent-portfolio-complete-user";
    const conversationId = "portfolio-complete-conversation";
    const context = { userId, instanceId, projectId: "invest-agent", conversationId, workspacePath: resolveWorkspacePath(userId) };

    initDb();
    await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
    // fresh 用户当时是空持仓：projection 无记录（revision 为 null）。
    const now = new Date().toISOString();
    await db.insert(conversationSessions).values({
      conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId,
      channel: "weixin-mobile", title: "Draft completeness regression", createdAt: now, updatedAt: now,
    });
    const insertUserMessage = (messageId: string, content: string, createdAt: Date) =>
      db.insert(conversationMessages).values({
        messageId, conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId,
        channel: "weixin-mobile", role: "user", content, createdAt: createdAt.toISOString(),
      });

    // 事故形态 1：完整草案不带 expectedLastConfirmedAt——此前被硬拒 6 次，
    // 现在必须一次登记成功且不带三无警告。
    await insertUserMessage("req-1", "这些是我的持仓，帮我录入", new Date(Date.now() - 120_000));
    const fullDraft = await callServiceTool("confirmations.request", {
      operation: "portfolio.apply_changes",
      payload: {
        upsertHoldings: [
          { code: "159567", name: "港股创新药ETF", shares: 5000, cost: 0.671 },
          { code: "601058", name: "赛轮轮胎", shares: 1000, cost: 13.0 },
        ],
      },
      summary: "录入 2 只持仓",
    }, context) as { confirmationId: string; warnings?: string[]; warning?: string };
    assert.ok(fullDraft.confirmationId, "draft registration without expectedLastConfirmedAt must succeed");
    assert.equal(fullDraft.warnings, undefined, "holdings carrying shares/cost must not warn");

    // 事故形态 2：残缺草案（三无持仓）——登记仍成功（局部更新合法），但必须警告。
    await insertUserMessage("req-2", "再加一只，具体数量回头补", new Date(Date.now() - 60_000));
    const lossyDraft = await callServiceTool("confirmations.request", {
      operation: "portfolio.apply_changes",
      payload: {
        upsertHoldings: [{ code: "002240", name: "盛新锂能" }],
      },
      summary: "补一只持仓",
    }, context) as { confirmationId: string; warnings?: string[] };
    assert.ok(lossyDraft.confirmationId);
    assert.ok(Array.isArray(lossyDraft.warnings) && lossyDraft.warnings.length > 0,
      "quantity-less holdings must trigger a completeness warning");
    assert.match(lossyDraft.warnings![0]!, /盛新锂能/);
    assert.match(lossyDraft.warnings![0]!, /不要向用户展示它|重新调用 confirmations\.request/);

    // 用户确认完整草案后只传 confirmationId 执行：股数/成本必须真实落库，
    // 结果回读写入值并附带汇报指令（堵「谎报已记账」）。
    await insertUserMessage("conf-1", "确认", new Date(Date.now() + 1_000));
    const applied = await callServiceTool("portfolio.apply_changes", {
      confirmedByUser: true,
      confirmationId: fullDraft.confirmationId,
    }, context) as {
      ok: boolean;
      applied?: { upsertedHoldings?: Array<{ code: string; shares: number | null; cost: number | null }> };
      reportInstruction?: string;
    };
    assert.equal(applied.ok, true);
    const written = applied.applied?.upsertedHoldings ?? [];
    assert.equal(written.find((item) => item.code === "159567")?.shares, 5000);
    assert.equal(written.find((item) => item.code === "159567")?.cost, 0.671);
    assert.equal(written.find((item) => item.code === "601058")?.shares, 1000);
    assert.ok(applied.reportInstruction, "apply result must carry a report instruction");

    const saved = readMastraPortfolioProjection(userId, instanceId) as {
      holdings?: Array<{ code: string; shares?: number | null; cost?: number | null }>;
    };
    assert.equal(saved.holdings?.find((item) => item.code === "159567")?.shares, 5000);
    assert.equal(saved.holdings?.find((item) => item.code === "159567")?.cost, 0.671);
    assert.equal(saved.holdings?.find((item) => item.code === "601058")?.cost, 13.0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("watchlist.add_many registers one draft and executes the batch with per-item skips (fresh 2026-10-09 regression)", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-watchlist-many-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { db, initDb, sqlite } = await import("../src/db/index.js");
    const { conversationMessages, conversationSessions } = await import("../src/db/schema.js");
    const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");

    const userId = "watchlist-many-user";
    const instanceId = "invest-agent-watchlist-many-user";
    const conversationId = "watchlist-many-conversation";
    const context = { userId, instanceId, projectId: "invest-agent", conversationId, workspacePath: resolveWorkspacePath(userId) };

    initDb();
    await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
    const seedRevision = "2026-10-09T02:00:00.000Z";
    const seedPortfolio = {
      cash: { ratio_percent: 0 },
      holdings: [],
      watchlist: [{ code: "601899", name: "紫金矿业", trigger: "既有", source: "manual", added_at: seedRevision }],
      last_confirmed_at: seedRevision,
    };
    sqlite.prepare(
      `INSERT INTO mastra_portfolio_states (user_id,project_id,instance_id,portfolio_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(userId, "invest-agent", instanceId, JSON.stringify(seedPortfolio), "service-owned://portfolio", "test:seed", seedRevision, "test-seed", seedRevision, seedRevision);
    const now = new Date().toISOString();
    await db.insert(conversationSessions).values({
      conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId,
      channel: "weixin-mobile", title: "Watchlist batch regression", createdAt: now, updatedAt: now,
    });
    const insertUserMessage = (messageId: string, content: string, createdAt: Date) =>
      db.insert(conversationMessages).values({
        messageId, conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId,
        channel: "weixin-mobile", role: "user", content, createdAt: createdAt.toISOString(),
      });

    // 一次登记 3 只（1 只已在池）：批量草案必须成功，不再逼模型逐只登记。
    await insertUserMessage("wl-req-1", "图里这几只全部加入观察仓", new Date(Date.now() - 120_000));
    const draft = await callServiceTool("confirmations.request", {
      operation: "watchlist.add_many",
      payload: {
        items: [
          { code: "000933", name: "神火股份", reason: "来自截图" },
          { code: "560860", name: "工业有色ETF", reason: "来自截图" },
          { code: "601899", name: "紫金矿业", reason: "来自截图" },
        ],
      },
      summary: "批量加入观察仓",
    }, context) as { confirmationId: string };
    assert.ok(draft.confirmationId, "batch draft registration must succeed in one call");

    // 条目畸形在登记端就打回。
    await assert.rejects(
      () => callServiceTool("confirmations.request", {
        operation: "watchlist.add_many",
        payload: { items: [{ code: "bogus", name: "坏代码" }] },
      }, context),
      /6 位数字代码/,
    );
    await assert.rejects(
      () => callServiceTool("confirmations.request", {
        operation: "watchlist.add_many",
        payload: { items: [{ code: "000933" }, { code: "000933" }] },
      }, context),
      /重复/,
    );

    // 确认后执行：2 只新增、1 只跳过，结果逐项明示。
    await insertUserMessage("wl-conf-1", "确认", new Date(Date.now() + 1_000));
    const result = await callServiceTool("watchlist.add_many", {
      confirmedByUser: true,
      confirmationId: draft.confirmationId,
    }, context) as {
      ok: boolean;
      addedCount: number;
      skippedCount: number;
      added: Array<{ code: string }>;
      skipped: Array<{ code: string; reason: string }>;
    };
    assert.equal(result.ok, true);
    assert.equal(result.addedCount, 2);
    assert.equal(result.skippedCount, 1);
    assert.deepEqual(result.added.map((item) => item.code).sort(), ["000933", "560860"]);
    assert.equal(result.skipped[0]!.code, "601899");

    // 全部已存在时登记端直接打回——没有新内容的草案不该进确认流。
    await assert.rejects(
      () => callServiceTool("confirmations.request", {
        operation: "watchlist.add_many",
        payload: { items: [{ code: "000933" }, { code: "601899" }] },
      }, context),
      /已全部在自选池/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
