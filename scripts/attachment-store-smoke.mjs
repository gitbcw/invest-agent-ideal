#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = await mkdtemp(path.join(os.tmpdir(), "invest-agent-attachment-workspace-"));
const sourceDir = await mkdtemp(path.join(os.tmpdir(), "invest-agent-attachment-source-"));

try {
  const {
    storeWeixinAttachment,
    storePortalAttachments,
    toPublicAttachmentMetadata
  } = await import(
    pathToFileURL(path.resolve("dist/lib/attachment-store.js")).href
  );

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwP9WQAAAABJRU5ErkJggg==",
    "base64"
  );
  const sourcePath = path.join(sourceDir, "holding.png");
  await writeFile(sourcePath, png);
  const sdkImagePath = path.join(sourceDir, "holding-sdk-image.bin");
  await writeFile(sdkImagePath, png);

  const stored = await storeWeixinAttachment({
    workspacePath: workspace,
    media: {
      type: "image",
      filePath: sdkImagePath,
      mimeType: "image/*",
    },
  });

  assert.equal(stored.type, "image");
  assert.equal(stored.mimeType, "image/png");
  assert.equal(stored.source, "weixin");
  assert.ok(stored.relativePath.startsWith(path.join("attachments", new Date().toISOString().slice(0, 10))));
  assert.ok(stored.path.startsWith(workspace));
  assert.ok(stored.fileName.endsWith(".png"));
  assert.deepEqual(await readFile(stored.path), png);

  const portalImage = await storePortalAttachments({
    workspacePath: workspace,
    attachments: [{
      kind: "image",
      fileName: "../portfolio screenshot.png",
      mimeType: "image/png",
      sizeBytes: png.length,
      base64: png.toString("base64")
    }]
  });
  assert.equal(portalImage.length, 1);
  assert.equal(portalImage[0].source, "portal");
  assert.equal(portalImage[0].type, "image");
  assert.equal(portalImage[0].mimeType, "image/png");
  assert.equal(portalImage[0].fileName, "portfolio_screenshot.png");
  assert.ok(!toPublicAttachmentMetadata(portalImage[0]).path);

  const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "utf8");
  const text = Buffer.from("投资观察：这是一份 UTF-8 文本文档。\n", "utf8");
  const portalDocs = await storePortalAttachments({
    workspacePath: workspace,
    attachments: [
      {
        kind: "document",
        fileName: "memo.pdf",
        mimeType: "application/pdf",
        sizeBytes: pdf.length,
        base64: pdf.toString("base64")
      },
      {
        kind: "document",
        fileName: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: text.length,
        base64: text.toString("base64")
      }
    ]
  });
  assert.equal(portalDocs.length, 2);
  assert.equal(portalDocs[0].type, "document");
  assert.equal(portalDocs[1].mimeType, "text/plain");

  await assert.rejects(
    () => storePortalAttachments({
      workspacePath: workspace,
      attachments: [{
        fileName: "archive.zip",
        mimeType: "application/zip",
        sizeBytes: 4,
        base64: Buffer.from("PK\u0003\u0004", "binary").toString("base64")
      }]
    }),
    /UNSUPPORTED_ATTACHMENT_MIME/
  );

  await assert.rejects(
    () => storePortalAttachments({
      workspacePath: workspace,
      attachments: [{
        fileName: "fake.txt",
        mimeType: "text/plain",
        sizeBytes: 6,
        base64: Buffer.from([0, 1, 2, 3, 4, 5]).toString("base64")
      }]
    }),
    /ATTACHMENT_BINARY_TEXT/
  );

  await assert.rejects(
    () => storeWeixinAttachment({
      workspacePath: workspace,
      media: {
        type: "file",
        filePath: sourcePath,
        mimeType: "image/png",
        fileName: "holding.png",
      },
    }),
    /UNSUPPORTED_ATTACHMENT_TYPE:file/
  );

  const savedStat = await stat(stored.path);
  assert.equal(savedStat.size, png.length);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "stores WeChat image under workspace attachments",
      "accepts SDK image/* and infers image mime/extension from file bytes",
      "stores portal image/document attachments from base64",
      "keeps public attachment metadata free of absolute path",
      "rejects unsupported attachment types",
      "rejects disguised binary text attachments",
      "rejects non-image attachment types",
    ],
  }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
  await rm(sourceDir, { recursive: true, force: true });
}
