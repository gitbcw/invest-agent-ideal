import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("production runtime apply refuses unconfirmed or unverified packages before touching target", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-apply-guard-"));
  const packagePath = path.join(tempRoot, "runtime.tgz");
  const remoteAppDir = path.join(tempRoot, "remote-app");
  writeFileSync(packagePath, "not a runtime package");

  try {
    const unconfirmed = spawnSync("bash", ["scripts/apply-volcano-runtime.sh", packagePath], {
      cwd: process.cwd(),
      env: { ...process.env, REMOTE_APP_DIR: remoteAppDir },
      encoding: "utf8",
    });
    assert.equal(unconfirmed.status, 2);
    assert.match(unconfirmed.stderr, /refusing to replace runtime data/);
    assert.equal(existsSync(remoteAppDir), false);

    const wrongDigest = spawnSync("bash", ["scripts/apply-volcano-runtime.sh", packagePath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REMOTE_APP_DIR: remoteAppDir,
        EXPECTED_REMOTE_APP_DIR: remoteAppDir,
        CONFIRM_RUNTIME_APPLY: "replace-runtime-and-data",
        EXPECTED_PACKAGE_SHA256: "0".repeat(64),
      },
      encoding: "utf8",
    });
    assert.equal(wrongDigest.status, 2);
    assert.match(wrongDigest.stderr, /SHA256 mismatch/);
    assert.equal(existsSync(remoteAppDir), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
