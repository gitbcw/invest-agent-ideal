#!/usr/bin/env node
// 将生产 portal.db（conversation_mirror / conversation_labels）中的用户展示态
// 导入 Mastra 候选 runtime.db 的 portal_conversation_meta / conversation_labels。
//
// 背景：软删除/归档/置顶/重命名/标签是门户展示层状态，生产存于 portal 独立
// SQLite（conversation_mirror），而候选门户直接使用 runtime.db 的 meta 表。
// 表级迁移只搬 runtime 表，展示态若不单独导入，已删除会话会在候选侧栏复活。
//
// 用户映射：源 users.id (usr_*) → username → 目标 portal_users.id (usr_*)。
// 幂等：按 conversation_id / label_id upsert，重复执行无副作用。
//
// 用法：
//   node scripts/mastra-portal-presentation-import.mjs \
//     --source <备份快照>/databases/portal.db \
//     --target <候选>/data/runtime.db [--dry-run]
//
// 今晚按备份重跑迁移后，必须在会话表导入完成后执行本脚本一次。

import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseCli() {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      target: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.source || !values.target) {
    console.error("用法: node scripts/mastra-portal-presentation-import.mjs --source <prod portal.db> --target <cand runtime.db> [--dry-run]");
    process.exit(2);
  }
  return values;
}

function openDb(file) {
  const candidates = [
    file,
    path.resolve(__dirname, "../node_modules/better-sqlite3"),
    "better-sqlite3",
  ];
  let lastError;
  for (const spec of candidates) {
    try {
      const Database = require(spec);
      return new Database(file);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const PRESENTATION_COLUMNS = [
  "deleted_at",
  "archived_at",
  "pinned_at",
  "title_override",
  "label_id",
  "position",
];

function main() {
  const cli = parseCli();
  const source = openDb(cli.source);
  const target = openDb(cli.target);
  const dryRun = cli["dry-run"];

  const sourceUsers = new Map(source.prepare("SELECT id, username FROM users").all().map((r) => [r.id, r.username]));
  const targetUsers = new Map(target.prepare("SELECT id, username FROM portal_users").all().map((r) => [r.username, r.id]));
  const report = { labels: 0, metaUpserted: 0, metaWithState: 0, unmatchedUsers: [], skippedNoSession: 0 };

  const migrateLabels = target.transaction(() => {
    const labelRows = source.prepare("SELECT * FROM conversation_labels").all();
    for (const label of labelRows) {
      const username = sourceUsers.get(label.user_id);
      const targetUserId = username ? targetUsers.get(username) : undefined;
      if (!targetUserId) {
        report.unmatchedUsers.push(`label ${label.label_id} → ${label.user_id} (${username ?? "unknown"})`);
        continue;
      }
      target
        .prepare(
          `INSERT INTO conversation_labels (label_id, user_id, assistant_id, name, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(label_id) DO UPDATE SET
             name = excluded.name,
             position = excluded.position,
             updated_at = excluded.updated_at`
        )
        .run(label.label_id, targetUserId, label.assistant_id, label.name, label.position ?? 0, label.created_at, label.updated_at);
      report.labels += 1;
    }
  });

  const migrateMeta = target.transaction(() => {
    const mirrorColumns = new Set(source.prepare("PRAGMA table_info(conversation_mirror)").all().map((c) => c.name));
    for (const column of PRESENTATION_COLUMNS) {
      if (!mirrorColumns.has(column)) throw new Error(`源库 conversation_mirror 缺少列 ${column}`);
    }
    const rows = source
      .prepare(
        `SELECT conversation_id, user_id, assistant_id, instance_id, created_at, updated_at,
                ${PRESENTATION_COLUMNS.join(", ")}
         FROM conversation_mirror`
      )
      .all();
    const sessionExists = target.prepare("SELECT 1 FROM conversation_sessions WHERE conversation_id = ?");
    const upsert = target.prepare(
      `INSERT INTO portal_conversation_meta (
         conversation_id, user_id, assistant_id, instance_id,
         created_at, updated_at, ${PRESENTATION_COLUMNS.join(", ")}
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         deleted_at = excluded.deleted_at,
         archived_at = excluded.archived_at,
         pinned_at = excluded.pinned_at,
         title_override = excluded.title_override,
         label_id = excluded.label_id,
         position = excluded.position,
         updated_at = excluded.updated_at`
    );
    for (const row of rows) {
      const username = sourceUsers.get(row.user_id);
      const targetUserId = username ? targetUsers.get(username) : undefined;
      if (!targetUserId) {
        report.unmatchedUsers.push(`conversation ${row.conversation_id} → ${row.user_id} (${username ?? "unknown"})`);
        continue;
      }
      if (!sessionExists.get(row.conversation_id)) {
        // 会话本体不在目标库（如备份后目标侧已清理）：跳过，避免悬挂 meta。
        report.skippedNoSession += 1;
        continue;
      }
      const hasState = PRESENTATION_COLUMNS.some((column) => row[column] !== null && row[column] !== 0);
      if (hasState) report.metaWithState += 1;
      upsert.run(
        row.conversation_id,
        targetUserId,
        row.assistant_id,
        row.instance_id,
        row.created_at,
        new Date().toISOString(),
        row.deleted_at ?? null,
        row.archived_at ?? null,
        row.pinned_at ?? null,
        row.title_override ?? null,
        row.label_id ?? null,
        row.position ?? 0
      );
      report.metaUpserted += 1;
    }
  });

  if (dryRun) {
    // dry-run：以保存点回滚，不落盘。
    const savepoint = target.transaction(() => {
      migrateLabels();
      migrateMeta();
      throw new Rollback();
    });
    try {
      savepoint();
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  } else {
    migrateLabels();
    migrateMeta();
  }

  console.log(JSON.stringify(report, null, 2));
  if (report.unmatchedUsers.length) {
    console.warn("存在未能映射的用户（源有、目标无）：\n" + [...new Set(report.unmatchedUsers)].join("\n"));
  }
  source.close();
  target.close();
}

class Rollback extends Error {
  constructor() {
    super("dry-run rollback");
  }
}

main();
