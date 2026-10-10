#!/usr/bin/env node
/* adhoc6b：样本补齐（content 列）+ 特殊模型 trace 状态 */
const { DatabaseSync } = require('node:sqlite');
const DB = 'data/runtime.db';
const WB = '2026-10-02T16:00:00.000Z', WE = '2026-10-09T12:10:00.000Z';
function q(sql, p = []) { const db = new DatabaseSync(DB, { readOnly: true }); const r = db.prepare(sql).all(...p); db.close(); return r; }

console.log('[MG msgs all]');
for (const r of q(`SELECT datetime(created_at,'+8 hours') t, substr(content,1,60) s FROM conversation_messages
  WHERE role='user' AND user_id='mg' AND created_at >= ? AND created_at < ? ORDER BY created_at`, [WB, WE]))
  console.log(`  ${r.t} :: ${String(r.s).replace(/\n/g,' ')}`);
console.log('[111 samples]');
for (const r of q(`SELECT datetime(created_at,'+8 hours') t, substr(content,1,60) s FROM conversation_messages
  WHERE role='user' AND user_id='111' AND created_at >= ? AND created_at < ? ORDER BY created_at`, [WB, WE]))
  console.log(`  ${r.t} :: ${String(r.s).replace(/\n/g,' ')}`);
console.log('[TERRA/DEEPSEEK trace detail]');
for (const r of q(`SELECT user_id, agent_model m, datetime(created_at,'+8 hours') t, status, ROUND(cost_amount,3) c FROM agent_traces
  WHERE agent_model IN ('gpt-5.6-terra','deepseek-flash') AND created_at >= ? AND created_at < ? ORDER BY created_at`, [WB, WE]))
  console.log(`  ${r.t} ${r.user_id} ${r.m} ${r.status} cost=${r.c}`);
console.log('[DYK runs days] ' + JSON.stringify(q(`SELECT date(created_at,'+8 hours') d, status, COUNT(*) c FROM automation_task_runs
  WHERE user_id='dyk' AND created_at >= ? AND created_at < ? GROUP BY d, status ORDER BY d`, [WB, WE])));
console.log('[QWEN traces] ');
for (const r of q(`SELECT user_id, datetime(created_at,'+8 hours') t, ROUND(cost_amount,2) c, status FROM agent_traces
  WHERE agent_model='qwen3.8-flash' AND created_at >= ? AND created_at < ? ORDER BY created_at`, [WB, WE]))
  console.log(`  ${r.t} ${r.user_id} cost=${r.c} ${r.status}`);
