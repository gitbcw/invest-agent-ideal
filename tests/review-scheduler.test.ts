import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const USER_ID = "review-scheduler-test-user";
const INSTANCE_ID = "review-scheduler:test/instance";
let workspaceRoot = "";

describe("review scheduler prepare/push split", { concurrency: false }, () => {
  before(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "invest-agent-review-scheduler-"));
    process.env.WORKSPACE_ROOT = workspaceRoot;
    const workspace = join(workspaceRoot, USER_ID);
    await mkdir(join(workspace, "config"), { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "# test workspace\n", "utf-8");
    await writeFile(join(workspace, "config", "schedules.yaml"), [
      "run_policy:",
      "  skip_automatic_if_manual_report_exists: false",
      "daily_review:",
      "  enabled: true",
      "  auto_run: true",
      "  default_time: \"21:30\"",
      "weekly_review:",
      "  enabled: false",
      "monthly_review:",
      "  enabled: false",
      "",
    ].join("\n"), "utf-8");
  });

  after(async () => {
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("detects a daily review prepare window using the lead time", async () => {
    const { __test__ } = await import("../src/scheduler/review.js");
    const prepare = await __test__.shouldPrepare("daily", {
      userId: USER_ID,
      instanceId: INSTANCE_ID,
      projectId: "invest-agent",
    }, new Date("2026-07-03T13:18:00.000Z"));

    assert.deepEqual(prepare, { dateKey: "2026-07-03" });
  });

  test("writes and reads prepared review payloads under workspace state", async () => {
    const { __test__ } = await import("../src/scheduler/review.js");
    const scope = { userId: USER_ID, instanceId: INSTANCE_ID, projectId: "invest-agent" };

    await __test__.writePreparedReviewPush(scope, "daily", "2026-07-03", "prepared review text");

    const payload = await __test__.readPreparedReviewPush(scope, "daily", "2026-07-03");
    assert.equal(payload?.text, "prepared review text");
    assert.equal(payload?.kind, "daily");
    assert.equal(payload?.dateKey, "2026-07-03");

    const file = __test__.preparedReviewPath(scope, "daily", "2026-07-03");
    assert.ok(file.includes(join(".state", "scheduled-reviews", "review-scheduler-test-instance")));
    assert.match(await readFile(file, "utf-8"), /prepared review text/);
  });

  test("waits for a live prepare claim and returns its frozen text", async () => {
    const { __test__ } = await import("../src/scheduler/review.js");
    const scope = { userId: USER_ID, instanceId: INSTANCE_ID, projectId: "invest-agent" };
    let nowMs = Date.parse("2026-07-03T13:29:00.000Z");
    let preparedText: string | null = null;
    let status = "claimed";
    let sleeps = 0;
    const state = () => ({
      taskKey: __test__.reviewPrepareTaskKey("daily", scope, "2026-07-03"),
      status,
      claimedAt: "2026-07-03T13:20:00.000Z",
      finishedAt: status === "claimed" ? null : new Date(nowMs).toISOString(),
      leaseExpiresAt: "2026-07-03T13:35:00.000Z",
      errorClass: null,
    });

    const text = await __test__.waitForPreparedReview("daily", scope, "2026-07-03", {
      getState: async () => state(),
      readText: async () => preparedText,
      reconcile: async () => 0,
      now: () => new Date(nowMs),
      sleep: async (ms: number) => {
        sleeps += 1;
        nowMs += ms;
        preparedText = "frozen prepared review";
        status = "success";
      },
    });

    assert.equal(text, "frozen prepared review");
    assert.equal(sleeps, 1);
  });

  test("reconciles an expired prepare claim without waiting indefinitely", async () => {
    const { __test__ } = await import("../src/scheduler/review.js");
    const scope = { userId: USER_ID, instanceId: INSTANCE_ID, projectId: "invest-agent" };
    const now = new Date("2026-07-03T13:35:06.000Z");
    let reconciles = 0;

    const text = await __test__.waitForPreparedReview("daily", scope, "2026-07-03", {
      getState: async () => ({
        taskKey: __test__.reviewPrepareTaskKey("daily", scope, "2026-07-03"),
        status: "claimed",
        claimedAt: "2026-07-03T13:20:00.000Z",
        finishedAt: null,
        leaseExpiresAt: "2026-07-03T13:35:00.000Z",
        errorClass: null,
      }),
      readText: async () => null,
      reconcile: async () => {
        reconciles += 1;
        return 1;
      },
      now: () => now,
      sleep: async () => assert.fail("expired handoff must not sleep"),
    });

    assert.equal(text, null);
    assert.equal(reconciles, 1);
  });

  test("uses prepare output without fallback generation and falls back once after failure", async () => {
    const { __test__ } = await import("../src/scheduler/review.js");
    const scope = { userId: USER_ID, instanceId: INSTANCE_ID, projectId: "invest-agent" };
    let generations = 0;
    let waits = 0;
    const fromPrepare = await __test__.resolveReviewText("daily", scope, "2026-07-03", undefined, {
      readText: async () => null,
      waitForPrepare: async () => {
        waits += 1;
        return "prepared once";
      },
      shouldSkipFallback: async () => false,
      generate: async () => {
        generations += 1;
        return "generated fallback";
      },
    });
    assert.equal(fromPrepare, "prepared once");
    assert.equal(waits, 1);
    assert.equal(generations, 0);

    const fromFallback = await __test__.resolveReviewText("daily", scope, "2026-07-03", undefined, {
      readText: async () => null,
      waitForPrepare: async () => {
        waits += 1;
        return null;
      },
      shouldSkipFallback: async () => false,
      generate: async () => {
        generations += 1;
        return "generated fallback";
      },
    });
    assert.equal(fromFallback, "generated fallback");
    assert.equal(waits, 2);
    assert.equal(generations, 1);
  });

  test("manual review generation does not wait for natural prepare", async () => {
    const { __test__ } = await import("../src/scheduler/review.js");
    const scope = { userId: USER_ID, instanceId: INSTANCE_ID, projectId: "invest-agent" };
    let waits = 0;
    let generations = 0;
    const text = await __test__.resolveReviewText("daily", scope, "2026-07-03", "manual-test", {
      readText: async () => null,
      waitForPrepare: async () => {
        waits += 1;
        return "should not be used";
      },
      shouldSkipFallback: async () => false,
      generate: async () => {
        generations += 1;
        return "manual result";
      },
    });

    assert.equal(text, "manual result");
    assert.equal(waits, 0);
    assert.equal(generations, 1);
  });
});
