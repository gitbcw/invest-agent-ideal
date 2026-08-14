import assert from "node:assert/strict";
import test from "node:test";

import { DOCUMENT_MIME, canonicalAttachmentMime, isCsvFile } from "../src/lib/attachment-policy";

test("Portal attachment policy accepts CSV files and canonicalizes browser MIME aliases", () => {
  assert.ok(DOCUMENT_MIME.includes("text/csv"));
  assert.equal(canonicalAttachmentMime("holdings.csv", ""), "text/csv");
  assert.equal(canonicalAttachmentMime("holdings.csv", "application/vnd.ms-excel"), "text/csv");
  assert.equal(isCsvFile("holdings.csv", "application/octet-stream"), true);
});

test("Portal attachment policy preserves non-CSV MIME types", () => {
  assert.equal(canonicalAttachmentMime("notes.txt", "text/plain"), "text/plain");
  assert.equal(isCsvFile("notes.txt", "text/plain"), false);
});
