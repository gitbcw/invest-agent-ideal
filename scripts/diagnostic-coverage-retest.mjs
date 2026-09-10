#!/usr/bin/env node
/**
 * 诊断覆盖率复测脚本（T-474 / GAP-1/2 修复验证）
 *
 * 口径：docs/diagnostic-coverage-report-2026-09-06.md（基线）——只用显式 ID 相等，
 * 时间邻近不参与任何覆盖率计算；n.a. 白名单（rule-alert-check / data-quality-summary、
 * reviews.save 定时产物、模型前过期失败）剔除分母并单独计数。
 *
 * 运行方式（与每日巡查同纪律，全程只读，不在服务器落文件）：
 *   ssh claude@118.145.115.197 "cd /home/claude/invest-agent-mastra && node --input-type=module" \
 *     < scripts/diagnostic-coverage-retest.mjs [--start 2026-09-06T02:04] [--end <now>]
 *
 * 默认窗口起点 = 2afb5e0f 发布完成时刻（2026-09-06T02:04Z，GAP-1/2 修复上线）。
 */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const START = arg("start", "2026-09-06T02:04");
const END = arg("end", new Date().toISOString().slice(0, 16)); // 含缓冲的"现在"

const { createRequire } = await import("node:module");
const db = createRequire(process.cwd() + "/retest.mjs")("better-sqlite3")("data/runtime.db", { readonly: true });

const out = {};
const q = (label, sql, params = []) => {
  try {
    out[label] = db.prepare(sql).all(...params);
  } catch (error) {
    out[label] = [{ ERROR: error.message }];
  }
};
const one = (label, sql, params = []) => {
  try {
    out[label] = db.prepare(sql).get(...params);
  } catch (error) {
    out[label] = { ERROR: error.message };
  }
};

const W = [START, END];

// ── 0. 表结构自证（分母列名核对）──────────────────────────────────────────
for (const t of [
  "agent_traces", "conversation_messages", "external_mcp_tool_calls",
  "sandbox_audit_logs", "automation_task_runs", "push_jobs",
  "weixin_delivery_attempts", "scheduled_task_runs", "conversation_artifacts",
]) {
  one(`cols__${t}`, "select group_concat(name, ' | ') c from pragma_table_info(?)", [t]);
}

// ── 1. agent_traces 总览 ────────────────────────────────────────────────────
one("traces_total",
  "select count(*) n, sum(case when trace_id is null or trace_id='' then 1 else 0 end) no_trace_id, " +
  "sum(case when conversation_id is null or conversation_id='' or conversation_id='unknown' then 1 else 0 end) no_conversation " +
  "from agent_traces where created_at >= ? and created_at < ?", W);
q("traces_by_channel",
  "select channel, count(*) n, sum(case when trace_id is null or trace_id='' then 1 else 0 end) no_trace_id " +
  "from agent_traces where created_at >= ? and created_at < ? group by channel", W);
q("traces_by_day",
  "select substr(created_at,1,10) day, count(*) n from agent_traces where created_at >= ? and created_at < ? group by day order by day", W);

// GAP-1 修复形态：微信轮 trace_id 应全部为统一键（weixin-inbound:* 或 wx-turn:* 兜底）。
// 旧 `wx-<纯数字时间戳>` 形态若再现即为回归信号。
one("weixin_traces_key_shape",
  "select count(*) n, " +
  "sum(case when trace_id like 'weixin-inbound:%' then 1 else 0 end) as envelope_key, " +
  "sum(case when trace_id like 'wx-turn:%' then 1 else 0 end) as turn_fallback, " +
  "sum(case when trace_id like 'wx-%' and trace_id not like 'wx-turn:%' and trace_id not like 'weixin-inbound:%' then 1 else 0 end) as legacy_wx_ts, " +
  "sum(case when trace_id is null or trace_id='' then 1 else 0 end) as empty, " +
  "sum(case when trace_id not like 'weixin-inbound:%' and trace_id not like 'wx-turn:%' and (trace_id not like 'wx-%' or trace_id is null or trace_id='') then 1 else 0 end) as other_shape " +
  "from agent_traces where channel like 'weixin%' and created_at >= ? and created_at < ?", W);
// 微信轮三方同键核对：trace.message_id 与 trace_id 相等（消息写入方同键的必要条件）
one("weixin_traces_msg_key_eq",
  "select count(*) n, sum(case when message_id = trace_id then 1 else 0 end) msg_key_eq_trace " +
  "from agent_traces where channel like 'weixin%' and created_at >= ? and created_at < ?", W);

// ── 2. GAP-1：微信助手消息 / MCP 工具调用反链 ─────────────────────────────
one("weixin_assistant_msg_link",
  "select count(*) n, " +
  "sum(case when m.request_id is not null and m.request_id in (select trace_id from agent_traces) then 1 else 0 end) req_resolves_trace, " +
  "sum(case when m.trace_id is not null and m.trace_id in (select trace_id from agent_traces) then 1 else 0 end) trace_col_resolves, " +
  "sum(case when m.request_id is null or m.request_id='' then 1 else 0 end) no_request_id " +
  "from conversation_messages m where m.channel like 'weixin%' and m.role='assistant' and m.created_at >= ? and m.created_at < ?", W);
