import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const runner = "scripts/capabilities/market-data.mjs";

test("market runner returns JSON fixture output without loading the service runtime", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [runner, "quote", "--input", '{"codes":["600519"]}']);
  assert.equal(stderr, "");
  const output = JSON.parse(stdout);
  assert.equal(output.operation, "quote");
  assert.equal(output.mode, "fixture");
  assert.equal(output.result.items[0].code, "600519");
});

test("market runner supports every planned fixture operation", async () => {
  for (const operation of ["kline", "indices", "calendar", "health"]) {
    const { stdout, stderr } = await execFileAsync(process.execPath, [runner, operation]);
    assert.equal(stderr, "");
    const output = JSON.parse(stdout);
    assert.equal(output.operation, operation);
    assert.equal(output.mode, "fixture");
  }
});

test("market runner writes failures to stderr and keeps stdout machine-readable", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [runner, "unknown"]),
    (error) => {
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /supported operations/);
      return true;
    },
  );
});
