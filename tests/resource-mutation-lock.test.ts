import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { resourceMutationLockIdentity, withResourceMutationLock } from "../src/services/resource-mutation-lock.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withLockRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "invest-agent-resource-lock-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const scope = { userId: "user-a", instanceId: "instance-a" };

test("same workspace resource serializes complete mutations", async () => withLockRoot(async (lockRoot) => {
  const firstEntered = deferred();
  const releaseFirst = deferred();
  let secondEntered = false;
  const first = withResourceMutationLock(scope, "portfolio", async () => {
    firstEntered.resolve();
    await releaseFirst.promise;
  }, { lockRoot });
  await firstEntered.promise;
  const second = withResourceMutationLock(scope, "portfolio", async () => { secondEntered = true; }, { lockRoot });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(secondEntered, false);
  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.equal(secondEntered, true);
}));

test("different resources remain concurrent", async () => withLockRoot(async (lockRoot) => {
  const entered = new Set<string>();
  const release = deferred();
  const tasks = ["portfolio", "strategy"].map((key) => withResourceMutationLock(scope, key, async () => {
    entered.add(key);
    if (entered.size === 2) release.resolve();
    await release.promise;
  }, { lockRoot }));
  await Promise.all(tasks);
  assert.deepEqual([...entered].sort(), ["portfolio", "strategy"]);
}));

test("different users do not block each other", async () => withLockRoot(async (lockRoot) => {
  assert.notEqual(
    resourceMutationLockIdentity(scope, "portfolio"),
    resourceMutationLockIdentity({ userId: "user-b", instanceId: "instance-a" }, "portfolio"),
  );
  const entered = deferred();
  const release = deferred();
  const first = withResourceMutationLock(scope, "portfolio", () => release.promise, { lockRoot });
  const second = withResourceMutationLock({ userId: "user-b", instanceId: "instance-a" }, "portfolio", async () => entered.resolve(), { lockRoot });
  await entered.promise;
  release.resolve();
  await Promise.all([first, second]);
}));

test("multi-resource calls sort keys and release after errors", async () => withLockRoot(async (lockRoot) => {
  await assert.rejects(
    withResourceMutationLock(scope, ["strategy", "portfolio"], async () => { throw new Error("expected"); }, { lockRoot }),
    /expected/,
  );
  await Promise.all([
    withResourceMutationLock(scope, ["strategy", "portfolio"], async () => undefined, { lockRoot }),
    withResourceMutationLock(scope, ["portfolio", "strategy"], async () => undefined, { lockRoot }),
  ]);
}));

test("lock coordinates separate MCP-style processes", async (t) => withLockRoot(async (lockRoot) => {
  const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/resource-lock-child.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_RESOURCE_LOCK_ROOT: lockRoot },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let childStderr = "";
  child.stderr.on("data", (chunk) => { childStderr += String(chunk); });
  const childExit = new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`lock child failed: ${code}; stderr: ${childStderr}`)));
    child.once("error", reject);
  });
  let childLockTimeout: ReturnType<typeof setTimeout> | undefined;
  const childLocked = new Promise<void>((resolve, reject) => {
    child.stdout.once("data", (chunk) => String(chunk).includes("locked") && resolve());
    child.once("error", reject);
    childLockTimeout = setTimeout(() => reject(new Error(`lock child did not report acquisition in time; stderr: ${childStderr}`)), 20_000);
  });
  t.after(() => { child.kill("SIGKILL"); });
  try {
    await Promise.race([
      childLocked,
      childExit.then(() => { throw new Error(`lock child exited before acquiring the lock; stderr: ${childStderr}`); }),
    ]);
  } finally {
    if (childLockTimeout) clearTimeout(childLockTimeout);
  }

  let parentEntered = false;
  const parent = withResourceMutationLock(scope, "portfolio", async () => { parentEntered = true; }, { lockRoot, timeoutMs: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(parentEntered, false, `parent must wait for the child-held lock; child stderr: ${childStderr}`);
  child.stdin.end("release\n");
  await parent;
  assert.equal(parentEntered, true);
  await childExit;
}));
