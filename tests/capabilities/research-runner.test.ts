import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
const exec = promisify(execFile);
test("research runner is fixture-first JSON-only", async () => {
  for (const operation of ["news-search", "web-search", "web-read"]) {
    const { stdout, stderr } = await exec(process.execPath, ["scripts/capabilities/research.mjs", operation]);
    assert.equal(stderr, "");
    const output = JSON.parse(stdout);
    assert.equal(output.mode, "fixture");
    assert.equal(output.operation, operation);
  }
});
