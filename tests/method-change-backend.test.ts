import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/db/index.js";
import { methodChangeCandidates } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { sqliteMethodChangeBackend as backend } from "../src/lib/method-change-backend.js";

const USER_ID = "test-method-change-user";
const INSTANCE_ID = "test-instance";

async function seedProposedAged(daysAgo: number, proposedChange: string): Promise<string> {
  const now = new Date();
  const created = new Date(now.getTime() - daysAgo * 24 * 3600 * 1000).toISOString();
  const [row] = await db.insert(methodChangeCandidates).values({
    userId: USER_ID,
    instanceId: INSTANCE_ID,
    sourceType: "review",
    proposedChange,
    reason: "test fixture",
    affectedResource: "methodology_profile",
    status: "proposed",
    createdAt: created,
    updatedAt: created,
  }).returning();
  return String(row.id);
}

async function clearFixtures(): Promise<void> {
  await db.delete(methodChangeCandidates).where(eq(methodChangeCandidates.userId, USER_ID));
}

describe("method-change-backend maxAgeDays filter", { concurrency: false }, () => {
  beforeEach(async () => { await clearFixtures(); });
  afterEach(async () => { await clearFixtures(); });

  it("默认不传 maxAgeDays:返回全部 proposed 候选(不论多老)", async () => {
    await seedProposedAged(0.1, "fresh candidate");
    await seedProposedAged(30, "stale candidate");
    const list = await backend.list(USER_ID, INSTANCE_ID, { status: "proposed" });
    assert.equal(list.length, 2, "无 maxAgeDays 时应返回全部 2 条");
  });

  it("maxAgeDays=7:仅返回 7 天内的 proposed 候选,过滤掉更老的", async () => {
    await seedProposedAged(1, "fresh 1d");
    await seedProposedAged(6, "fresh 6d");
    await seedProposedAged(8, "stale 8d");
    await seedProposedAged(30, "stale 30d");
    const list = await backend.list(USER_ID, INSTANCE_ID, { status: "proposed", maxAgeDays: 7 });
    assert.equal(list.length, 2, "maxAgeDays=7 应过滤掉 8d 和 30d");
    const changes = list.map((r) => r.proposedChange).sort();
    assert.deepEqual(changes, ["fresh 1d", "fresh 6d"]);
  });

  it("maxAgeDays 边界:恰好 7 天前后于毫秒抖动不可靠,改测 7 天 + 1 小时这种明显超窗口的", async () => {
    await seedProposedAged(7, "boundary 7d (毫秒抖动内可能被返回)");
    await seedProposedAged(7.05, "just over 7d");  // 7 天 + ~1 小时
    const list = await backend.list(USER_ID, INSTANCE_ID, { status: "proposed", maxAgeDays: 7 });
    // 7.05 天前的应被过滤,7 天边界附近可能 0 或 1,关键是更老的肯定被过滤
    assert.ok(list.length <= 1, `最多 1 条(7d 边界可能漏),实际 ${list.length}`);
    assert.ok(!list.some((r) => r.proposedChange === "just over 7d"), "7.05 天前的应被过滤");
  });

  it("maxAgeDays=0 或负数:等价于不过滤", async () => {
    await seedProposedAged(60, "very old");
    const list = await backend.list(USER_ID, INSTANCE_ID, { status: "proposed", maxAgeDays: 0 });
    assert.equal(list.length, 1, "maxAgeDays=0 等价于无过滤");
  });
});
