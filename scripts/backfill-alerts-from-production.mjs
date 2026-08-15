#!/usr/bin/env node
/**
 * One-shot backfill (2026-08-15): copy the alert/watch domains that the beta
 * migration missed from the production runtime DB into the candidate DB.
 *
 * Scope found during the go-live sweep: production carried mg's 30 enabled
 * alert rules, 99 alert events and 89 market-watch snapshots that the
 * original migration never imported (candidate read paths returned 0 and the
 * patrol page would show an empty rule list).
 *
 * Safety: production is opened READ-ONLY; rows are inserted with
 * INSERT OR IGNORE keyed on their primary ids, so re-runs are idempotent.
 * alert_signal_states is intentionally NOT copied (it belongs to a legacy
 * weixin-mobile scope, not the beta users).
 *
 * Usage on the candidate server:
 *   node scripts/backfill-alerts-from-production.mjs \
 *     [--prod /home/claude/invest-agent/data/invest-agent.db] \
 *     [--cand /home/claude/invest-agent-mastra/data/runtime.db]
 */
import Database from "better-sqlite3";
import process from "node:process";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : fallback;
};
const prodPath = flag("prod", "/home/claude/invest-agent/data/invest-agent.db");
const candPath = flag("cand", "/home/claude/invest-agent-mastra/data/runtime.db");
const users = ["mg", "dyk", "111"];
const where = `user_id IN (${users.map((u) => `'${u}'`).join(",")})`;

const cand = new Database(candPath);
cand.pragma("foreign_keys = OFF");
let failed = false;
for (const table of ["alert_rules", "alert_events", "market_watch_snapshots"]) {
  try {
    if (!cand.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      console.log(`skip ${table}: candidate table missing`);
      continue;
    }
    cand.exec(`ATTACH DATABASE '${prodPath}' AS prod`);
    const prodCols = cand.prepare(`PRAGMA prod.table_info(${table})`).all().map((c) => c.name);
    const candCols = cand.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const missing = prodCols.filter((c) => !candCols.includes(c));
    if (missing.length) {
      console.log(`skip ${table}: production-only columns ${missing.join(",")}`);
      cand.exec("DETACH prod");
      continue;
    }
    const cols = prodCols.join(",");
    const result = cand
      .prepare(`INSERT OR IGNORE INTO main.${table} (${cols}) SELECT ${cols} FROM prod.${table} WHERE ${where}`)
      .run();
    cand.exec("DETACH prod");
    console.log(`${table}: backfilled ${result.changes} row(s)`);
  } catch (error) {
    failed = true;
    console.error(`${table}: FAILED ${error.message}`);
    try { cand.exec("DETACH prod"); } catch { /* not attached */ }
  }
}
cand.close();
if (failed) process.exit(1);