one("weixin_user_msg_link",
  "select count(*) n, sum(case when m.request_id in (select trace_id from agent_traces) then 1 else 0 end) req_resolves_trace " +
  "from conversation_messages m where m.channel like 'weixin%' and m.role='user' and m.created_at >= ? and m.created_at < ?", W);

one("mcp_calls_total",
  "select count(*) n, sum(case when run_id is null or run_id='' then 1 else 0 end) no_run_id, " +
  "sum(case when status='completed' then 1 else 0 end) completed, sum(case when status<>'completed' then 1 else 0 end) not_completed " +
  "from external_mcp_tool_calls where created_at >= ? and created_at < ?", W);
one("mcp_calls_unresolved",
  "select count(*) n from external_mcp_tool_calls c " +
  "where c.created_at >= ? and c.created_at < ? " +
  "and not exists (select 1 from agent_traces t where t.trace_id = c.run_id or t.run_id = c.run_id) " +
  "and not exists (select 1 from automation_task_runs a where a.run_id = c.run_id) " +
  "and not exists (select 1 from scheduled_task_runs s where s.task_key = c.run_id)", W);
q("mcp_unresolved_by_key_shape",
  "select case when run_id like 'weixin-inbound:%' then 'envelope' when run_id like 'wx-turn:%' then 'turn_fallback' " +
  "when run_id like 'wx-%' then 'legacy_wx' when run_id is null or run_id='' then 'empty' else 'other' end shape, count(*) n " +
  "from external_mcp_tool_calls c " +
  "where c.created_at >= ? and c.created_at < ? " +
  "and not exists (select 1 from agent_traces t where t.trace_id = c.run_id or t.run_id = c.run_id) " +
  "and not exists (select 1 from automation_task_runs a where a.run_id = c.run_id) " +
  "and not exists (select 1 from scheduled_task_runs s where s.task_key = c.run_id) " +
  "group by shape", W);
// GAP-1 核心口径：微信键形态（envelope/turn_fallback）的调用中未解析条数——修复后必须为 0
one("mcp_weixin_key_unresolved",
  "select count(*) n from external_mcp_tool_calls c " +
  "where c.created_at >= ? and c.created_at < ? " +
  "and (c.run_id like 'weixin-inbound:%' or c.run_id like 'wx-turn:%') " +
  "and not exists (select 1 from agent_traces t where t.trace_id = c.run_id or t.run_id = c.run_id)", W);
q("mcp_unresolved_status_breakdown",
  "select c.status, count(*) n from external_mcp_tool_calls c " +
  "where c.created_at >= ? and c.created_at < ? " +
  "and not exists (select 1 from agent_traces t where t.trace_id = c.run_id or t.run_id = c.run_id) " +
  "and not exists (select 1 from automation_task_runs a where a.run_id = c.run_id) " +
  "and not exists (select 1 from scheduled_task_runs s where s.task_key = c.run_id) " +
  "group by c.status", W);

// ── 3. audit 覆盖率（S7 率一）──────────────────────────────────────────────
one("audit_coverage",
  "select count(*) n, " +
  "sum(case when trace_id is null or trace_id='' then 1 else 0 end) without_trace_id, " +
  "sum(case when trace_id is not null and trace_id in (select trace_id from agent_traces) then 1 else 0 end) trace_resolves, " +
  "sum(case when (trace_id is null or trace_id='' or trace_id not in (select trace_id from agent_traces)) and conversation_id is not null and conversation_id in (select conversation_id from agent_traces) then 1 else 0 end) conversation_fallback " +
  "from sandbox_audit_logs where created_at >= ? and created_at < ?", W);
q("audit_unresolved_sample",
  "select id, created_at, operation, resource_type, role, channel, substr(coalesce(trace_id,''),1,40) trace_id_head " +
  "from sandbox_audit_logs where created_at >= ? and created_at < ? " +
  "and (trace_id is null or trace_id='' or trace_id not in (select trace_id from agent_traces)) limit 10", W);
q("audit_by_day",
  "select substr(created_at,1,10) day, count(*) n, sum(case when trace_id is null or trace_id='' then 1 else 0 end) without_trace_id " +
  "from sandbox_audit_logs where created_at >= ? and created_at < ? group by day order by day", W);

// ── 4. automation trace 关联率（S7 率二）───────────────────────────────────
one("automation_link",
  "select count(*) n, " +
  "sum(case when trace_id is not null and trace_id in (select trace_id from agent_traces) then 1 else 0 end) trace_resolves, " +
  "sum(case when (trace_id is null or trace_id='' or trace_id not in (select trace_id from agent_traces)) then 1 else 0 end) no_trace_link " +
  "from automation_task_runs where created_at >= ? and created_at < ?", W);
q("automation_no_trace_detail",
  "select run_id, created_at, status, origin, coalesce(error_category,'') ec, " +
  "case when push_job_id is null then 0 else 1 end has_push " +
  "from automation_task_runs where created_at >= ? and created_at < ? " +
  "and (trace_id is null or trace_id='' or trace_id not in (select trace_id from agent_traces)) limit 20", W);
