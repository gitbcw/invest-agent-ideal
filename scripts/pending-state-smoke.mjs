/**
 * 烟测:pending-state provider 可被 ContextPacket 自动读取。
 *
 * 用法:npm run build && node scripts/pending-state-smoke.mjs
 */

import { buildContextPacket } from "../dist/acp/context-packet.js";
import { clearPendingConfirmation, listPendingConfirmations, registerPendingConfirmation } from "../dist/acp/pending-state.js";

const userContext = {
  userId: "test-pending-state",
  instanceId: "test-instance",
  conversationId: "conv-pending",
  channel: "weixin-mobile",
};

let pass = 0;
let fail = 0;

function assert(cond, label, value) {
  if (cond) {
    pass++;
    console.log(`✓ ${label}`);
  } else {
    fail++;
    console.error(`✗ ${label}`);
    if (value !== undefined) console.error(value);
  }
}

registerPendingConfirmation(userContext, {
  kind: "alert_draft",
  summary: "赛轮轮胎跌到 11.22 提醒",
  ttlMs: 60_000,
});

const listed = listPendingConfirmations(userContext);
assert(listed.length === 1 && listed[0].kind === "alert_draft", "可列出 pending confirmation", listed);

const packet = await buildContextPacket(userContext);
assert(packet.pendingConfirmations.some((item) => item.summary.includes("赛轮轮胎")), "ContextPacket 自动包含 pending confirmation", packet.pendingConfirmations);

clearPendingConfirmation(userContext, "alert_draft");
const cleared = listPendingConfirmations(userContext);
assert(cleared.length === 0, "可清理 pending confirmation", cleared);

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
