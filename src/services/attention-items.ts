import { randomUUID } from "node:crypto";

import { sqlite } from "../db/index.js";
import { appendConversationMessage, createConversationSession } from "./conversation-log.js";

/**
 * T-539 失败告知事实（attention_items）。服务拥有：写入只发生在自动化终态
 * 钩子（automation-notify 决策器），去重/恢复/保留由本模块维护；Portal 与
 * 微信只是同一事实的两个投影。除任务恢复自动 resolve 外，用户也可在 Portal
 * 直接手动关闭（closeAttentionItem，幂等）。
 *
 * 语义：
 * - dedup_key = `automation_failure:<taskId>`（每任务唯一一行，唯一索引兜底）；
 *   新失败在 open 时只更新该行计数/状态，已收口（自动恢复/手动关闭）时重开
 *   同一行并清空收口痕迹，不新开行；
 * - 任务成功终态自动 resolve（resolved_run_id 记录消除失败的 run）；
 * - resolved 事项保留展示（网页可查历史），不删除。
 */

export type AttentionStatus = "open" | "resolved";

export interface AttentionScope {
  userId: string;
  projectId: string;
  instanceId: string;
}

export interface AttentionItemRow {
  item_id: string;
  user_id: string;
  project_id: string;
  instance_id: string;
  kind: string;
  dedup_key: string;
  task_id: string | null;
  run_id: string | null;
  title: string;
  impact_summary: string;
  system_status: string;
  error_category: string | null;
  status: AttentionStatus;
  failure_count: number;
  wechat_notified: number;
  first_failed_at: string;
  last_failed_at: string;
  resolved_at: string | null;
  resolved_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttentionItemView {
  itemId: string;
  kind: string;
  taskId: string | null;
  runId: string | null;
  title: string;
  impactSummary: string;
  systemStatus: string;
  errorCategory: string | null;
  status: AttentionStatus;
  failureCount: number;
  wechatNotified: boolean;
  firstFailedAt: string;
  lastFailedAt: string;
  resolvedAt: string | null;
  resolvedRunId: string | null;
}

function toView(row: AttentionItemRow): AttentionItemView {
  return {
    itemId: row.item_id,
    kind: row.kind,
    taskId: row.task_id,
    runId: row.run_id,
    title: row.title,
    impactSummary: row.impact_summary,
    systemStatus: row.system_status,
    errorCategory: row.error_category,
    status: row.status === "resolved" ? "resolved" : "open",
    failureCount: row.failure_count,
    wechatNotified: row.wechat_notified === 1,
    firstFailedAt: row.first_failed_at,
    lastFailedAt: row.last_failed_at,
    resolvedAt: row.resolved_at,
    resolvedRunId: row.resolved_run_id,
  };
}

function taskTitle(taskId: string): string {
  const row = sqlite
    .prepare(
      `SELECT r.name FROM automation_tasks t
       JOIN automation_task_revisions r ON r.revision_id = t.current_revision_id
       WHERE t.task_id = ? AND r.task_id = t.task_id
       ORDER BY r.revision_id DESC LIMIT 1`,
    )
    .get(taskId) as { name: string } | undefined;
  return row?.name ?? taskId;
}

const CATEGORY_IMPACT: Record<string, string> = {
  timeout: "本次自动执行超时，没有产出结果",
  expired: "本次运行超时被系统回收，没有产出结果",
  invalid_input: "本次结果未通过校验，产物没有生成",
  validation_failed: "本次结果未通过校验，产物没有生成",
  dependency_unavailable: "依赖的数据服务暂时不可用，本次没有产出",
  scope_or_permission: "权限不足，本次执行被拒绝",
  transient: "遇到临时错误，本次没有产出",
};

/** 用户语言的直接影响 + 系统当前状态（从任务实时状态推导，不固化技术细节）。 */
function impactFor(errorCategory: string | null): string {
  return (errorCategory && CATEGORY_IMPACT[errorCategory]) || "本次自动执行失败，没有产出结果";
}

function systemStatusFor(scope: AttentionScope, taskId: string): string {
  const task = sqlite
    .prepare(
      `SELECT status, consecutive_failures FROM automation_tasks
       WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?`,
    )
    .get(taskId, scope.userId, scope.projectId, scope.instanceId) as
    | { status: string; consecutive_failures: number }
    | undefined;
  if (!task) return "任务状态未知";
  if (task.status === "needs_attention") return "任务已因连续失败暂停，需要处理后才会恢复";
  if (task.status === "paused") return "任务处于暂停状态";
  if (task.consecutive_failures >= 3) return "连续失败已达到暂停阈值";
  return "系统将按原计划在下一个周期自动重试";
}

/** 失败终态记录/去重更新（dedup_key 每任务一行；resolved 后再失败重开同一行）。返回写入后的行。 */
export function recordAutomationFailureAttention(input: {
  scope: AttentionScope;
  taskId: string;
  runId: string;
  errorCategory: string | null;
  occurredAt?: string;
}): AttentionItemView {
  const now = input.occurredAt ?? new Date().toISOString();
  const dedupKey = `automation_failure:${input.taskId}`;
  const existing = sqlite
    .prepare(
      `SELECT * FROM attention_items
       WHERE user_id=? AND project_id=? AND instance_id=? AND dedup_key=?`,
    )
    .get(input.scope.userId, input.scope.projectId, input.scope.instanceId, dedupKey) as AttentionItemRow | undefined;

  if (existing) {
    if (existing.status !== "open") {
      // 已收口（自动恢复或手动关闭）后再失败：重开同一行，清空收口痕迹与本轮微信标记。
      const reopened = sqlite
        .prepare(
          `UPDATE attention_items
           SET status='open', run_id=?, error_category=?, failure_count=failure_count+1,
               system_status=?, last_failed_at=?, updated_at=?,
               resolved_at=NULL, resolved_run_id=NULL, wechat_notified=0
           WHERE item_id=?`,
        )
        .run(input.runId, input.errorCategory, systemStatusFor(input.scope, input.taskId), now, now, existing.item_id);
      if (reopened.changes !== 1) throw new Error(`attention reopen failed for ${existing.item_id}`);
    } else {
      const updated = sqlite
        .prepare(
          `UPDATE attention_items
           SET run_id=?, error_category=?, failure_count=failure_count+1,
               system_status=?, last_failed_at=?, updated_at=?
           WHERE item_id=?`,
        )
        .run(
          input.runId,
          input.errorCategory,
          systemStatusFor(input.scope, input.taskId),
          now,
          now,
          existing.item_id,
        );
      if (updated.changes !== 1) throw new Error(`attention update failed for ${existing.item_id}`);
    }
    const row = sqlite.prepare("SELECT * FROM attention_items WHERE item_id=?").get(existing.item_id) as AttentionItemRow;
    return toView(row);
  }

  const itemId = `attn_${randomUUID()}`;
  sqlite
    .prepare(
      `INSERT INTO attention_items (
         item_id, user_id, project_id, instance_id, kind, dedup_key, task_id, run_id,
         title, impact_summary, system_status, error_category, status,
         failure_count, wechat_notified, first_failed_at, last_failed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'automation_failure', ?, ?, ?, ?, ?, ?, ?, 'open', 1, 0, ?, ?, ?, ?)`,
    )
    .run(
      itemId,
      input.scope.userId,
      input.scope.projectId,
      input.scope.instanceId,
      dedupKey,
      input.taskId,
      input.runId,
      `定时任务失败：${taskTitle(input.taskId)}`,
      impactFor(input.errorCategory),
      systemStatusFor(input.scope, input.taskId),
      input.errorCategory,
      now,
      now,
      now,
      now,
    );
  const row = sqlite.prepare("SELECT * FROM attention_items WHERE item_id=?").get(itemId) as AttentionItemRow;
  return toView(row);
}

/** 成功终态自动恢复（只处理 open 事项；幂等）。 */
export function resolveAutomationAttention(input: {
  scope: AttentionScope;
  taskId: string;
  runId: string;
  resolvedAt?: string;
}): boolean {
  const now = input.resolvedAt ?? new Date().toISOString();
  const result = sqlite
    .prepare(
      `UPDATE attention_items
       SET status='resolved', resolved_at=?, resolved_run_id=?, system_status='已自动恢复', updated_at=?
       WHERE user_id=? AND project_id=? AND instance_id=? AND dedup_key=? AND status='open'`,
    )
    .run(
      now,
      input.runId,
      now,
      input.scope.userId,
      input.scope.projectId,
      input.scope.instanceId,
      `automation_failure:${input.taskId}`,
    );
  return result.changes > 0;
}

/**
 * 送达兜底事项（T-584，2026-10-10 用户裁决并入）：automation 复盘成果推送挂
 * awaiting_user（微信 48h 客服窗口关闭）时立即登记——成果已生成但微信暂不可达，
 * Portal 待处理成为用户可见落点；推送事后经 resume 成功送达时自动收口。
 * dedup 按 run（一次运行最多一条），幂等。
 */
export function recordDeliveryFallbackAttention(input: {
  scope: AttentionScope;
  taskId: string | null;
  runId: string;
  occurredAt?: string;
}): AttentionItemView {
  const now = input.occurredAt ?? new Date().toISOString();
  const dedupKey = `delivery_fallback:${input.runId}`;
  const existing = sqlite
    .prepare(
      `SELECT * FROM attention_items
       WHERE user_id=? AND project_id=? AND instance_id=? AND dedup_key=?`,
    )
    .get(input.scope.userId, input.scope.projectId, input.scope.instanceId, dedupKey) as AttentionItemRow | undefined;
  if (existing) return toView(existing);
  const displayName = (input.taskId ? safeTaskTitle(input.taskId) : "") || "自动化任务";
  const itemId = `attn_${randomUUID()}`;
  sqlite
    .prepare(
      `INSERT INTO attention_items (
         item_id, user_id, project_id, instance_id, kind, dedup_key, task_id, run_id,
         title, impact_summary, system_status, error_category, status,
         failure_count, wechat_notified, first_failed_at, last_failed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'delivery_fallback', ?, ?, ?, ?, ?, ?, NULL, 'open', 1, 0, ?, ?, ?, ?)`,
    )
    .run(
      itemId,
      input.scope.userId,
      input.scope.projectId,
      input.scope.instanceId,
      dedupKey,
      input.taskId,
      input.runId,
      `复盘成果未送达：${displayName}`,
      "微信通道超时未送达；成果已生成，点击查看完整内容",
      "成果已生成，微信补发窗口已关闭",
      now,
      now,
      now,
      now,
    );
  const row = sqlite.prepare("SELECT * FROM attention_items WHERE item_id=?").get(itemId) as AttentionItemRow;
  return toView(row);
}

/** 推送经 resume 补发成功后自动收口对应兜底事项（只处理 open；幂等）。 */
export function resolveDeliveryFallbackAttentionByRun(scope: AttentionScope, runId: string, resolvedAt?: string): boolean {
  const now = resolvedAt ?? new Date().toISOString();
  const result = sqlite
    .prepare(
      `UPDATE attention_items
       SET status='resolved', resolved_at=?, resolved_run_id=?, system_status='微信已补发送达', updated_at=?
       WHERE user_id=? AND project_id=? AND instance_id=? AND kind='delivery_fallback' AND run_id=? AND status='open'`,
    )
    .run(now, runId, now, scope.userId, scope.projectId, scope.instanceId, runId);
  return result.changes > 0;
}

function safeTaskTitle(taskId: string): string {
  try {
    return taskTitle(taskId) || "";
  } catch {
    return "";
  }
}

/**
 * 用户手动关闭关注项（不开问题处理会话直接丢弃）。
 * 2026-10-08 用户裁决：手动关闭的行直接删除，不保留「已关闭」历史；
 * 任务再次失败时 recordAutomationFailureAttention 按 dedup_key 重新生成。
 * 幂等：行不存在（含已被丢弃）时同样视为成功。
 */
export function closeAttentionItem(scope: AttentionScope, itemId: string): { discarded: true } {
  sqlite
    .prepare(
      `DELETE FROM attention_items
       WHERE item_id=? AND user_id=? AND project_id=? AND instance_id=?`,
    )
    .run(itemId, scope.userId, scope.projectId, scope.instanceId);
  return { discarded: true };
}

/** 微信首条提醒发出后回写（事实记录，不影响事项状态）。 */
export function markAttentionWechatNotified(scope: AttentionScope, taskId: string): void {
  sqlite
    .prepare(
      `UPDATE attention_items SET wechat_notified=1, updated_at=?
       WHERE user_id=? AND project_id=? AND instance_id=? AND dedup_key=? AND status='open'`,
    )
    .run(new Date().toISOString(), scope.userId, scope.projectId, scope.instanceId, `automation_failure:${taskId}`);
}

export function listAttentionItems(
  scope: AttentionScope,
  options: { status?: AttentionStatus; limit?: number } = {},
): AttentionItemView[] {
  const status = options.status ?? "open";
  const rows = sqlite
    .prepare(
      `SELECT * FROM attention_items
       WHERE user_id=? AND project_id=? AND instance_id=? AND status=?
       ORDER BY last_failed_at DESC LIMIT ?`,
    )
    .all(scope.userId, scope.projectId, scope.instanceId, status, options.limit ?? 100) as AttentionItemRow[];
  return rows.map(toView);
}

export function getAttentionItem(scope: AttentionScope, itemId: string): AttentionItemView | null {
  const row = sqlite
    .prepare(
      `SELECT * FROM attention_items
       WHERE item_id=? AND user_id=? AND project_id=? AND instance_id=?`,
    )
    .get(itemId, scope.userId, scope.projectId, scope.instanceId) as AttentionItemRow | undefined;
  return row ? toView(row) : null;
}

export function countOpenAttention(scope: AttentionScope): number {
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM attention_items
       WHERE user_id=? AND project_id=? AND instance_id=? AND status='open'`,
    )
    .get(scope.userId, scope.projectId, scope.instanceId) as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// 通知偏好（§8）：偏好只影响提醒投递，不改变事项事实、任务状态、运行或授权。
// ---------------------------------------------------------------------------

export interface NotificationPreferences {
  wechatFailureEnabled: boolean;
  wechatRecoveryEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  categories: string[] | null;
  defaultDeliveryMode: "wechat" | "none";
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  wechatFailureEnabled: true,
  wechatRecoveryEnabled: false, // T-539：成功与自动恢复默认不打扰（设计 §7.2）
  quietHoursStart: null,
  quietHoursEnd: null,
  categories: null,
  defaultDeliveryMode: "none",
};

export function getNotificationPreferences(scope: AttentionScope): NotificationPreferences {
  const row = sqlite
    .prepare(
      `SELECT wechat_failure_enabled, wechat_recovery_enabled, quiet_hours_start, quiet_hours_end, categories_json, default_delivery_mode
       FROM notification_preferences WHERE user_id=? AND project_id=? AND instance_id=?`,
    )
    .get(scope.userId, scope.projectId, scope.instanceId) as
    | {
        wechat_failure_enabled: number;
        wechat_recovery_enabled: number;
        quiet_hours_start: string | null;
        quiet_hours_end: string | null;
        categories_json: string | null;
        default_delivery_mode: string | null;
      }
    | undefined;
  if (!row) return { ...DEFAULT_PREFERENCES };
  return {
    wechatFailureEnabled: row.wechat_failure_enabled === 1,
    wechatRecoveryEnabled: row.wechat_recovery_enabled === 1,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    categories: row.categories_json ? (JSON.parse(row.categories_json) as string[]) : null,
    defaultDeliveryMode: row.default_delivery_mode === "wechat" ? "wechat" : "none",
  };
}

export function updateNotificationPreferences(
  scope: AttentionScope,
  patch: Partial<Pick<NotificationPreferences, "wechatFailureEnabled" | "wechatRecoveryEnabled" | "quietHoursStart" | "quietHoursEnd" | "categories" | "defaultDeliveryMode">>,
): NotificationPreferences {
  const current = getNotificationPreferences(scope);
  const next: NotificationPreferences = {
    wechatFailureEnabled: patch.wechatFailureEnabled ?? current.wechatFailureEnabled,
    wechatRecoveryEnabled: patch.wechatRecoveryEnabled ?? current.wechatRecoveryEnabled,
    quietHoursStart: patch.quietHoursStart !== undefined ? patch.quietHoursStart : current.quietHoursStart,
    quietHoursEnd: patch.quietHoursEnd !== undefined ? patch.quietHoursEnd : current.quietHoursEnd,
    categories: patch.categories !== undefined ? patch.categories : current.categories,
    defaultDeliveryMode: patch.defaultDeliveryMode ?? current.defaultDeliveryMode,
  };
  sqlite
    .prepare(
      `INSERT INTO notification_preferences (
         user_id, project_id, instance_id,
         wechat_failure_enabled, wechat_recovery_enabled, quiet_hours_start, quiet_hours_end, categories_json, default_delivery_mode, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, project_id, instance_id) DO UPDATE SET
         wechat_failure_enabled=excluded.wechat_failure_enabled,
         wechat_recovery_enabled=excluded.wechat_recovery_enabled,
         quiet_hours_start=excluded.quiet_hours_start,
         quiet_hours_end=excluded.quiet_hours_end,
         categories_json=excluded.categories_json,
         default_delivery_mode=excluded.default_delivery_mode,
         updated_at=excluded.updated_at`,
    )
    .run(
      scope.userId,
      scope.projectId,
      scope.instanceId,
      next.wechatFailureEnabled ? 1 : 0,
      next.wechatRecoveryEnabled ? 1 : 0,
      next.quietHoursStart,
      next.quietHoursEnd,
      next.categories ? JSON.stringify(next.categories) : null,
      next.defaultDeliveryMode,
      new Date().toISOString(),
    );
  return next;
}

// ---------------------------------------------------------------------------
// T-540 问题处理会话：失败事项 → 受限绑定会话（脱敏摘要注入，不混入闲聊，
// 不展示错误码/trace/重试次数/内部版本；Agent 在会话内解释并提出方案，
// 后续持久修改仍走各对象版本与授权契约）。
// ---------------------------------------------------------------------------

export interface AttentionConversation {
  conversationId: string;
  itemId: string;
  /** 同一失败事项复用同一会话（不重复开新对话）。 */
  reused: boolean;
}

export function openAttentionConversation(scope: AttentionScope, itemId: string): AttentionConversation {
  const item = getAttentionItem(scope, itemId);
  if (!item) throw new Error(`ATTENTION_NOT_FOUND:${itemId}`);

  // 复用：会话 metadata 绑定该事项的既有 web 会话
  const existing = sqlite
    .prepare(
      `SELECT conversation_id FROM conversation_sessions
       WHERE user_id=? AND project_id=? AND instance_id=?
         AND json_extract(metadata, '$.attentionItemId') = ?
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(scope.userId, scope.projectId, scope.instanceId, itemId) as { conversation_id: string } | undefined;
  if (existing) return { conversationId: existing.conversation_id, itemId, reused: true };

  const conversationId = `attention-${item.itemId.slice(5, 17)}-${randomUUID().slice(0, 8)}`;
  createConversationSession({
    scope,
    conversationId,
    channel: "web",
    title: `问题处理：${item.title}`,
    metadata: {
      attentionItemId: item.itemId,
      taskId: item.taskId,
      runId: item.runId,
      origin: "attention_issue",
    },
  });
  if (item.kind === "delivery_fallback") {
    // 送达兜底会话：完整复盘内容按 run_id 回查 push_jobs 原文（单一数据源，
    // 不在 attention 行冗余长文）；首答原样呈现内容，再询问是否深入。
    const pushMessage = item.runId
      ? (sqlite
          .prepare(
            `SELECT message FROM push_jobs
             WHERE user_id=? AND project_id=? AND instance_id=? AND origin_run_id=? AND message_kind='automation_summary'
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(scope.userId, scope.projectId, scope.instanceId, item.runId) as { message: string } | undefined)?.message
      : undefined;
    appendConversationMessage({
      scope,
      conversationId,
      channel: "web",
      role: "system",
      content: [
        `这是「${item.title}」的复盘成果会话：该成果微信通道超时未送达，内容在下面。`,
        pushMessage
          ? `【复盘内容】\n${pushMessage}\n【要求】请把上述复盘内容原样、完整地呈现给用户（保留结构与数字，不要删减或改写结论），呈现后询问用户是否需要针对内容做进一步分析或调整提醒方式。`
          : "【要求】原始推送内容已不可查（可能已被清理）。请向用户说明这份复盘成果的微信推送超时未送达，引导用户在 Portal 的文件/报告资产中查看当期产出；如找不到再协助定位。",
      ].join("\n"),
      metadata: { attentionItemId: item.itemId, taskId: item.taskId, runId: item.runId, origin: "attention_issue" },
    });
    return { conversationId, itemId, reused: false };
  }
  appendConversationMessage({
    scope,
    conversationId,
    channel: "web",
    role: "system",
    content: [
      `这是失败事项「${item.title}」的问题处理会话。`,
      `发生时间：${item.lastFailedAt}；累计失败 ${item.failureCount} 次。`,
      `直接影响：${item.impactSummary}`,
      `当前系统状态：${item.status === "open" ? item.systemStatus : "已自动恢复（历史事项）"}。`,
      "请用用户能理解的语言解释这次失败的原因、影响与现在的恢复状态，并提出可选的处理方案（重试、修改任务、暂停或归档）。如发现可复用的处置方法，可以提交改进候选；候选需用户批准才会生效。不要展示错误码、堆栈或内部版本号，也不要建议当前界面不存在的删除操作。",
    ].join("\n"),
    metadata: { attentionItemId: item.itemId, taskId: item.taskId, runId: item.runId, origin: "attention_issue" },
  });
  return { conversationId, itemId, reused: false };
}
