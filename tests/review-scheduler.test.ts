import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

// P4b (E4): the preference-driven prepare/push machinery is retired. Reviews
// fire as typed automation tasks; the manual trigger path resolves text from
// a saved scheduled daily review or generates fresh. This contract pins the
// surviving resolveReviewText chain.
describe("review text resolution after P4b", { concurrency: false }, () => {
  let workspaceRoot = "";

  before(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "invest-agent-review-p4b-"));
    process.env.WORKSPACE_ROOT = workspaceRoot;
  });

  after(async () => {
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("resolveReviewText prefers reusable text and falls back to generation", async () => {
    const { __test__ } = await import("../src/scheduler/review.js");
    const scope = { userId: "p4b-user", instanceId: "p4b-instance", projectId: "invest-agent" };

    const generated: string[] = [];
    const text = await __test__.resolveReviewText("daily", scope, "2026-08-15", undefined as never, {
      readText: async () => null,
      generate: async () => { generated.push("gen"); return "generated review"; },
    } as never);
    assert.equal(text, "generated review");
    assert.equal(generated.length, 1);

    const reused = await __test__.resolveReviewText("daily", scope, "2026-08-15", undefined as never, {
      readText: async () => "saved scheduled review",
      generate: async () => { throw new Error("must not generate when reusable text exists"); },
    } as never);
    assert.equal(reused, "saved scheduled review");
  });
});
