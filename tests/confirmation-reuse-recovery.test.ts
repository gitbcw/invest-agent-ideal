import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/** 复刻 2026-09-03 用户 111 确认死循环：兜底模型 glm-5.3-flash 在草案轮不注册
 * 确认，用户确认后每轮重复注册新草案（时间戳被反复推晚，时序校验永远不满足）
 * 且两轮构造的 payload 漂移。修复 = ① confirmations.request 在用户已确认时
 * 复用时序已满足的 pending 草案（丢弃模型漂移变体）；② 执行工具只传
 * confirmationId 时从注册记录恢复已确认草案执行。
 * 口径收窄（2026-09-08 用户 111 三连确认回归）：模型重复注册时必然重写持仓
 * name/notes 自由文本（"稀有金属ETF"→"稀有金属ETF嘉实"、股价估算备注→"2000股"），
 * 全量比对把同一业务草案误判为新草案反复要求再确认。修复 = 复用判定与执行
 * 校验只比业务核心字段，name/notes 不参与确认身份；业务字段漂移仍另立新草案。 */
test("re-registered draft after user confirmation reuses the confirmable pending instead of renewing it (111 2026-09-03 regression)", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-confirm-reuse-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { eq } = await import("drizzle-orm");
    const { db, initDb } = await import("../src/db/index.js");
    const { conversationMessages, conversationSessions, pendingSandboxConfirmations } = await import("../src/db/schema.js");
    const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");
    const { readMastraPortfolioProjection } = await import("../src/lib/mastra-portfolio-backend.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");

    const userId = "confirm-reuse-user";
    const instanceId = "invest-agent-confirm-reuse-user";
    const conversationId = "confirm-reuse-conversation";
    const context = { userId, instanceId, projectId: "invest-agent", conversationId, workspacePath: resolveWorkspacePath(userId) };
    const revision = "2026-08-26T02:01:14.287Z";

    initDb();
    await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
    const seedPortfolio = {
      cash: { ratio_percent: 61, notes: "现金仓位约 61%" },
      holdings: [
        { code: "002460", name: "赣锋锂业", weight: 18, notes: "持仓占比 18%" },
        { code: "002240", name: "盛新锂能", weight: 21, notes: "持仓占比 21%" },
      ],
      watchlist: [],
      accounts: [],
      last_confirmed_at: revision,
      last_confirmed_by: "user",
    };
    (await import("../src/db/index.js")).sqlite.prepare(
      `INSERT INTO mastra_portfolio_states (user_id,project_id,instance_id,portfolio_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(userId, "invest-agent", instanceId, JSON.stringify(seedPortfolio), "service-owned://portfolio", "test:seed", revision, "test-seed", revision, revision);
    const now = new Date().toISOString();
    await db.insert(conversationSessions).values({
      conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId,
      channel: "weixin-mobile", title: "Confirmation reuse regression", createdAt: now, updatedAt: now,
    });

    const insertUserMessage = (messageId: string, content: string, createdAt: Date) =>
      db.insert(conversationMessages).values({
        messageId, conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId,
        channel: "weixin-mobile", role: "user", content, createdAt: createdAt.toISOString(),
      });

    const draftPayload = {
      expectedLastConfirmedAt: revision,
      upsertHoldings: [
        { code: "562800", name: "稀有金属ETF", weight: 7 },
        { code: "601058", name: "赛轮轮胎", weight: 5 },
      ],
      cashRatioPercent: 49,
    };

    // 正常草案轮：调仓请求消息后注册，无 warning。
    await insertUserMessage("reuse-request", "更新持仓，加入7%稀有金属ETF和5%赛轮轮胎", new Date(Date.now() - 120_000));
    const draft = await callServiceTool("confirmations.request", {
      operation: "portfolio.apply_changes",
      payload: draftPayload,
      summary: "调仓草案",
    }, context) as { confirmationId: string; warning?: string };
    assert.equal(draft.warning, undefined);

    // 用户确认消息（晚于草案注册）。
    await insertUserMessage("reuse-confirm", "确认", new Date(Date.now() + 1_000));

    // 事故行为 ①：模型在用户确认后重复注册同一草案 —— 必须复用，不得新建。
    const reRegistered = await callServiceTool("confirmations.request", {
      operation: "portfolio.apply_changes",
      payload: draftPayload,
      summary: "重复注册",
    }, context) as { confirmationId: string; reused?: boolean; instruction?: string; warning?: string };
    assert.equal(reRegistered.confirmationId, draft.confirmationId, "re-registering the same draft must reuse the pending confirmation");
    assert.equal(reRegistered.reused, true);
    assert.ok(reRegistered.instruction, "the reused registration must tell the model to execute now");

    // 事故行为 ②：模型注册漂移变体（全量重写形态）—— 不劫持（正常新建），
    // 但 warning 必须指路用户确认已覆盖的旧草案，终结「在新草案上反复要确认」。
    const drifted = await callServiceTool("confirmations.request", {
      operation: "portfolio.apply_changes",
      payload: {
        ...draftPayload,
        upsertHoldings: [
          { code: "002460", name: "赣锋锂业", weight: 18, notes: "持仓占比 18%" },
          { code: "002240", name: "盛新锂能", weight: 21, notes: "持仓占比 21%" },
          { code: "562800", name: "稀有金属ETF", weight: 7 },
          { code: "601058", name: "赛轮轮胎", weight: 5 },
        ],
      },
      summary: "漂移变体",
    }, context) as { confirmationId: string; reused?: boolean; warning?: string };
    assert.notEqual(drifted.confirmationId, draft.confirmationId, "a genuinely different draft must be registered as new, not hijacked");
    assert.equal(drifted.reused, undefined);
    assert.match(drifted.warning!, new RegExp(draft.confirmationId), "the warning must point at the executable confirmed draft");

    const pendingAfterDrift = await db.select().from(pendingSandboxConfirmations).where(eq(pendingSandboxConfirmations.userId, userId));
    assert.equal(pendingAfterDrift.filter((row) => row.status === "pending").length, 2, "same-draft re-registration stays at one pending; only a genuinely new draft adds one");

    // 事故行为 ③ 的解药：模型只传 confirmationId 执行 —— 从注册记录恢复草案执行。
    const applied = await callServiceTool("portfolio.apply_changes", {
      confirmedByUser: true,
      confirmationId: draft.confirmationId,
    }, context) as { ok: boolean };
    assert.equal(applied.ok, true);

    const saved = readMastraPortfolioProjection(userId, instanceId) as {
      holdings?: Array<{ code: string; weight?: number }>;
      cash?: { ratio_percent?: number };
    };
    assert.equal(saved.holdings?.find((item) => item.code === "562800")?.weight, 7, "the registered draft (not the drifted variant) must be what gets executed");
    assert.equal(saved.holdings?.find((item) => item.code === "601058")?.weight, 5);
    assert.equal(saved.cash?.ratio_percent, 49);
    const [consumed] = await db.select().from(pendingSandboxConfirmations).where(eq(pendingSandboxConfirmations.id, draft.confirmationId));
    assert.equal(consumed.status, "confirmed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/** 安全不变量保持：确认后重复注册带漂移变体被丢弃 ≠ 允许执行漂移内容。
 * 模型显式带上不一致参数执行时仍必须被拒。 */
test("apply with an explicit drifted payload is still rejected after the reuse fix", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-confirm-mismatch-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { eq } = await import("drizzle-orm");
    const { db, initDb } = await import("../src/db/index.js");
    const { conversationMessages, conversationSessions } = await import("../src/db/schema.js");
    const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");
    const { readMastraPortfolioProjection } = await import("../src/lib/mastra-portfolio-backend.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");

    const userId = "confirm-mismatch-user";
    const instanceId = "invest-agent-confirm-mismatch-user";
    const conversationId = "confirm-mismatch-conversation";
    const context = { userId, instanceId, projectId: "invest-agent", conversationId, workspacePath: resolveWorkspacePath(userId) };
    const revision = "2026-08-26T02:01:14.287Z";

    initDb();
    await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
    const seedPortfolio = {
      cash: { ratio_percent: 82, notes: "现金 82%" },
      holdings: [{ code: "002460", name: "赣锋锂业", weight: 18 }],
      watchlist: [], accounts: [],
      last_confirmed_at: revision, last_confirmed_by: "user",
    };
    (await import("../src/db/index.js")).sqlite.prepare(
      `INSERT INTO mastra_portfolio_states (user_id,project_id,instance_id,portfolio_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(userId, "invest-agent", instanceId, JSON.stringify(seedPortfolio), "service-owned://portfolio", "test:seed", revision, "test-seed", revision, revision);
    const now = new Date().toISOString();
    await db.insert(conversationSessions).values({
      conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId,
      channel: "weixin-mobile", title: "Mismatch safety regression", createdAt: now, updatedAt: now,
    });
    const insertUserMessage = (messageId: string, content: string, createdAt: Date) =>
      db.insert(conversationMessages).values({
        messageId, conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId,
        channel: "weixin-mobile", role: "user", content, createdAt: createdAt.toISOString(),
      });

    const draftPayload = { expectedLastConfirmedAt: revision, upsertHoldings: [{ code: "562800", name: "稀有金属ETF", weight: 7, notes: "按 2026-09-08 11:23 价格估算" }], cashRatioPercent: 75 };
    await insertUserMessage("mismatch-request", "加 7% 稀有金属ETF", new Date(Date.now() - 120_000));
    const draft = await callServiceTool("confirmations.request", { operation: "portfolio.apply_changes", payload: draftPayload }, context) as { confirmationId: string };
    await insertUserMessage("mismatch-confirm", "确认", new Date(Date.now() + 1_000));

    await assert.rejects(
      () => callServiceTool("portfolio.apply_changes", {
        confirmedByUser: true,
        confirmationId: draft.confirmationId,
        ...draftPayload,
        upsertHoldings: [{ code: "601058", name: "赛轮轮胎", weight: 5 }],
        cashRatioPercent: 77,
      }, context),
      (error: unknown) => {
        assert.match((error as Error).message, /payload mismatch/);
        return true;
      }
    );
    const unchanged = readMastraPortfolioProjection(userId, instanceId) as { holdings?: Array<{ code: string }> };
    assert.equal(unchanged.holdings?.find((item) => item.code === "601058"), undefined, "the drifted explicit payload must not be executed");

    // 自由文本漂移执行（2026-09-08 口径）：业务字段与注册草案完全一致、仅
    // name/notes 被模型改写时，执行比对必须放行——否则复用放行后模型带全量
    // 参数执行会在最后一步再次被 payload mismatch 拒掉。
    const freeTextApplied = await callServiceTool("portfolio.apply_changes", {
      confirmedByUser: true,
      confirmationId: draft.confirmationId,
      ...draftPayload,
      upsertHoldings: [{ code: "562800", name: "稀有金属ETF嘉实", weight: 7, notes: "改写的自由文本备注" }],
      cashRatioPercent: 75,
    }, context) as { ok: boolean };
    assert.equal(freeTextApplied.ok, true, "an explicit payload differing only in holding name/notes must be executable");
    const written = readMastraPortfolioProjection(userId, instanceId) as { holdings?: Array<{ code: string; weight?: number }> };
    assert.equal(written.holdings?.find((item) => item.code === "562800")?.weight, 7);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/** 复刻 2026-09-08 用户 111 三连确认：terra 草案轮注册了带股数与股价估算备注
 * 的完整草案，确认轮落到 glm-5.3-flash 后每轮重复注册自己重构的变体——备注被
 * 改写（"按…价格估算市值…"→"2000股"）、名称加后缀（"稀有金属ETF"→"稀有金属
 * ETF嘉实"）。全量比对把同一业务草案判为新草案，注册时间被推晚到用户确认之后，
 * 时序校验连拒两次。修复 = 复用判定忽略持仓 name/notes；业务字段（权重/股数/
 * 代码/现金）漂移仍另立新草案等用户再确认。 */
test("free-text drift reuses the confirmed draft; business-field drift still registers a new one (111 2026-09-08 regression)", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-confirm-freetext-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { eq } = await import("drizzle-orm");
    const { db, initDb } = await import("../src/db/index.js");
    const { conversationMessages, conversationSessions, pendingSandboxConfirmations } = await import("../src/db/schema.js");
    const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");
    const { readMastraPortfolioProjection } = await import("../src/lib/mastra-portfolio-backend.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");

    const userId = "confirm-freetext-user";
    const instanceId = "invest-agent-confirm-freetext-user";
    const conversationId = "confirm-freetext-conversation";
    const context = { userId, instanceId, projectId: "invest-agent", conversationId, workspacePath: resolveWorkspacePath(userId) };
    const revision = "2026-08-26T02:01:14.287Z";

    initDb();
    await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
    const seedPortfolio = {
      cash: { ratio_percent: 61, notes: "现金仓位约 61%" },
      holdings: [
        { code: "002460", name: "赣锋锂业", weight: 18, notes: "持仓占比 18%" },
        { code: "002240", name: "盛新锂能", weight: 21, notes: "持仓占比 21%" },
      ],
      watchlist: [],
      accounts: [],
      last_confirmed_at: revision,
      last_confirmed_by: "user",
    };
    (await import("../src/db/index.js")).sqlite.prepare(
      `INSERT INTO mastra_portfolio_states (user_id,project_id,instance_id,portfolio_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(userId, "invest-agent", instanceId, JSON.stringify(seedPortfolio), "service-owned://portfolio", "test:seed", revision, "test-seed", revision, revision);
    const now = new Date().toISOString();
    await db.insert(conversationSessions).values({
      conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId,
      channel: "weixin-mobile", title: "Free-text drift reuse regression", createdAt: now, updatedAt: now,
    });
    const insertUserMessage = (messageId: string, content: string, createdAt: Date) =>
      db.insert(conversationMessages).values({
        messageId, conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId,
        channel: "weixin-mobile", role: "user", content, createdAt: createdAt.toISOString(),
      });

    // 草案轮（terra 形态）：股数 + 股价估算备注齐全。
    const draftPayload = {
      expectedLastConfirmedAt: revision,
      upsertHoldings: [
        { code: "002460", name: "赣锋锂业", weight: 22, shares: 1200, notes: "按2026-09-08 11:23价格49.25元估算市值59,100元" },
        { code: "562800", name: "稀有金属ETF", weight: 5, shares: 15000, notes: "按2026-09-08 11:23价格0.912元估算市值13,680元" },
      ],
      cashRatioPercent: 52,
    };

    await insertUserMessage("freetext-request", "按份额更新持仓并记录股数", new Date(Date.now() - 120_000));
    const draft = await callServiceTool("confirmations.request", {
      operation: "portfolio.apply_changes",
      payload: draftPayload,
      summary: "调仓草案",
    }, context) as { confirmationId: string; warning?: string };
    assert.equal(draft.warning, undefined);

    await insertUserMessage("freetext-confirm", "确认", new Date(Date.now() + 1_000));

    // 事故行为（9-08 草案②形态）：确认后重复注册，业务字段全同、仅 name/notes
    // 被改写 —— 必须复用已确认草案，不得新建把注册时间推晚。
    const freeTextDrift = await callServiceTool("confirmations.request", {
      operation: "portfolio.apply_changes",
      payload: {
        expectedLastConfirmedAt: revision,
        upsertHoldings: [
          { code: "002460", name: "赣锋锂业", weight: 22, shares: 1200, notes: "1200股" },
          { code: "562800", name: "稀有金属ETF嘉实", weight: 5, shares: 15000, notes: "15000份" },
        ],
        cashRatioPercent: 52,
      },
      summary: "自由文本漂移变体",
    }, context) as { confirmationId: string; reused?: boolean; instruction?: string };
    assert.equal(freeTextDrift.confirmationId, draft.confirmationId, "a name/notes-only drift must reuse the confirmed draft");
    assert.equal(freeTextDrift.reused, true);
    assert.ok(freeTextDrift.instruction, "the reused registration must tell the model to execute now");

    // 对照：业务字段漂移（权重 5→8、现金 52→49）—— 仍是另一个草案，正常新建
    // 并指路旧确认，不得劫持。
    const businessDrift = await callServiceTool("confirmations.request", {
      operation: "portfolio.apply_changes",
      payload: {
        expectedLastConfirmedAt: revision,
        upsertHoldings: [
          { code: "002460", name: "赣锋锂业", weight: 22, shares: 1200 },
          { code: "562800", name: "稀有金属ETF", weight: 8, shares: 15000 },
        ],
        cashRatioPercent: 49,
      },
      summary: "业务字段漂移变体",
    }, context) as { confirmationId: string; reused?: boolean; warning?: string };
    assert.notEqual(businessDrift.confirmationId, draft.confirmationId, "a business-field drift is a genuinely new draft");
    assert.equal(businessDrift.reused, undefined);
    assert.match(businessDrift.warning!, new RegExp(draft.confirmationId), "the warning must point at the executable confirmed draft");

    const pendingAfterDrift = await db.select().from(pendingSandboxConfirmations).where(eq(pendingSandboxConfirmations.userId, userId));
    assert.equal(pendingAfterDrift.filter((row) => row.status === "pending").length, 2, "free-text drift must not add a pending; only the business-field drift does");

    // 只传 confirmationId 执行已确认草案：写入的必须是注册记录（股数保留），
    // 而不是任何漂移变体。
    const applied = await callServiceTool("portfolio.apply_changes", {
      confirmedByUser: true,
      confirmationId: draft.confirmationId,
    }, context) as { ok: boolean };
    assert.equal(applied.ok, true);

    const saved = readMastraPortfolioProjection(userId, instanceId) as {
      holdings?: Array<{ code: string; weight?: number; shares?: number | null }>;
      cash?: { ratio_percent?: number };
    };
    assert.equal(saved.holdings?.find((item) => item.code === "562800")?.weight, 5, "the registered draft must be what gets executed");
    assert.equal(saved.holdings?.find((item) => item.code === "562800")?.shares, 15000, "shares recorded in the confirmed draft must be persisted");
    assert.equal(saved.holdings?.find((item) => item.code === "002460")?.shares, 1200);
    assert.equal(saved.cash?.ratio_percent, 52);
    const [consumed] = await db.select().from(pendingSandboxConfirmations).where(eq(pendingSandboxConfirmations.id, draft.confirmationId));
    assert.equal(consumed.status, "confirmed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
