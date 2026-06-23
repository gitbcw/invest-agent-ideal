// WP4.9 烟测:验证 sqlite 和 workspace 两种 backend 在 propose/get/list/decide 上行为等价。
import { sqliteMethodChangeBackend, workspaceMethodChangeBackend, __resetMethodChangeBackendWorkspaceInitCache } from "../dist/lib/method-change-backend.js";
import { ensureWorkspace } from "../dist/lib/workspace.js";
import { rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../dist/lib/config.js";

const USER = "smoke-mc";
const INSTANCE = "smoke-mc";

async function runCase(backend, label) {
  console.log(`\n=== ${label} ===`);

  // propose 1
  const c1 = await backend.propose({
    userId: USER, instanceId: INSTANCE,
    proposedChange: "调整支撑位阈值", reason: "近期市场波动加剧",
    affectedResource: "methodology_profile",
  });
  console.log("propose 1 id:", c1.id, "status:", c1.status);
  if (c1.status !== "proposed") throw new Error("propose status should be proposed");

  // propose with decisionNote(WP4.9:conversation-tasks 用例)
  const c0 = await backend.propose({
    userId: USER, instanceId: INSTANCE,
    proposedChange: "测试 propose 带 decisionNote", reason: "回归 conversation-tasks 场景",
    affectedResource: "methodology_profile",
    decisionNote: JSON.stringify({ taskId: 42, rawText: "foo" }),
  });
  if (!c0.decisionNote || !c0.decisionNote.includes("rawText")) {
    throw new Error("propose with decisionNote failed");
  }
  console.log("propose c0 decisionNote ok");

  // propose 2
  const c2 = await backend.propose({
    userId: USER, instanceId: INSTANCE,
    proposedChange: "增加换手率信号", reason: "观察到 3 只标的频繁换手",
  });
  console.log("propose 2 id:", c2.id);

  // list all
  const all = await backend.list(USER, INSTANCE, { limit: 10 });
  console.log("list all count:", all.length);
  if (all.length !== 3) throw new Error("list should have 3 candidates");

  // list filter by status
  const proposedOnly = await backend.list(USER, INSTANCE, { status: "proposed", limit: 10 });
  console.log("list proposed count:", proposedOnly.length);
  if (proposedOnly.length !== 3) throw new Error("should have 3 proposed");

  // get
  const got = await backend.get(USER, INSTANCE, c1.id);
  console.log("get c1:", got?.id, got?.status);
  if (!got || got.id !== c1.id) throw new Error("get failed");

  // decide c1 -> confirmed
  const decided = await backend.decide({
    userId: USER, instanceId: INSTANCE,
    id: c1.id, status: "confirmed", decisionNote: "采纳并落地",
  });
  console.log("decide c1:", decided?.status, decided?.decisionNote, decided?.confirmedAt);
  if (!decided || decided.status !== "confirmed") throw new Error("decide failed");
  if (!decided.confirmedAt) throw new Error("confirmedAt should be set");

  // decide c2 -> rejected (no confirmedAt)
  const rejected = await backend.decide({
    userId: USER, instanceId: INSTANCE,
    id: c2.id, status: "rejected",
  });
  if (rejected?.status !== "rejected" || rejected.confirmedAt) throw new Error("reject failed");

  // list after decide(c1 confirmed,c2 rejected,只剩 c0 proposed)
  const afterDecide = await backend.list(USER, INSTANCE, { status: "proposed", limit: 10 });
  console.log("list proposed after decide:", afterDecide.length);
  if (afterDecide.length !== 1 || afterDecide[0].id !== c0.id) {
    throw new Error("only c0 should remain proposed");
  }

  // list confirmed
  const confirmed = await backend.list(USER, INSTANCE, { status: "confirmed", limit: 10 });
  console.log("list confirmed:", confirmed.length);
  if (confirmed.length !== 1 || confirmed[0].id !== c1.id) throw new Error("confirmed list mismatch");

  // get latest version (c1 应该是 confirmed,不是 proposed)
  const latest = await backend.get(USER, INSTANCE, c1.id);
  if (latest?.status !== "confirmed") throw new Error("get should return latest version");

  console.log(`✓ ${label} passed`);
}

// 清理 sqlite 测试数据
import { db } from "../dist/db/index.js";
import { methodChangeCandidates } from "../dist/db/schema.js";
import { eq } from "drizzle-orm";
await db.delete(methodChangeCandidates).where(eq(methodChangeCandidates.userId, USER));

await runCase(sqliteMethodChangeBackend, "sqlite");

__resetMethodChangeBackendWorkspaceInitCache();
await ensureWorkspace({ userId: USER });
// 清空 workspace jsonl,避免 append-only 历史数据污染本次烟测
const methodChangesJsonl = path.join(config.workspace.root, USER, "memory/method_changes.jsonl");
await rm(methodChangesJsonl, { force: true });
await runCase(workspaceMethodChangeBackend, "workspace");

// 清理
await db.delete(methodChangeCandidates).where(eq(methodChangeCandidates.userId, USER));

console.log("\n=== 全部通过 ===");
