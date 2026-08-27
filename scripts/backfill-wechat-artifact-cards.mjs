#!/usr/bin/env node
/**
 * 一次性维护脚本：把微信会话里的孤儿附件卡片绑定回对应助手消息。
 *
 * 背景（2026-08-27）：微信桥历史版本落库时从不登记活动轮（turn_id 为 NULL），
 * 也不调 attachArtifactsToAssistantMessage，导致微信对话里 AI 生成的文件在
 * conversation_artifacts 有记录，但 message_id 为空——网页端会话历史看不到
 * 卡片，用户无法预览/下载/保存。【2026-08-27 已修复】weixin-message-bridge
 * 现在与 web 路径对齐；本脚本只负责修复修复部署前遗留的孤儿记录。
 *
 * 绑定规则：对每条 message_id 为空的微信会话 artifact（未删除），找同会话中
 * created_at 晚于该 artifact 的最早一条 assistant 消息（即承载它的那条回复），
 * 回写 message_id，并把卡片描述符（与 conversation-log.ts
 * toPublicArtifactDescriptor 同形）合并进该消息的 metadata.artifacts。
 *
 * 用法（生产服务器，runtime.db 所在目录就近执行）：
 *   node scripts/backfill-wechat-artifact-cards.mjs            # dry-run，只打印计划
 *   node scripts/backfill-wechat-artifact-cards.mjs --apply    # 实际写入
 * 可选：--db <path>（默认 ./data/runtime.db）
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dbIndex = args.indexOf("--db");
const dbPath = dbIndex >= 0 ? args[dbIndex + 1] : path.join(process.cwd(), "data", "runtime.db");

if (!existsSync(dbPath)) {
  console.error(`[backfill] 数据库不存在: ${dbPath}`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const db = new Database(dbPath, { readonly: !apply });

const orphans = db
  .prepare(
    `SELECT artifact_id AS artifactId, user_id AS userId, instance_id AS instanceId,
            conversation_id AS conversationId, title, file_name AS fileName,
            mime_type AS mimeType, size_bytes AS sizeBytes, kind, preview_mode AS previewMode,
            created_at AS createdAt, checksum, asset_id AS assetId, version_id AS versionId
     FROM conversation_artifacts
     WHERE message_id IS NULL
       AND deleted_at IS NULL
       AND conversation_id LIKE '%@im.wechat'
     ORDER BY created_at ASC`
  )
  .all();

if (orphans.length === 0) {
  console.log("[backfill] 没有需要绑定的孤儿卡片，结束。");
  process.exit(0);
}

const findReply = db.prepare(
  `SELECT message_id AS messageId, user_id AS userId, instance_id AS instanceId, metadata
   FROM conversation_messages
   WHERE conversation_id = ? AND role = 'assistant' AND created_at >= ?
     AND status != 'superseded'
   ORDER BY created_at ASC, rowid ASC
   LIMIT 1`
);

let planned = 0;
let applied = 0;
const writeTx = apply
  ? db.transaction((artifact, reply, descriptor) => {
      db.prepare(
        "UPDATE conversation_artifacts SET message_id = ?, updated_at = ? WHERE artifact_id = ?"
      ).run(reply.messageId, new Date().toISOString(), artifact.artifactId);
      let metadata = {};
      try {
        metadata = reply.metadata ? JSON.parse(reply.metadata) : {};
      } catch {
        metadata = {};
      }
      const existing = Array.isArray(metadata.artifacts) ? metadata.artifacts : [];
      metadata.artifacts = [...existing, descriptor];
      db.prepare("UPDATE conversation_messages SET metadata = ? WHERE message_id = ?").run(
        JSON.stringify(metadata),
        reply.messageId
      );
    })
  : null;

for (const artifact of orphans) {
  const reply = findReply.get(artifact.conversationId, artifact.createdAt);
  if (!reply) {
    console.log(`[backfill] 跳过 ${artifact.artifactId}（${artifact.fileName}）：会话中找不到晚于它的助手消息`);
    continue;
  }
  if (reply.userId !== artifact.userId || reply.instanceId !== artifact.instanceId) {
    console.log(
      `[backfill] 跳过 ${artifact.artifactId}（${artifact.fileName}）：归属不一致 artifact=${artifact.userId}/${artifact.instanceId} message=${reply.userId}/${reply.instanceId}`
    );
    continue;
  }
  planned += 1;
  console.log(
    `[backfill] ${apply ? "绑定" : "计划绑定"} ${artifact.artifactId}（${artifact.fileName}）→ 消息 ${reply.messageId}`
  );
  if (apply && writeTx) {
    const descriptor = {
      artifactId: artifact.artifactId,
      title: artifact.title,
      fileName: artifact.fileName,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      kind: artifact.kind,
      previewMode: artifact.previewMode,
      createdAt: artifact.createdAt,
      checksum: artifact.checksum ?? undefined,
      assetId: artifact.assetId ?? null,
      versionId: artifact.versionId ?? null,
      savedToMyFiles: Boolean(artifact.assetId && artifact.versionId),
      workspacePath: undefined,
    };
    writeTx(artifact, reply, descriptor);
    applied += 1;
  }
}

console.log(`[backfill] 完成：共 ${orphans.length} 条孤儿，${planned} 条可绑定${apply ? `，已写入 ${applied} 条` : "（dry-run，未写入；加 --apply 执行）"}`);
db.close();