one("automation_expired_notrace",
  "select count(*) n from automation_task_runs where created_at >= ? and created_at < ? " +
  "and (trace_id is null or trace_id='') and error_category='expired'", W);
q("automation_status",
  "select status, count(*) n from automation_task_runs where created_at >= ? and created_at < ? group by status", W);
q("automation_error_category",
  "select coalesce(error_category,'(null)') ec, count(*) n from automation_task_runs where created_at >= ? and created_at < ? and status not in ('succeeded') group by ec", W);

// ── 5. push / delivery 关联率（S7 率三）+ 重复推送检查 ─────────────────────
one("push_origin_link",
  "select count(*) n, sum(case when origin_run_id is not null and origin_run_id<>'' then 1 else 0 end) has_origin_run, " +
  "sum(case when (origin_run_id is null or origin_run_id='') and origin_task_key is not null and origin_task_key<>'' then 1 else 0 end) origin_task_only, " +
  "sum(case when (origin_run_id is null or origin_run_id='') and (origin_task_key is null or origin_task_key='') then 1 else 0 end) no_origin " +
  "from push_jobs where created_at >= ? and created_at < ?", W);
q("push_status",
  "select status, count(*) n from push_jobs where created_at >= ? and created_at < ? group by status", W);
one("delivery_link",
  "select count(*) n, sum(case when push_job_id is null or push_job_id='' then 1 else 0 end) no_push_link, " +
  "sum(case when push_job_id is not null and push_job_id in (select id from push_jobs) then 1 else 0 end) push_resolves, " +
  "sum(case when push_job_id is not null and push_job_id not in (select id from push_jobs) then 1 else 0 end) push_dangling " +
  "from weixin_delivery_attempts where created_at >= ? and created_at < ?", W);
q("delivery_result",
  "select result, count(*) n from weixin_delivery_attempts where created_at >= ? and created_at < ? group by result", W);
// 重复推送：同一 push_job 有 >1 条 result='sent' 的投递尝试
q("duplicate_sent_per_push",
  "select push_job_id, count(*) sent_count from weixin_delivery_attempts " +
  "where created_at >= ? and created_at < ? and result='sent' group by push_job_id having count(*) > 1 limit 10", W);
// 同一 origin_run+message_kind 产生多个 push（可能重复副作用）
q("push_dup_origin_kind",
  "select origin_run_id, message_kind, count(*) n from push_jobs where created_at >= ? and created_at < ? " +
  "and origin_run_id is not null group by origin_run_id, message_kind having count(*) > 1 limit 10", W);

// ── 6. GAP-2：scheduler 口径（n.a. 过滤 + NA 计数）────────────────────────
q("scheduled_by_type",
  "select task_type, count(*) n, sum(case when status='success' then 1 else 0 end) success " +
  "from scheduled_task_runs where created_at >= ? and created_at < ? group by task_type", W);
one("scheduler_non_na_link",
  "select count(*) n, " +
  "sum(case when exists (select 1 from agent_traces t where t.run_id = s.task_key) then 1 else 0 end) with_trace_link " +
  "from scheduled_task_runs s where created_at >= ? and created_at < ? " +
  "and task_type not in ('rule-alert-check','data-quality-summary')", W);
one("scheduler_na",
  "select count(*) n from scheduled_task_runs where created_at >= ? and created_at < ? " +
  "and task_type in ('rule-alert-check','data-quality-summary')", W);

// ── 7. artifacts ───────────────────────────────────────────────────────────
one("artifacts_link",
  "select count(*) n, sum(case when message_id is null or message_id='' then 1 else 0 end) no_message_link, " +
  "sum(case when conversation_id is null or conversation_id='' then 1 else 0 end) no_conversation " +
  "from conversation_artifacts where created_at >= ? and created_at < ?", W);
q("artifacts_no_message_by_source",
  "select source, count(*) n from conversation_artifacts where created_at >= ? and created_at < ? " +
  "and (message_id is null or message_id='') group by source", W);

// ── 8. GAP-2 平台指标模拟（loadDiagnosticCoverage 30 天口径）──────────────
const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
one("platform_diag_coverage_30d",
  "select " +
  "(select count(*) from sandbox_audit_logs where created_at >= ?) audits_total, " +
  "(select count(*) from sandbox_audit_logs where created_at >= ? and trace_id is not null) audits_with_trace, " +
  "(select count(*) from scheduled_task_runs where created_at >= ? and task_type not in ('rule-alert-check','data-quality-summary')) sched_non_na, " +
  "(select count(*) from scheduled_task_runs s where created_at >= ? and task_type not in ('rule-alert-check','data-quality-summary') and exists (select 1 from agent_traces t where t.run_id = s.task_key)) sched_with_trace, " +
  "(select count(*) from scheduled_task_runs where created_at >= ? and task_type in ('rule-alert-check','data-quality-summary')) sched_na",
  [since30, since30, since30, since30, since30]);

db.close();
console.log(JSON.stringify({ start: START, end: END, generated_at: new Date().toISOString(), result: out }, null, 1));
