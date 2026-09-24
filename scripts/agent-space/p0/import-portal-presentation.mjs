#!/usr/bin/env node
/**
 * Map 111's retained Portal presentation state into the isolated Portal test
 * account. Runtime identity (111) and Portal session identity (primary/usr_*)
 * intentionally differ in P0.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const P0_ROOT = path.resolve(process.env.P0_ROOT ?? path.join(REPO_ROOT, ".state", "agent-space-p0"));
const sourcePath = path.resolve(process.env.P0_PRESENTATION_SOURCE ?? path.join(P0_ROOT, "runtime.db"));
const portalPath = path.resolve(process.env.P0_PORTAL_DB ?? path.join(P0_ROOT, "portal.db"));
const runtimeUserId = process.env.P0_RUNTIME_USER_ID ?? process.env.P0_USER_ID ?? "111";
const instanceId = process.env.P0_INSTANCE_ID ?? `invest-agent-${runtimeUserId}`;
const sourceUsername = process.env.P0_SOURCE_PORTAL_USERNAME ?? runtimeUserId;
const targetUsername = process.env.P0_TARGET_PORTAL_USERNAME ?? "primary";

for (const file of [sourcePath, portalPath]) {
  if (!fs.existsSync(file)) throw new Error(`缺少隔离展示态导入文件: ${file}`);
}

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
const target = new Database(portalPath);

try {
  const sourceUser = source
    .prepare("SELECT id, assistant_id, instance_id FROM portal_users WHERE username=? AND instance_id=?")
    .get(sourceUsername, instanceId);
  const targetUser = target
    .prepare("SELECT id, assistant_id, instance_id FROM portal_users WHERE username=? AND instance_id=?")
    .get(targetUsername, instanceId);
  if (!sourceUser) throw new Error(`源 Portal 用户不存在: ${sourceUsername}/${instanceId}`);
  if (!targetUser) throw new Error(`目标 Portal 用户不存在: ${targetUsername}/${instanceId}`);
  if (sourceUser.assistant_id !== instanceId || targetUser.assistant_id !== instanceId) {
    throw new Error("Portal 用户 assistant/instance 映射不符合 111 隔离 scope");
  }

  const labels = source
    .prepare("SELECT label_id, name, position, created_at, updated_at FROM conversation_labels WHERE user_id=? AND assistant_id=? ORDER BY position, created_at")
    .all(sourceUser.id, sourceUser.assistant_id);
  const meta = source
    .prepare(
      `SELECT pcm.conversation_id, pcm.title_override, pcm.pinned_at, pcm.archived_at, pcm.deleted_at,
              pcm.label_id, pcm.position, pcm.created_at, pcm.updated_at
       FROM portal_conversation_meta pcm
       JOIN conversation_sessions cs ON cs.conversation_id = pcm.conversation_id
       WHERE pcm.user_id=? AND pcm.assistant_id=? AND pcm.instance_id=?
         AND cs.user_id=? AND cs.instance_id=?`,
    )
    .all(sourceUser.id, sourceUser.assistant_id, instanceId, runtimeUserId, instanceId);
  // portal_conversation_meta is only presentation state. The Portal list is a
  // JOIN against conversation_sessions, so bring over each referenced runtime
  // session as well. Connector's first page is intentionally bounded and
  // cannot be relied on to hydrate older, still-visible conversations.
  const sessions = source
    .prepare(
      `SELECT cs.conversation_id, cs.user_id, cs.project_id, cs.instance_id, cs.assistant_id,
              cs.channel, cs.title, cs.last_message_preview, cs.message_count, cs.status,
              cs.metadata, cs.created_at, cs.updated_at
       FROM conversation_sessions cs
       JOIN portal_conversation_meta pcm ON pcm.conversation_id = cs.conversation_id
       WHERE pcm.user_id=? AND pcm.assistant_id=? AND pcm.instance_id=?
         AND cs.user_id=? AND cs.instance_id=?`,
    )
    .all(sourceUser.id, sourceUser.assistant_id, instanceId, runtimeUserId, instanceId);
  if (sessions.length !== meta.length) {
    throw new Error(`展示态会话实体不完整: meta=${meta.length} sessions=${sessions.length}`);
  }

  target.transaction(() => {
    const upsertLabel = target.prepare(
      `INSERT INTO conversation_labels (label_id, user_id, assistant_id, name, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(label_id) DO UPDATE SET
         user_id=excluded.user_id, assistant_id=excluded.assistant_id, name=excluded.name,
         position=excluded.position, updated_at=excluded.updated_at`,
    );
    const upsertMeta = target.prepare(
      `INSERT INTO portal_conversation_meta (
         conversation_id, user_id, assistant_id, instance_id, title_override, pinned_at,
         archived_at, deleted_at, label_id, position, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         user_id=excluded.user_id, assistant_id=excluded.assistant_id, instance_id=excluded.instance_id,
         title_override=excluded.title_override, pinned_at=excluded.pinned_at,
         archived_at=excluded.archived_at, deleted_at=excluded.deleted_at,
         label_id=excluded.label_id, position=excluded.position, updated_at=excluded.updated_at`,
    );
    const upsertSession = target.prepare(
      `INSERT INTO conversation_sessions (
         conversation_id, user_id, project_id, instance_id, assistant_id, channel, title,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         user_id=excluded.user_id, project_id=excluded.project_id,
         instance_id=excluded.instance_id, assistant_id=excluded.assistant_id,
         channel=excluded.channel, title=excluded.title,
         created_at=excluded.created_at, updated_at=excluded.updated_at`,
    );
    for (const row of labels) {
      upsertLabel.run(row.label_id, targetUser.id, targetUser.assistant_id, row.name, row.position, row.created_at, row.updated_at);
    }
    for (const row of meta) {
      upsertMeta.run(row.conversation_id, targetUser.id, targetUser.assistant_id, targetUser.instance_id, row.title_override, row.pinned_at, row.archived_at, row.deleted_at, row.label_id, row.position, row.created_at, row.updated_at);
    }
    for (const row of sessions) {
      upsertSession.run(
        row.conversation_id, row.user_id, row.project_id, row.instance_id,
        row.assistant_id, row.channel, row.title, row.created_at, row.updated_at,
      );
    }
  })();

  console.log(JSON.stringify({ sourcePath, portalPath, sourceUsername, targetUsername, labels: labels.length, presentationRows: meta.length, sessions: sessions.length }));
} finally {
  source.close();
  target.close();
}
