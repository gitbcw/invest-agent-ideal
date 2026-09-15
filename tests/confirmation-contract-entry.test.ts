import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/** T-506 P0（owner 2026-09-15 审查定案）：confirmations.request 登记入口按操作做
 * 字段契约校验。复现背景——9-13 mg 29 连拒 + 9-14 mgreplay 三模型复现：模型自造
 * schema（change_type/new_text/document 等形状）的畸形草案能通过登记，确认后陷入
 * A（只传 ID→恢复畸形草案缺字段）/B（重写全字段→永不匹配）双死路。契约让畸形
 * 草案在登记时即被可操作错误打回，模型同轮修正重新登记。 */

test("confirmation contract rejects schema-invented drafts with actionable errors (unit)", async () => {
  const { validateConfirmationContract } = await import("../src/lib/confirmation-contract.js");

  // 9-13 / terra 复现形状：文档编辑式自造 schema，缺 proposedChange/reason 且带契约外字段。
  const terraShape = validateConfirmationContract("method_changes.propose", {
    change_type: "replace", old_text: "强势股可追涨", new_text: "涨停次日不追高",
    target_files: ["methods/strategy-rules.md"], title: "纪律修订",
  });
  assert.equal(terraShape.ok, false);
  if (!terraShape.ok) {
    assert.match(terraShape.error, /缺少必填字段 proposedChange/);
    assert.match(terraShape.error, /缺少必填字段 reason/);
    assert.match(terraShape.error, /存在契约外字段：change_type、old_text、new_text、target_files、title/);
    assert.match(terraShape.error, /允许的字段：proposedChange、reason/);
    assert.match(terraShape.error, /重新调用 confirmations\.request/);
  }

  // glm 复现形状：proposedChange 传成 JSON 对象（对象/字符串漂移）。
  const objectShape = validateConfirmationContract("method_changes.propose", {
    proposedChange: { change_type: "replace", new_rule: "涨停次日不追高" },
    reason: "近期追涨连续止损",
  });
  assert.equal(objectShape.ok, false);
  if (!objectShape.ok) assert.match(objectShape.error, /字段 proposedChange 必须是字符串（当前是 object）/);

  // 合法草案通过。
  const valid = validateConfirmationContract("method_changes.propose", {
    proposedChange: "在技术分析方法中以「涨停次日不追高」替换「强势股可追涨」",
    reason: "近期追涨连续止损",
  });
  assert.equal(valid.ok, true);

  // watchlist.add：别名 stockCode 可用，code 格式校验与执行处理器同口径。
  assert.equal(validateConfirmationContract("watchlist.add", { stockCode: "600519", name: "贵州茅台" }).ok, true);
  const badCode = validateConfirmationContract("watchlist.add", { code: "sh600519" });
  assert.equal(badCode.ok, false);
  if (!badCode.ok) assert.match(badCode.error, /6 位数字代码/);

  // plans.watch_conditions：conditions 必填。
  const noConditions = validateConfirmationContract("plans.watch_conditions", { stockCode: "600519" });
  assert.equal(noConditions.ok, false);
  if (!noConditions.ok) assert.match(noConditions.error, /缺少必填字段 conditions/);

  // watch_rules.create：params 传数组（类型错）被拒；targetScope 可省（默认 manual）。
  const badParams = validateConfirmationContract("watch_rules.create", {
    stockCode: "600519", ruleType: "price_above", params: [1, 2],
  });
  assert.equal(badParams.ok, false);
  if (!badParams.ok) assert.match(badParams.error, /字段 params 必须是对象（当前是 数组）/);
  assert.equal(validateConfirmationContract("watch_rules.create", {
    stockCode: "600519", ruleType: "price_above", params: { threshold: 10 },
  }).ok, true);

  // 无契约操作（语义级校验已存在）放行。
  assert.equal(validateConfirmationContract("portfolio.apply_changes", { any: "shape" }).ok, true);
});

test("confirmations.request entry rejects malformed method_changes.propose drafts and registers valid ones (integration)", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-confirm-contract-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { db, initDb } = await import("../src/db/index.js");
    const { conversationSessions, pendingSandboxConfirmations } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
    const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");

    const userId = "confirm-contract-test";
    const instanceId = "invest-agent-confirm-contract-test";
    const conversationId = "confirm-contract-conversation";
    const context = { userId, instanceId, projectId: "invest-agent", conversationId, workspacePath: resolveWorkspacePath(userId) };

    initDb();
    await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
    const now = new Date().toISOString();
    await db.insert(conversationSessions).values({
      conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId,
      channel: "web", title: "Confirmation contract entry", createdAt: now, updatedAt: now,
    });

    // 9-13 形状的畸形草案在登记入口被拒，且错误可操作（列出契约外字段与允许字段）。
    await assert.rejects(
      () => callServiceTool("confirmations.request", {
        operation: "method_changes.propose",
        payload: {
          change_type: "replace_or_add", document: "methods/strategy-rules.md",
          target_files: ["methods/strategy-rules.md"], title: "纪律修订", update_existing: true,
        },
        summary: "方法修改草案",
      }, context),
      (error: unknown) => {
        assert.match(String(error), /字段契约/);
        assert.match(String(error), /缺少必填字段 proposedChange/);
        assert.match(String(error), /契约外字段/);
        return true;
      },
    );
    // 拒绝发生在登记之前：不产生 pending 记录。
    const pendings = await db.select().from(pendingSandboxConfirmations).where(eq(pendingSandboxConfirmations.userId, userId));
    assert.equal(pendings.length, 0);

    // 合法草案正常登记（回归：契约不得误伤正常流程）。
    const requested = await callServiceTool("confirmations.request", {
      operation: "method_changes.propose",
      payload: {
        proposedChange: "在技术分析方法中以「涨停次日不追高」替换「强势股可追涨」",
        reason: "近期追涨连续止损",
      },
      summary: "方法修改草案",
    }, context) as { ok: boolean; confirmationId: string };
    assert.equal(requested.ok, true);
    const [pending] = await db.select().from(pendingSandboxConfirmations).where(eq(pendingSandboxConfirmations.id, requested.confirmationId));
    assert.ok(pending, "valid draft must be registered");
    const stored = JSON.parse(pending.requestBody ?? "{}");
    assert.equal(stored.proposedChange, "在技术分析方法中以「涨停次日不追高」替换「强势股可追涨」");
    assert.equal(stored.reason, "近期追涨连续止损");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
