#!/usr/bin/env node

import "dotenv/config";
import { initDb, sqlite } from "../dist/db/index.js";
import { cancelOnboardingDraft } from "../dist/services/onboarding-drafts.js";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

const userId = arg("--user-id");
const instanceId = arg("--instance-id");
const draftId = arg("--draft-id");
const reason = arg("--reason") || "取消未完成的误生成 onboarding 草稿";
if (!userId || !instanceId || !draftId) {
  console.error("Usage: node scripts/cancel-onboarding-draft.mjs --user-id <id> --instance-id <id> --draft-id <id> [--reason <text>]");
  process.exit(1);
}

initDb();
try {
  const draft = await cancelOnboardingDraft({ userId, instanceId }, draftId, reason);
  console.log(JSON.stringify({ ok: true, userId, instanceId, draftId, status: draft.status, updatedAt: draft.updatedAt }));
} finally {
  sqlite.close();
}
