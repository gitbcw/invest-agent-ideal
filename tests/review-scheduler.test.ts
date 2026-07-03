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
    }, new Date("2026-07-03T13:20:00.000Z"));

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
});
