#!/usr/bin/env node
/* 本周窗口聚合：usage + token，本周 + 上周同长度环比基数。
 * 本周：周六00:00(北京) → 周五20:10(北京)；上周基数：终点前推 7 天同长度。
 * 全部 UTC 比较：本周 [WB, WE]，上周 [WB-7d, WE-7d]。 */
const { DatabaseSync } = require('node:sqlite');
const DB = 'data/runtime.db';

// ===== 窗口（北京 → UTC）=====
const wb = '2026-10-03T00:00:00'; // 北京周六 00:00
const we = '2026-10-09T20:10:00'; // 北京周五 20:10
const toUTC = (b) => new Date(b + '+08:00').toISOString();
const WB = toUTC(wb), WE = toUTC(we);
const PB = new Date(new Date(WB).getTime() - 7 * 86400000).toISOString();
const PE = new Date(new Date(WE).getTime() - 7 * 86400000).toISOString();

function q(sql, params = []) {
  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db.prepare(sql).all(...params);
  db.close();
  return rows;
}

const users = ['mg', 'dyk', '111', 'mgreplay'];

console.log('=== window: week [' + WB + ' ~ ' + WE + ']  prev [' + PB + ' ~ ' + PE + '] ===');

// ===== 板块一：用户消息量（role=user）=====
for (const [label, a, b] of [['THIS', WB, WE], ['PREV', PB, PE]]) {
  const rows = q(`SELECT user_id, COUNT(*) c FROM conversation_messages
    WHERE role='user' AND created_at >= ? AND created_at < ? GROUP BY user_id`, [a, b]);
  const f = rows.filter(r => users.includes(r.user_id));
  const skipped = rows.filter(r => !users.includes(r.user_id));
  console.log(`[MSG ${label}] ` + f.map(r => `${r.user_id}=${r.c}`).join(' ')
    + (skipped.length ? `  (excluded: ${skipped.map(r => r.user_id + '=' + r.c).join(',')})` : ''));
}

// ===== 板块一：每日消息分布 + 每用户最后活跃 =====
console.log('[MSG daily this week] ' + q(`SELECT date(created_at, '+8 hours') d, COUNT(*) c
  FROM conversation_messages WHERE role='user' AND created_at >= ? AND created_at < ? GROUP BY d ORDER BY d`, [WB, WE])
  .map(r => `${r.d}=${r.c}`).join(' '));
console.log('[LAST SEEN] ' + q(`SELECT user_id, MAX(created_at) last FROM conversation_messages
  WHERE role='user' AND user_id IN ('mg','dyk','111') GROUP BY user_id`).map(r => `${r.user_id}=${r.last}`).join(' | '));

// ===== 板块一：自动化 run 成功/失败（本周明细 + 日分布）=====
const runRows = q(`SELECT user_id, status, error_category, date(created_at, '+8 hours') d, COUNT(*) c
  FROM automation_task_runs WHERE created_at >= ? AND created_at < ? GROUP BY user_id, status, d
  ORDER BY user_id, d`, [WB, WE]);
console.log('[RUNS this week by user/status/day]');
const byUser = {};
for (const r of runRows) {
  const u = byUser[r.user_id] || (byUser[r.user_id] = { s: 0, f: 0, days: {} });
  if (r.status === 'succeeded') u.s += r.c; else u.f += r.c;
  u.days[r.d] = (u.days[r.d] || 0) + r.c;
}
for (const [uid, u] of Object.entries(byUser)) {
  console.log(`  ${uid}: OK=${u.s} FAIL=${u.f} days=${JSON.stringify(u.days)}`);
}

// ===== 板块一/四：run 失败分类与投递状态（本周）=====
console.log('[FAIL CATS] ' + JSON.stringify(q(`SELECT user_id, status, error_category, COUNT(*) c
  FROM automation_task_runs WHERE created_at >= ? AND created_at < ? AND status <> 'succeeded' GROUP BY user_id, status, error_category`, [WB, WE])));
console.log('[DELIVERY] ' + JSON.stringify(q(`SELECT user_id, delivery_status, COUNT(*) c
  FROM automation_task_runs WHERE created_at >= ? AND created_at < ? GROUP BY user_id, delivery_status`, [WB, WE])));

// ===== 板块一：上周 run 基数 =====
const prev = q(`SELECT user_id,
  SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) s,
  SUM(CASE WHEN status<>'succeeded' THEN 1 ELSE 0 END) f
  FROM automation_task_runs WHERE created_at >= ? AND created_at < ? GROUP BY user_id`, [PB, PE]);
console.log('[RUNS prev week] ' + prev.map(r => `${r.user_id} OK=${r.s} FAIL=${r.f}`).join(' | '));

// ===== 板块二：token/成本（按用户 + 按模型）=====
for (const [label, a, b] of [['THIS', WB, WE], ['PREV', PB, PE]]) {
  const t = q(`SELECT COUNT(*) n, SUM(input_tokens) it, SUM(output_tokens) ot, SUM(thought_tokens) tt,
    SUM(cached_read_tokens) crt, SUM(total_tokens) tot, SUM(cost_amount) cost
    FROM agent_traces WHERE created_at >= ? AND created_at < ?`, [a, b])[0] || {};
  const byUserT = q(`SELECT user_id, COUNT(*) n, SUM(cost_amount) cost, SUM(total_tokens) tot
    FROM agent_traces WHERE created_at >= ? AND created_at < ? GROUP BY user_id ORDER BY cost DESC`, [a, b]);
  const byModel = q(`SELECT agent_model m, COUNT(*) n, SUM(cost_amount) cost, SUM(total_tokens) tot,
    ROUND(SUM(cost_amount)/COUNT(*), 3) avg
    FROM agent_traces WHERE created_at >= ? AND created_at < ? GROUP BY agent_model ORDER BY cost DESC`, [a, b]);
  console.log(`[TOKEN ${label}] total: n=${t.n} cost=${t.cost} totTok=${t.tot} in=${t.it} out=${t.ot} think=${t.tt} cacheRead=${t.crt}`);
  console.log('  byUser: ' + byUserT.map(r => `${r.user_id} n=${r.n} cost=${r.cost} tok=${r.tot}`).join(' | '));
  console.log('  byModel: ' + byModel.map(r => `${r.m} n=${r.n} cost=${r.cost} avg=${r.avg} tok=${r.tot}`).join(' | '));
}

// ===== 板块二：本周成本日分布（找峰值日）=====
const daily = q(`SELECT date(created_at, '+8 hours') d, COUNT(*) n, ROUND(SUM(cost_amount), 2) cost
  FROM agent_traces WHERE created_at >= ? AND created_at < ? GROUP BY d ORDER BY d`, [WB, WE]);
console.log('[DAILY COST this week]');
for (const r of daily) console.log(`  ${r.d}: n=${r.n} cost=${r.cost}`);
