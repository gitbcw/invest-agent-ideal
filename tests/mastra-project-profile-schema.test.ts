import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("initDb adds all Mastra migration projection and ledger tables with indexes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-project-profile-schema-"));
  const dbPath = path.join(root, "target.db");
  try {
    const script = [
      'const { default: database } = await import("./src/db/index.ts");',
      "const { initDb, sqlite } = database;",
      "initDb();",
      'const profileTable = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'mastra_project_profiles\'").get();',
      'const profileIndex = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = \'index\' AND name = \'idx_mastra_project_profiles_source\'").get();',
      'const portfolioTable = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'mastra_portfolio_states\'").get();',
      'const portfolioIndex = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = \'index\' AND name = \'idx_mastra_portfolio_states_source\'").get();',
      'const runtimeTable = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'mastra_runtime_preferences\'").get();',
      'const runtimeIndex = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = \'index\' AND name = \'idx_mastra_runtime_preferences_source\'").get();',
      'const reviewMemoryTable = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'mastra_review_memory_records\'").get();',
      'const reviewMemoryIndex = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = \'index\' AND name = \'idx_mastra_review_memory_scope_key\'").get();',
      'const assetTable = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'mastra_workspace_asset_records\'").get();',
      'const assetIndex = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = \'index\' AND name = \'idx_mastra_workspace_asset_scope_path\'").get();',
      "console.log(JSON.stringify({ profileTable: Boolean(profileTable), profileIndex: Boolean(profileIndex), portfolioTable: Boolean(portfolioTable), portfolioIndex: Boolean(portfolioIndex), runtimeTable: Boolean(runtimeTable), runtimeIndex: Boolean(runtimeIndex), reviewMemoryTable: Boolean(reviewMemoryTable), reviewMemoryIndex: Boolean(reviewMemoryIndex), assetTable: Boolean(assetTable), assetIndex: Boolean(assetIndex) }));",
      "sqlite.close();",
    ].join("");
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "test", DB_PATH: dbPath, RUNTIME_DATA_ROOT: path.join(root, "runtime"), WORKSPACE_ROOT: path.join(root, "workspaces") },
    });
    const output = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    assert.deepEqual(output, { profileTable: true, profileIndex: true, portfolioTable: true, portfolioIndex: true, runtimeTable: true, runtimeIndex: true, reviewMemoryTable: true, reviewMemoryIndex: true, assetTable: true, assetIndex: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
