import { createHash } from "node:crypto";
import process from "node:process";

import Database from "better-sqlite3";

const [databasePath] = process.argv.slice(2);
const scopes = (process.env.FINGERPRINT_SCOPES || "111,dyk,mg").split(",").filter(Boolean);

if (!databasePath) {
  console.error("usage: sqlite-content-fingerprint.mjs <database>");
  process.exit(2);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizedValue(value) {
  if (Buffer.isBuffer(value)) return { type: "blob", hex: value.toString("hex") };
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  return value;
}

function hashRows(rows) {
  const hash = createHash("sha256");
  for (const row of rows) {
    const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizedValue(value)]));
    hash.update(JSON.stringify(normalized));
    hash.update("\n");
  }
  return hash.digest("hex");
}

const db = new Database(databasePath, { readonly: true, fileMustExist: true });

try {
  const quickCheck = db.pragma("quick_check", { simple: true });
  if (quickCheck !== "ok") throw new Error(`quick_check failed: ${quickCheck}`);
  const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  const tables = [];
  const scoped = [];

  for (const table of tableNames) {
    const quotedTable = quoteIdentifier(table);
    const columns = db.prepare(`PRAGMA table_info(${quotedTable})`).all().map((row) => row.name);
    const orderBy = columns.length > 0 ? ` ORDER BY ${columns.map(quoteIdentifier).join(", ")}` : "";
    const rows = db.prepare(`SELECT * FROM ${quotedTable}${orderBy}`).all();
    tables.push({ table, rows: rows.length, sha256: hashRows(rows) });

    const scopeColumns = columns.filter((column) => ["user_id", "instance_id", "assistant_id", "project_id", "username"].includes(column));
    for (const scope of scopes) {
      const matches = rows.filter((row) => scopeColumns.some((column) => String(row[column] ?? "").includes(scope)));
      if (matches.length > 0) scoped.push({ table, scope, rows: matches.length, sha256: hashRows(matches) });
    }
  }

  console.log(JSON.stringify({ quickCheck, tableCount: tables.length, tables, scoped }, null, 2));
} finally {
  db.close();
}
