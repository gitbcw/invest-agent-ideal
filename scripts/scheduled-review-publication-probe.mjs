#!/usr/bin/env node

import { initDb, sqlite } from "../dist/db/index.js";
import { disposeAllAcp } from "../dist/acp/stdio-agent.js";
import { runScheduledReviewPublicationProbe } from "../dist/acp/scheduled-tasks.js";
import { rm } from "node:fs/promises";
import path from "node:path";

const userId = process.argv[2]?.trim();
const instanceId = process.argv[3]?.trim();
const date = process.argv[4]?.trim();
if (!userId || !instanceId || !date) {
  throw new Error("usage: scheduled-review-publication-probe <userId> <instanceId> <YYYY-MM-DD>");
}

initDb();
try {
  const result = await runScheduledReviewPublicationProbe(
    { userId, instanceId, projectId: "invest-agent" },
    {
      date,
      content: "# 定时日复盘发布单点验收\n\n这是一份固定的发布链路验收报告，不包含投资建议。",
      pushBrief: "定时日复盘发布单点验收已完成。",
      maxAttempts: 2,
    },
  );
  console.log(JSON.stringify(result));
} finally {
  disposeAllAcp();
  sqlite.close();
  await removeIsolatedEvalCredential(userId);
}

async function removeIsolatedEvalCredential(scopedUserId) {
  if (process.env.WORKSPACE_COMPATIBILITY_EVAL !== "true") return;
  const workspaceRoot = process.env.WORKSPACE_ROOT?.trim();
  if (
    !workspaceRoot
    || !path.isAbsolute(workspaceRoot)
    || !workspaceRoot.split(path.sep).includes("compatibility-evals")
  ) {
    throw new Error("WORKSPACE_ROOT must be an absolute compatibility-evals path");
  }
  await rm(path.join(workspaceRoot, scopedUserId, ".codex", "auth.json"), { force: true });
}
