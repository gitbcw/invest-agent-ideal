// WP4.7 烟测:验证 sqlite 和 workspace 两种 backend 在 upsert/get/getPrevious/listInRange/getLatest 上行为等价。
import { sqliteDailyPlanBackend, workspaceDailyPlanBackend, __resetDailyPlanBackendWorkspaceInitCache } from "../dist/lib/daily-plan-backend.js";
import { ensureWorkspace } from "../dist/lib/workspace.js";

const USER = "smoke-test";
const INSTANCE = "smoke-test";

async function runCase(backend, label) {
  console.log(`\n=== ${label} ===`);

  // upsert day1
  await backend.upsert(USER, INSTANCE, {
    planDate: "2026-06-01",
    generatedAt: "2026-06-01T10:00:00Z",
    summary: "day1 summary",
    content: "day1 content",
    data: { items: [{ code: "000001", name: "平安银行", support: 10.5 }] },
  });

  // upsert day2
  await backend.upsert(USER, INSTANCE, {
    planDate: "2026-06-02",
    generatedAt: "2026-06-02T10:00:00Z",
    summary: "day2 summary",
    content: "day2 content",
    data: { items: [] },
  });

  // get
  const got1 = await backend.get(USER, INSTANCE, "2026-06-01");
  console.log("get(2026-06-01):", got1?.planDate, got1?.content, JSON.stringify(got1?.data));
  if (got1?.planDate !== "2026-06-01") throw new Error("get failed");
  if (got1.content !== "day1 content") throw new Error("content mismatch");

  // getPrevious (before 2026-06-02 → day1)
  const prev = await backend.getPrevious(USER, INSTANCE, "2026-06-02");
  console.log("getPrevious(2026-06-02):", prev?.planDate);
  if (prev?.planDate !== "2026-06-01") throw new Error("getPrevious failed");

  // listInRange
  const list = await backend.listInRange(USER, INSTANCE, "2026-06-01", "2026-06-05");
  console.log("listInRange(2026-06-01~05) count:", list.length, "order:", list.map(r => r.planDate).join(","));
  if (list.length !== 2) throw new Error("listInRange count mismatch");
  if (list[0].planDate !== "2026-06-02") throw new Error("listInRange order should be desc");

  // getLatest
  const latest = await backend.getLatest(USER, INSTANCE);
  console.log("getLatest:", latest?.planDate);
  if (latest?.planDate !== "2026-06-02") throw new Error("getLatest failed");

  // upsert 覆盖
  await backend.upsert(USER, INSTANCE, {
    planDate: "2026-06-02",
    generatedAt: "2026-06-02T15:00:00Z",
    summary: "day2 v2",
    content: "day2 content v2",
    data: { items: [{ code: "600519" }] },
  });
  const updated = await backend.get(USER, INSTANCE, "2026-06-02");
  console.log("after upsert:", updated?.generatedAt, updated?.summary);
  if (updated?.summary !== "day2 v2") throw new Error("upsert overwrite failed");

  console.log(`✓ ${label} passed`);
}

// sqlite 路径
await runCase(sqliteDailyPlanBackend, "sqlite");

// workspace 路径(必须先 ensureWorkspace)
__resetDailyPlanBackendWorkspaceInitCache();
await ensureWorkspace({ userId: USER });
await runCase(workspaceDailyPlanBackend, "workspace");

console.log("\n=== 全部通过 ===");
