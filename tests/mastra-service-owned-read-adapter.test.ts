import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("Mastra backend reads scoped portfolio projections and daily records without Workspace fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-service-owned-read-"));
  const dbPath = path.join(root, "target.db");
  try {
    const script = String.raw`
      const database = (await import("./src/db/index.ts")).default;
      const { initDb, sqlite } = database;
      initDb();
      sqlite.prepare("INSERT INTO mastra_portfolio_states (user_id,project_id,instance_id,portfolio_json,source_path,source_checksum,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
        "alice", "invest-agent", "invest-agent-alice", JSON.stringify({
          holdings: [
            { code: "000001", name: "平安银行", buy_date: "2026-08-01", cost_price: 10, status: "open" },
            { code: "000002", name: "万科A", buy_date: "2026-07-01", cost_price: 8, sell_date: "2026-08-02", sell_price: 7, status: "closed" },
          ],
          watchlist: [{ code: "600000", name: "浦发银行", trigger: "观察", added_at: "2026-08-01T00:00:00Z", source: "test" }],
          stockPlans: [{ code: "600001", name: "邯郸钢铁", target_price: 5.2, stop_loss: 4.1, plan_type: "watch" }],
        }), "config/portfolio.yaml", "source", "batch", new Date().toISOString(), new Date().toISOString()
      );
      sqlite.prepare("INSERT INTO mastra_review_memory_records (record_id,user_id,project_id,instance_id,record_type,business_key,payload_json,source_path,source_checksum,migration_batch_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
        "daily-1", "alice", "invest-agent", "invest-agent-alice", "daily_plan", "2026-08-01", JSON.stringify({ plan_date: "2026-08-01", generated_at: "2026-08-01T01:00:00Z", summary: "s1", content: "c1", data: { ok: true } }), "plans/daily/2026-08-01.yaml", "source", "batch", new Date().toISOString()
      );
      sqlite.prepare("INSERT INTO mastra_review_memory_records (record_id,user_id,project_id,instance_id,record_type,business_key,payload_json,source_path,source_checksum,migration_batch_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
        "daily-2", "alice", "invest-agent", "invest-agent-alice", "daily_plan", "2026-08-02", JSON.stringify({ plan_date: "2026-08-02", generated_at: "2026-08-02T01:00:00Z", summary: "s2", content: "c2", data: null }), "plans/daily/2026-08-02.yaml", "source", "batch", new Date().toISOString()
      );
      const backends = (await import("./src/lib/data-backend.ts")).default;
      const { ACTIVE_BACKEND, portfolioBackend, watchlistBackend, planBackend } = backends;
      const dailyPlanBackend = (await import("./src/lib/daily-plan-backend.ts")).default.dailyPlanBackend;
      assert.equal(ACTIVE_BACKEND, "mastra");
      assert.equal((await portfolioBackend.listActive("alice", "invest-agent-alice")).length, 1);
      assert.equal((await portfolioBackend.listAll("alice", "invest-agent-alice")).length, 2);
      assert.equal((await watchlistBackend.list("alice", "invest-agent-alice"))[0].code, "600000");
      assert.equal((await planBackend.find("alice", "invest-agent-alice", "600001"))?.targetPrice, 5.2);
      assert.equal((await dailyPlanBackend.getLatest("alice", "invest-agent-alice"))?.planDate, "2026-08-02");
      assert.equal((await dailyPlanBackend.getPrevious("alice", "invest-agent-alice", "2026-08-02"))?.planDate, "2026-08-01");
      const inserted = await portfolioBackend.upsertActive("alice", "invest-agent-alice", { code: "000003", name: "招商银行", costPrice: 12 });
      assert.equal(inserted.code, "000003");
      assert.equal((await portfolioBackend.listActive("alice", "invest-agent-alice")).length, 2);
      const revision = sqlite.prepare("SELECT source_revision AS sourceRevision FROM mastra_portfolio_states WHERE user_id='alice' AND instance_id='invest-agent-alice'").get().sourceRevision;
      await assert.rejects(() => portfolioBackend.upsertActive("alice", "invest-agent-alice", { code: "000004", name: "建设银行", expectedRevision: "stale" }), /MASTRA_REVISION_CONFLICT/);
      await portfolioBackend.upsertActive("alice", "invest-agent-alice", { code: "000004", name: "建设银行", expectedRevision: revision });
      await portfolioBackend.recordTradeAction({ userId: "alice", instanceId: "invest-agent-alice", code: "000003", action: "buy", price: 12, createdAt: "2026-08-03T00:00:00Z" });
      assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mastra_review_memory_records WHERE record_type='service_event' AND user_id='alice'").get().count, 1);
      assert.equal((await watchlistBackend.add("alice", "invest-agent-alice", { code: "000003", name: "招商银行" })).code, "000003");
      assert.equal((await planBackend.upsert("alice", "invest-agent-alice", { code: "000003", name: "招商银行", targetPrice: 13 })).targetPrice, 13);
      await dailyPlanBackend.upsert("alice", "invest-agent-alice", { planDate: "2026-08-03", generatedAt: "now", content: "x", data: null });
      assert.equal((await dailyPlanBackend.get("alice", "invest-agent-alice", "2026-08-03"))?.content, "x");
      // A user without a projection row behaves like a fresh workspace: writes
      // lazily create the row instead of failing closed.
      const bobHolding = await portfolioBackend.upsertActive("bob", "invest-agent-bob", { code: "000005", name: "兴业银行" });
      assert.equal(bobHolding.code, "000005");
      assert.equal((await portfolioBackend.listActive("bob", "invest-agent-bob")).length, 1);
      assert.ok(sqlite.prepare("SELECT 1 AS one FROM mastra_portfolio_states WHERE user_id='bob' AND instance_id='invest-agent-bob' AND source_path='service-owned://portfolio'").get());
      const methodChange = (await import("./src/lib/method-change-backend.ts")).default.methodChangeBackend;
      const viewpoints = (await import("./src/lib/review-viewpoint-backend.ts")).default.reviewViewpointBackend;
      assert.equal((await methodChange.list("alice", "invest-agent-alice", {})).length, 0);
      assert.deepEqual(await viewpoints.list("alice", "invest-agent-alice", {}), []);
      const candidate = await methodChange.propose({ userId: "alice", instanceId: "invest-agent-alice", proposedChange: "x", reason: "x" });
      assert.equal((await methodChange.get("alice", "invest-agent-alice", candidate.id))?.proposedChange, "x");
      assert.equal((await methodChange.decide({ userId: "alice", instanceId: "invest-agent-alice", id: candidate.id, status: "confirmed" }))?.status, "confirmed");
      const replaced = await viewpoints.replaceByDate({ userId: "alice", instanceId: "invest-agent-alice", sourceDate: "2026-08-03", viewpoints: [{ viewpointId: "v1", view: "view", reason: "reason", action: "hold", validation: "check", expectedReviewDate: "2026-08-04" }] });
      assert.equal(replaced[0]?.viewpointId, "v1");
      assert.equal((await viewpoints.resolve({ userId: "alice", instanceId: "invest-agent-alice", viewpointId: "v1", sourceDate: "2026-08-03", status: "validated", resolution: "ok" }))?.status, "validated");
      assert.deepEqual(await portfolioBackend.listActive("carol", "invest-agent-carol"), []);
      assert.deepEqual(await watchlistBackend.list("carol", "invest-agent-carol"), []);
      sqlite.close();
    `;
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "test", DB_PATH: dbPath, WORKSPACE_BACKEND: "mastra", RUNTIME_DATA_ROOT: path.join(root, "runtime"), WORKSPACE_ROOT: path.join(root, "workspaces") },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Portal health makes asset capabilities primary while retaining workspace compatibility", async () => {
  const { PORTAL_HEALTH_CAPABILITIES } = await import("../src/routes/portal.js");
  assert.ok(PORTAL_HEALTH_CAPABILITIES.indexOf("asset.list") < PORTAL_HEALTH_CAPABILITIES.indexOf("workspace.file.list"));
  assert.ok(PORTAL_HEALTH_CAPABILITIES.includes("asset.get"));
  assert.ok(PORTAL_HEALTH_CAPABILITIES.includes("workspace.file.get"));
});
