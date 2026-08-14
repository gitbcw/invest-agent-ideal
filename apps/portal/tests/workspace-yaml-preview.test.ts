import assert from "node:assert/strict";
import test from "node:test";

import { isVisibleWorkspaceFile } from "../src/components/chat/LibraryTree";
import type { WorkspaceFileItem } from "../src/lib/protocol";

test("workspace tree exposes YAML as text without exposing other source files", () => {
  const yaml: WorkspaceFileItem = {
    fileId: "yaml",
    relativePath: "config/portfolio.yaml",
    fileName: "portfolio.yaml",
    mimeType: "application/yaml",
    sizeBytes: 20,
    updatedAt: "2026-07-29T00:00:00.000Z",
    previewMode: "text",
    downloadable: true,
  };
  const source: WorkspaceFileItem = {
    ...yaml,
    fileId: "source",
    relativePath: "analysis.py",
    fileName: "analysis.py",
    mimeType: "text/x-python",
  };

  assert.equal(isVisibleWorkspaceFile(yaml), true);
  assert.equal(isVisibleWorkspaceFile(source), false);
});
