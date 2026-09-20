#!/usr/bin/env node
/* 深挖：用户×模型交叉、mg 每日/样本、mgreplay 用途 */
const { DatabaseSync } = require('node:sqlite');
const DB = 'data/runtime.db';
const WB = '2026-09-11T16:00:00.000Z', WE = '2026-09-18T12:10:00.000Z';
function q(sql, p = []) { const db = new DatabaseSync(DB, { readOnly: true }); const r = db.prepare(sql).all(...p); db.close(); return r; }

console.log('[USER x MODEL] ' + JSON.stringify(q(`SELECT user_id, agent_model m, COUNT(*) n, ROUND(SUM(cost_amount),2) cost
  FROM agent_traces WHERE created_at >= ? AND created_at < ? GROUP BY user_id, agent_model ORDER BY cost DESC`, [WB, WE])));

console.log('[MG daily msgs] ' + q(`SELECT date(created_at,'+8 hours') d, COUNT(*) c FROM conversation_messages
  WHERE role='user' AND user_id='mg' AND created_at >= ? AND created_at < ? GROUP BY d ORDER BY d`, [WB, WE]).map(r=>`${r.d}=${r.c}`).join(' '));

console.log('[MG samples]');
for (const r of q(`SELECT substr(COALESCE(user_text, content, ''), 1, 60) s, created_at FROM (
    SELECT user_text, NULL AS content, created_at FROM agent_traces WHERE user_id='mg' AND created_at >= ? AND created_at < ?
    UNION ALL SELECT NULL, content, created_at FROM conversation_messages WHERE user_id='mg' AND role='user' AND created_at >= ? AND created_at < ? )
  ORDER BY created_at LIMIT 12`, [WB, WE, WB, WE])) console.log('  ' + r.created_at + ' :: ' + String(r.s).replace(/\n/g,' '));

console.log('[MGREPLAY traces] ' + JSON.stringify(q(`SELECT agent_model m, COUNT(*) n, ROUND(SUM(cost_amount),2) cost, MIN(created_at) a, MAX(created_at) b
  FROM agent_traces WHERE user_id='mgreplay' AND created_at >= ? AND created_at < ? GROUP BY m`, [WB, WE])));
console.log('[MGREPLAY runs] ' + JSON.stringify(q(`SELECT task_id, origin, status, COUNT(*) c FROM automation_task_runs
  WHERE user_id='mgreplay' AND created_at >= ? AND created_at < ? GROUP BY task_id, origin, status`, [WB, WE])));

console.log('[DOUBAO+QWEN38 traces] ' + JSON.stringify(q(`SELECT user_id, agent_model m, date(created_at,'+8 hours') d, COUNT(*) c, ROUND(SUM(cost_amount),2) cost
  FROM agent_traces WHERE agent_model IN ('doubao-seed-2-1-turbo-260628','qwen3.8-flash') AND created_at >= ? AND created_at < ? GROUP BY user_id, m, d`, [WB, WE])));

console.log('[DEEPSEEK traces] ' + JSON.stringify(q(`SELECT user_id, date(created_at,'+8 hours') d, COUNT(*) c, ROUND(SUM(cost_amount),2) cost
  FROM agent_traces WHERE agent_model='deepseek-flash' AND created_at >= ? AND created_at < ? GROUP BY user_id, d`, [WB, WE])));
