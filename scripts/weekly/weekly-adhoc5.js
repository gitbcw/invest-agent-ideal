// 第五跑 adhoc：真实用户消息、失败 run 明细、terra 按日、投递挂起存量、T-551 run 状态
const { DatabaseSync } = require('node:sqlite');
const DB = 'data/runtime.db';
const WB = '2026-09-25T16:00:00.000Z', WE = '2026-10-02T12:10:00.000Z';
function q(sql, p = []) { const db = new DatabaseSync(DB, { readOnly: true }); const r = db.prepare(sql).all(...p); db.close(); return r; }

console.log('=== real user messages (conversation_messages) ===');
for (const r of q("SELECT user_id, created_at, substr(COALESCE(content,''),1,70) s FROM conversation_messages WHERE role='user' AND created_at>=? AND created_at<? ORDER BY created_at", [WB, WE]))
  console.log(r.user_id + ' ' + r.created_at + ' :: ' + String(r.s).replace(/\n/g, ' '));

console.log('=== failed runs detail ===');
for (const r of q("SELECT user_id, task_id, status, error_category, substr(COALESCE(error_message,''),1,100) e, created_at FROM automation_task_runs WHERE created_at>=? AND created_at<? AND status<>'succeeded' ORDER BY created_at", [WB, WE]))
  console.log(JSON.stringify(r));

console.log('=== terra/luna traces by day ===');
for (const r of q("SELECT user_id, date(created_at,'+8 hours') d, agent_model m, COUNT(*) c, ROUND(SUM(cost_amount),3) cost FROM agent_traces WHERE agent_model LIKE 'gpt-5.6%' AND created_at>=? AND created_at<? GROUP BY user_id, d, m ORDER BY d", [WB, WE]))
  console.log(JSON.stringify(r));

console.log('=== mg position-review task current state (T-551) ===');
for (const r of q("SELECT id, task_id, user_id, status, error_category, created_at FROM automation_task_runs WHERE user_id='mg' AND created_at>=? AND created_at<? ORDER BY created_at", [WB, WE]))
  console.log(JSON.stringify(r));

console.log('=== delivery pending backlog now ===');
for (const r of q("SELECT user_id, delivery_status, COUNT(*) c FROM automation_task_runs WHERE delivery_status='pending' GROUP BY user_id, delivery_status"))
  console.log(JSON.stringify(r));
