import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/mastra-portfolio-mapping-dry-run.mjs");

test("portfolio mapping dry-run preserves complete structured state without changing the snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-portfolio-map-"));
  const snapshot = path.join(root, "snapshot");
  const source = path.join(snapshot, "alice", "config", "portfolio.yaml");
  const output = path.join(root, "portfolio-map.json");
  try {
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, [
      "cash: { available: 100, currency: CNY, safety_buffer: 20 }",
      "holdings:", "  - { name: ETF, code: '510300', shares: 100, account: broker, notes: retain }",
      "watchlist:", "  - { name: Stock, code: '000001', trigger: wait, source: manual, added_at: 2026-08-01T00:00:00Z }",
      "stock_plans:", "  - name: Stock", "    code: '000001'", "    watch_conditions: [{ type: technical_gate, status: required }]",
      "accounts: [{ name: broker, type: cash }]", "last_confirmed_at: 2026-08-02T00:00:00Z", "last_confirmed_by: user",
    ].join("\n"));
    const before = await readFile(source, "utf8");
    await execFileAsync(process.execPath, [script, "--workspace-snapshot", snapshot, "--workspace-id", "alice", "--user-id", "alice", "--instance-id", "invest-agent-alice", "--out", output]);
    assert.equal(await readFile(source, "utf8"), before);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(report.validation.unmappedTopLevelFields, []);
    assert.deepEqual(report.validation.duplicateCodes, []);
    assert.equal(report.mapping.counts.holdings, 1);
    assert.equal(report.mapping.counts.watchlist, 1);
    assert.equal(report.mapping.counts.stockPlans, 1);
    assert.equal(report.mapping.serviceMigration.fields.holdings[0].shares, 100);
    assert.deepEqual(report.mapping.serviceMigration.fields.stockPlans[0].watch_conditions, [{ type: "technical_gate", status: "required" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portfolio mapping dry-run rejects duplicate business keys and snapshot-local output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-portfolio-map-"));
  const snapshot = path.join(root, "snapshot");
  const source = path.join(snapshot, "alice", "config", "portfolio.yaml");
  try {
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "holdings: [{ name: A, code: '000001' }, { name: B, code: '000001' }]\n");
    await assert.rejects(execFileAsync(process.execPath, [script, "--workspace-snapshot", snapshot, "--workspace-id", "alice", "--user-id", "alice", "--instance-id", "invest-agent-alice", "--out", path.join(root, "out.json")]), /MASTRA_PORTFOLIO_MAPPING_CONFLICT/);
    await writeFile(source, "holdings: []\n");
    await assert.rejects(execFileAsync(process.execPath, [script, "--workspace-snapshot", snapshot, "--workspace-id", "alice", "--user-id", "alice", "--instance-id", "invest-agent-alice", "--out", path.join(snapshot, "out.json")]), /--out must be outside/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
