import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { sqlite } from "../db/index.js";
import { isAshareTradingDay } from "../lib/market-calendar.js";
import { ensureWorkspace, resolveWorkspacePath } from "../lib/workspace.js";
import { ACTIVE_BACKEND } from "../lib/data-backend.js";
import { mastraWorkspaceRegistry } from "../mastra/workspace-registry.js";
import { AutomationSpreadsheetValidationError, validateAutomationSpreadsheet } from "./automation-spreadsheet.js";
import { isRegisteredScheduledTaskType } from "./scheduled-task-types.js";
import {
  assetFormatForFileName,
  getUserAsset,
  readUserAssetVersion,
  UserAssetError,
  type AssetFormat,
} from "./user-assets.js";

const DEFAULT_ASSET_MAX_BYTES = 25 * 1024 * 1024;
const MAX_ASSET_BYTES = positiveInteger(process.env.AUTOMATION_TASK_ASSET_MAX_BYTES, DEFAULT_ASSET_MAX_BYTES);
const MAX_TASK_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 12_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 500;
const DEFAULT_AUTOMATION_TIMEZONE = "Asia/Shanghai";
/**
 * A run owns the task execution lease for this long.  The lease is persisted
 * in SQLite, rather than kept in the scheduler process, so a different
 * process can recover a run after the owner disappears.  Deployments with a
 * known ACP upper bound may override this value, while keeping it bounded.
 */
const DEFAULT_AUTOMATION_RUN_LEASE_MS = 15 * 60 * 1000;
const AUTOMATION_RUN_LEASE_MS = positiveInteger(process.env.AUTOMATION_TASK_LEASE_MS, DEFAULT_AUTOMATION_RUN_LEASE_MS);

export type AutomationTaskStatus = "paused" | "active" | "needs_attention" | "archived";
export type AutomationTaskRunOrigin = "manual" | "scheduled";
export type AutomationTaskRunStatus = "running" | "succeeded" | "failed" | "skipped" | "cancelled";
export type AutomationErrorCategory =
  | "transient"
  | "timeout"
  | "dependency_unavailable"
  | "invalid_input"
  | "validation_failed"
  | "scope_or_permission"
  | "expired"
  | "cancelled"
  | "unknown";
export type AutomationTaskAssetRole = "source" | "working";
export type AutomationTaskVersionPolicy = "latest" | "fixed";

export interface AutomationTaskAssetBinding {
  assetId: string;
  role: "input" | "update_target";
  versionPolicy: AutomationTaskVersionPolicy;
  versionId?: string;
}

export type AutomationTaskOutputPolicy =
  | { mode: "none" }
  /** The Agent may update a latest-version input or create one related asset. */
  | { mode: "agent" }
  | { mode: "create"; format: AssetFormat; fileName: string; titleTemplate?: string }
  | { mode: "update"; assetId: string; versionPolicy: "latest"; expectedVersionId?: string };

export type AutomationTaskDeliveryPolicy =
  | { mode: "none" }
  | { mode: "wechat_summary" }
  | { mode: "wechat_on_condition"; conditionVersion: 1 };

export interface AutomationScope {
  userId: string;
  instanceId: string;
  projectId: string;
}

export interface AutomationSchedule {
  frequency: "daily" | "trading_days" | "weekdays" | "weekly" | "monthly";
  time: string;
  timezone: string;
  weekdays?: number[];
  /** For monthly frequency: day of month 1..28 (avoids short-month overflow). */
  monthlyDay?: number;
  /** Additional same-day trigger points (HH:mm), e.g. market-watch intraday windows. */
  windows?: string[];
  [key: string]: unknown;
}

export interface AutomationTaskAssetInput {
  fileName: string;
  mimeType?: string;
  bytes: Uint8Array;
}

export interface AutomationTaskAssetRecord extends AutomationScope {
  assetId: string;
  taskId: string;
  revisionId?: string | null;
  assetRole: AutomationTaskAssetRole;
  fileName: string;
  relativePath: string;
  mimeType: string;
  extension: ".csv" | ".xlsx";
  sizeBytes: number;
  checksum: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationTaskRevisionRecord extends AutomationScope {
  revisionId: string;
  taskId: string;
  revision: number;
  name: string;
  description?: string | null;
  instruction: string;
  schedule: AutomationSchedule;
  inputs: AutomationTaskAssetBinding[];
  output: AutomationTaskOutputPolicy;
  delivery: AutomationTaskDeliveryPolicy;
  sourceAssetId?: string | null;
  workingAssetId?: string | null;
  createdAt: string;
}

export interface AutomationTaskRecord extends AutomationScope {
  taskId: string;
  /** Registered scheduled task type; null for plain generic tasks. */
  taskType?: string | null;
  status: AutomationTaskStatus;
  currentRevision: number;
  currentRevisionId?: string | null;
  nextRunAt?: string | null;
  consecutiveFailures: number;
  revision: AutomationTaskRevisionRecord;
  sourceAsset?: AutomationTaskAssetRecord | null;
  workingAsset?: AutomationTaskAssetRecord | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationListQuery {
  query?: string;
  statuses?: AutomationTaskStatus[];
  frequencies?: AutomationSchedule["frequency"][];
  deliveryModes?: AutomationTaskDeliveryPolicy["mode"][];
  outputModes?: AutomationTaskOutputPolicy["mode"][];
  cursor?: string;
  limit?: number;
}

export interface AutomationTaskSummary extends AutomationTaskRecord {
  latestRun?: Pick<AutomationTaskRunRecord, "runId" | "status" | "origin" | "finishedAt" | "resultSummary" | "errorMessage" | "attempt">;
}

export interface AutomationTaskRunRecord extends AutomationScope {
  runId: string;
  taskId: string;
  revisionId: string;
  origin: AutomationTaskRunOrigin;
  idempotencyKey: string;
  /** Monotonic attempt number for recovery of an expired lease. */
  attempt: number;
  /** Revision number captured by this run; unlike the task's current revision, this never changes later. */
  revision: number;
  /** Opaque ownership token used to fence an old ACP process after recovery. */
  leaseToken?: string | null;
  leaseExpiresAt?: string | null;
  scheduledFor?: string | null;
  executionDeadlineAt?: string | null;
  status: AutomationTaskRunStatus;
  claimedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  inputAssetId?: string | null;
  inputVersions?: Array<{ assetId: string; versionId: string; fileName?: string }>;
  outputAssetId?: string | null;
  outputVersionId?: string | null;
  outputChecksum?: string | null;
  deliveryStatus?: "not_requested" | "pending" | "sent" | "suppressed" | "failed" | null;
  pushJobId?: string | null;
  resultSummary?: string | null;
  errorMessage?: string | null;
  errorCategory?: AutomationErrorCategory | null;
  retryable?: boolean | null;
  traceId?: string | null;
  conversationId?: string | null;
  /** Task name captured from the run's revision for global run history. */
  taskName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationTaskAuditRecord extends AutomationScope {
  auditId: string;
  taskId: string;
  revisionId?: string | null;
  runId?: string | null;
  assetId?: string | null;
  action: string;
  status: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface CreateAutomationTaskInput extends AutomationScope {
  taskId?: string;
  name: string;
  description?: string | null;
  /** Optional registered task type (see services/scheduled-task-types.ts). */
  taskType?: string;
  schedule: AutomationSchedule | Record<string, unknown>;
  instruction?: string;
  inputs?: AutomationTaskAssetBinding[];
  output?: AutomationTaskOutputPolicy | Record<string, unknown>;
  delivery?: AutomationTaskDeliveryPolicy | Record<string, unknown>;
  /** The first revision must have one uploaded source file. */
  sourceAsset?: AutomationTaskAssetInput;
  /** Alias kept for callers that model the upload simply as `asset`. */
  asset?: AutomationTaskAssetInput;
}

export interface UpdateAutomationTaskInput extends AutomationScope {
  taskId: string;
  expectedRevision?: number;
  name?: string;
  description?: string | null;
  schedule?: AutomationSchedule | Record<string, unknown>;
  instruction?: string;
  inputs?: AutomationTaskAssetBinding[];
  output?: AutomationTaskOutputPolicy | Record<string, unknown>;
  delivery?: AutomationTaskDeliveryPolicy | Record<string, unknown>;
  /** A new source is stored as a new immutable source file; it never replaces an old one. */
  sourceAsset?: AutomationTaskAssetInput;
  asset?: AutomationTaskAssetInput;
}

export interface AutomationTaskLookup extends AutomationScope {
  taskId: string;
}

export interface AutomationTaskRunListInput extends AutomationScope {
  taskId?: string;
  query?: string;
  statuses?: AutomationTaskRunStatus[];
  origins?: AutomationTaskRunOrigin[];
  deliveryStatuses?: string[];
  hasOutput?: boolean;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface AutomationRunSummary extends AutomationTaskRunRecord {
  taskName: string;
}

export interface AutomationBatchActionItem {
  taskId: string;
  expectedRevision: number;
}

export interface AutomationBatchActionInput extends AutomationScope {
  action: "pause" | "activate" | "archive";
  items: AutomationBatchActionItem[];
  idempotencyKey: string;
}

export type AutomationBatchActionResultItem =
  | { taskId: string; ok: true; task: AutomationTaskRecord }
  | { taskId: string; ok: false; error: { code: string; message: string; retryable: boolean } };

export interface AutomationBatchActionResult {
  results: AutomationBatchActionResultItem[];
  correlationId: string;
}

export interface AutomationTaskRunLookup extends AutomationScope {
  runId: string;
}

export interface ClaimAutomationTaskRunInput extends AutomationScope {
  taskId: string;
  revisionId?: string;
  origin?: AutomationTaskRunOrigin;
  idempotencyKey: string;
  executionDeadlineAt?: string | null;
  scheduledFor?: string | null;
  conversationId?: string | null;
}

export interface ClaimAutomationTaskRunResult {
  claimed: boolean;
  run: AutomationTaskRunRecord;
}

export interface FinishAutomationTaskRunInput extends AutomationScope {
  runId: string;
  /** Optional fence token. Existing callers may omit it; the active DB lease is still required. */
  leaseToken?: string | null;
  status: Exclude<AutomationTaskRunStatus, "running">;
  resultSummary?: string | null;
  errorMessage?: string | null;
  errorCategory?: AutomationErrorCategory | null;
  retryable?: boolean | null;
  outputAssetId?: string | null;
  outputVersionId?: string | null;
  outputChecksum?: string | null;
  traceId?: string | null;
}

export interface AutomationTaskRunLeaseInput extends AutomationScope {
  runId: string;
  leaseToken?: string | null;
}

export interface AutomationTaskRunBindingInput extends AutomationTaskRunLeaseInput {
  inputs: Array<{ assetId: string; versionId: string; fileName?: string }>;
  outputAssetId?: string | null;
  outputVersionId?: string | null;
}

export interface AutomationTaskRunDeliveryInput extends AutomationTaskRunLookup {
  status: NonNullable<AutomationTaskRunRecord["deliveryStatus"]>;
  pushJobId?: string | null;
}

export interface CreateAutomationTaskAssetInput extends AutomationScope {
  taskId: string;
  revisionId?: string | null;
  assetRole: AutomationTaskAssetRole;
  asset: AutomationTaskAssetInput;
  /** Only working files may be replaced, and only with this explicit flag. */
  overwrite?: boolean;
}

export interface AutomationTaskAssetLookup extends AutomationScope {
  assetId: string;
}

export interface AutomationTaskAssetPayload {
  descriptor: AutomationTaskAssetRecord;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  bytes: Buffer;
  base64: string;
}

export class AutomationTaskError extends Error {
  constructor(
    public readonly code:
      | "AUTOMATION_INVALID_SCOPE"
      | "AUTOMATION_SCOPE_MISMATCH"
      | "AUTOMATION_TASK_NOT_FOUND"
      | "AUTOMATION_TASK_EXISTS"
      | "AUTOMATION_REVISION_NOT_FOUND"
      | "AUTOMATION_REVISION_CONFLICT"
      | "AUTOMATION_INVALID_TASK_ID"
      | "AUTOMATION_INVALID_NAME"
      | "AUTOMATION_INVALID_DESCRIPTION"
      | "AUTOMATION_INVALID_SCHEDULE"
      | "AUTOMATION_INVALID_TASK_TYPE"
      | "AUTOMATION_INVALID_DEADLINE"
      | "AUTOMATION_INVALID_OUTPUT_POLICY"
      | "AUTOMATION_ASSET_BINDING_INVALID"
      | "AUTOMATION_ASSET_REQUIRED"
      | "AUTOMATION_ASSET_INVALID_PATH"
      | "AUTOMATION_ASSET_UNSUPPORTED_TYPE"
      | "AUTOMATION_ASSET_TOO_LARGE"
      | "AUTOMATION_ASSET_MIME_MISMATCH"
      | "AUTOMATION_ASSET_INVALID_CONTENT"
      | "AUTOMATION_ASSET_EXISTS"
      | "AUTOMATION_ASSET_SOURCE_IMMUTABLE"
      | "AUTOMATION_ASSET_NOT_FOUND"
      | "AUTOMATION_ASSET_UNSAFE"
      | "AUTOMATION_ASSET_CHECKSUM_MISMATCH"
      | "AUTOMATION_WORKSPACE_NOT_FOUND"
      | "AUTOMATION_RUN_NOT_FOUND"
      | "AUTOMATION_RUN_IDEMPOTENCY_CONFLICT"
      | "AUTOMATION_RUN_ALREADY_FINISHED"
      | "AUTOMATION_RUN_STATUS_INVALID"
      | "AUTOMATION_RUN_LEASE_LOST"
      | "AUTOMATION_RUN_EXECUTION_DEADLINE_EXCEEDED"
      | "AUTOMATION_RUN_INVALID_RESULT"
      | "ASSET_SUBMISSION_FAILED"
      | "AUTOMATION_TASK_BUSY"
      | "AUTOMATION_TASK_NOT_ACTIVE"
      | "AUTOMATION_TASK_NEEDS_ATTENTION"
      | "AUTOMATION_TASK_ARCHIVED"
      | "AUTOMATION_BATCH_INVALID"
      | "AUTOMATION_INVALID_CURSOR"
      | "AUTOMATION_DATA_CORRUPT",
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}:${message}`);
    this.name = "AutomationTaskError";
  }
}

type NormalizedAssetInput = {
  fileName: string;
  mimeType: string;
  extension: ".csv" | ".xlsx";
  bytes: Buffer;
  checksum: string;
};

type DbTaskRow = {
  taskId: string;
  userId: string;
  projectId: string;
  instanceId: string;
  taskType: string | null;
  status: string;
  currentRevision: number;
  currentRevisionId: string | null;
  nextRunAt: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
};

type DbRevisionRow = {
  revisionId: string;
  taskId: string;
  userId: string;
  projectId: string;
  instanceId: string;
  revision: number;
  name: string;
  description: string | null;
  instruction: string | null;
  scheduleJson: string;
  inputsJson: string | null;
  outputJson: string | null;
  deliveryJson: string | null;
  sourceAssetId: string | null;
  workingAssetId: string | null;
  createdAt: string;
};

type DbBindingRow = {
  bindingId: string;
  taskId: string;
  revisionId: string;
  assetId: string;
  userId: string;
  projectId: string;
  instanceId: string;
  role: string;
  versionPolicy: string;
  versionId: string | null;
  createdAt: string;
};

type DbAssetRow = {
  assetId: string;
  taskId: string;
  revisionId: string | null;
  userId: string;
  projectId: string;
  instanceId: string;
  assetRole: string;
  fileName: string;
  relativePath: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
  updatedAt: string;
};

type DbRunRow = {
  runId: string;
  taskId: string;
  revisionId: string;
  userId: string;
  projectId: string;
  instanceId: string;
  origin: string;
  physicalIdempotencyKey: string;
  idempotencyBaseKey: string | null;
  idempotencyKey: string;
  attempt: number;
  revisionNumber: number;
  scheduledFor: string | null;
  executionDeadlineAt: string | null;
  status: string;
  claimedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  inputAssetId: string | null;
  inputVersionsJson: string | null;
  outputAssetId: string | null;
  outputVersionId: string | null;
  outputChecksum: string | null;
  deliveryStatus: string | null;
  pushJobId: string | null;
  resultSummary: string | null;
  errorMessage: string | null;
  errorCategory: string | null;
  retryable: number | null;
  traceId: string | null;
  conversationId: string | null;
  taskName?: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type DbTaskLockRow = {
  activeRunId: string | null;
  activeRunLeaseToken: string | null;
  activeRunLeaseExpiresAt: string | null;
};

const TASK_SELECT = `
  task_id AS taskId,
  user_id AS userId,
  project_id AS projectId,
  instance_id AS instanceId,
  task_type AS taskType,
  status,
  current_revision AS currentRevision,
  current_revision_id AS currentRevisionId,
  next_run_at AS nextRunAt,
  consecutive_failures AS consecutiveFailures,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const REVISION_SELECT = `
  revision_id AS revisionId,
  task_id AS taskId,
  user_id AS userId,
  project_id AS projectId,
  instance_id AS instanceId,
  revision,
  name,
  description,
  instruction,
  schedule_json AS scheduleJson,
  inputs_json AS inputsJson,
  output_json AS outputJson,
  delivery_json AS deliveryJson,
  source_asset_id AS sourceAssetId,
  working_asset_id AS workingAssetId,
  created_at AS createdAt
`;

const ASSET_SELECT = `
  asset_id AS assetId,
  task_id AS taskId,
  revision_id AS revisionId,
  user_id AS userId,
  project_id AS projectId,
  instance_id AS instanceId,
  asset_role AS assetRole,
  file_name AS fileName,
  relative_path AS relativePath,
  mime_type AS mimeType,
  extension,
  size_bytes AS sizeBytes,
  checksum,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const RUN_SELECT = `
  automation_task_runs.run_id AS runId,
  automation_task_runs.task_id AS taskId,
  automation_task_runs.revision_id AS revisionId,
  automation_task_runs.user_id AS userId,
  automation_task_runs.project_id AS projectId,
  automation_task_runs.instance_id AS instanceId,
  automation_task_runs.origin,
  automation_task_runs.idempotency_key AS physicalIdempotencyKey,
  automation_task_runs.idempotency_base_key AS idempotencyBaseKey,
  COALESCE(automation_task_runs.idempotency_base_key, automation_task_runs.idempotency_key) AS idempotencyKey,
  automation_task_runs.attempt,
  (SELECT revision FROM automation_task_revisions revision_row WHERE revision_row.revision_id = automation_task_runs.revision_id LIMIT 1) AS revisionNumber,
  automation_task_runs.scheduled_for AS scheduledFor,
  automation_task_runs.execution_deadline_at AS executionDeadlineAt,
  automation_task_runs.status,
  automation_task_runs.claimed_at AS claimedAt,
  automation_task_runs.started_at AS startedAt,
  automation_task_runs.finished_at AS finishedAt,
  automation_task_runs.input_asset_id AS inputAssetId,
  automation_task_runs.input_versions_json AS inputVersionsJson,
  automation_task_runs.output_asset_id AS outputAssetId,
  automation_task_runs.output_version_id AS outputVersionId,
  automation_task_runs.output_checksum AS outputChecksum,
  automation_task_runs.delivery_status AS deliveryStatus,
  automation_task_runs.push_job_id AS pushJobId,
  automation_task_runs.result_summary AS resultSummary,
  automation_task_runs.error_message AS errorMessage,
  automation_task_runs.error_category AS errorCategory,
  automation_task_runs.retryable AS retryable,
  automation_task_runs.trace_id AS traceId,
  automation_task_runs.conversation_id AS conversationId,
  (SELECT name FROM automation_task_revisions revision_row WHERE revision_row.revision_id = automation_task_runs.revision_id LIMIT 1) AS taskName,
  automation_task_runs.lease_token AS leaseToken,
  automation_task_runs.lease_expires_at AS leaseExpiresAt,
  automation_task_runs.created_at AS createdAt,
  automation_task_runs.updated_at AS updatedAt
`;

export function normalizeAutomationScope(input: AutomationScope): AutomationScope {
  const userId = normalizeScopePart(input?.userId, "userId");
  const instanceId = normalizeScopePart(input?.instanceId, "instanceId");
  const projectId = normalizeScopePart(input?.projectId, "projectId");
  return { userId, instanceId, projectId };
}

/**
 * Validates the caller scope and, when an instance registry row exists, makes
 * sure the requested instance cannot be borrowed by another user/project.
 * Task rows still repeat all three scope columns so every resource query can
 * enforce the same boundary without relying on a caller-provided task ID.
 */
export function assertAutomationScope(input: AutomationScope): AutomationScope {
  const scope = normalizeAutomationScope(input);
  const instance = sqlite.prepare(
    `SELECT owner_user_id AS ownerUserId, project_id AS projectId FROM ai_instances WHERE id = ?`,
  ).get(scope.instanceId) as { ownerUserId: string; projectId: string } | undefined;
  if (instance && (instance.ownerUserId !== scope.userId || instance.projectId !== scope.projectId)) {
    throw new AutomationTaskError("AUTOMATION_SCOPE_MISMATCH", scope.instanceId);
  }
  return scope;
}

export async function createAutomationTask(input: CreateAutomationTaskInput): Promise<AutomationTaskRecord> {
  const scope = assertAutomationScope(input);
  if (ACTIVE_BACKEND === "mastra") {
    await mastraWorkspaceRegistry.bootstrap(scope);
  } else {
    await ensureWorkspace({ userId: scope.userId, tenantId: scope.userId, projectId: scope.projectId });
  }
  const name = normalizeTaskName(input.name);
  const description = normalizeDescription(input.description);
  const schedule = normalizeAutomationSchedule(input.schedule);
  if (input.taskType !== undefined && !isRegisteredScheduledTaskType(input.taskType)) {
    throw new AutomationTaskError("AUTOMATION_INVALID_TASK_TYPE", input.taskType);
  }
  const sourceInput = input.sourceAsset ?? input.asset;
  if (isGenericTaskInput(input, sourceInput)) {
    if (sourceInput) throw new AutomationTaskError("AUTOMATION_INVALID_OUTPUT_POLICY", "generic task cannot mix legacy sourceAsset");
    return createGenericAutomationTask({ scope, input, name, description, schedule });
  }
  if (!sourceInput) throw new AutomationTaskError("AUTOMATION_ASSET_REQUIRED", "sourceAsset");

  const taskId = input.taskId ? normalizeTaskId(input.taskId) : `at_${randomUUID()}`;
  const existing = readTaskRow(taskId);
  if (existing) throw new AutomationTaskError("AUTOMATION_TASK_EXISTS", taskId);

  const revisionId = `atr_${randomUUID()}`;
  const sourceAssetId = `ata_${randomUUID()}`;
  const workingAssetId = `ata_${randomUUID()}`;
  const normalizedAsset = normalizeAssetInput(sourceInput);
  await assertStructuredAsset(normalizedAsset);
  const createdPaths: string[] = [];
  try {
    const sourceWritten = await writeNewAssetFile({ scope, taskId, assetRole: "source", asset: normalizedAsset, createdPaths });
    const workingWritten = await writeNewAssetFile({ scope, taskId, assetRole: "working", asset: normalizedAsset, createdPaths });
    const now = nowIso();
    const transaction = sqlite.transaction(() => {
      sqlite.prepare(`
        INSERT INTO automation_tasks (
          task_id, user_id, project_id, instance_id, task_type, status,
          current_revision, current_revision_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'paused', 1, ?, ?, ?)
      `).run(taskId, scope.userId, scope.projectId, scope.instanceId, input.taskType ?? null, revisionId, now, now);
      insertAssetRow({
        assetId: sourceAssetId,
        taskId,
        revisionId,
        scope,
        assetRole: "source",
        fileName: normalizedAsset.fileName,
        relativePath: sourceWritten.relativePath,
        mimeType: normalizedAsset.mimeType,
        extension: normalizedAsset.extension,
        sizeBytes: normalizedAsset.bytes.length,
        checksum: normalizedAsset.checksum,
        createdAt: now,
        updatedAt: now,
      });
      insertAssetRow({
        assetId: workingAssetId,
        taskId,
        revisionId,
        scope,
        assetRole: "working",
        fileName: normalizedAsset.fileName,
        relativePath: workingWritten.relativePath,
        mimeType: normalizedAsset.mimeType,
        extension: normalizedAsset.extension,
        sizeBytes: normalizedAsset.bytes.length,
        checksum: normalizedAsset.checksum,
        createdAt: now,
        updatedAt: now,
      });
      sqlite.prepare(`
        INSERT INTO automation_task_revisions (
          revision_id, task_id, user_id, project_id, instance_id, revision,
          name, description, schedule_json, source_asset_id, working_asset_id, created_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      `).run(
        revisionId,
        taskId,
        scope.userId,
        scope.projectId,
        scope.instanceId,
        name,
        description,
        JSON.stringify(schedule),
        sourceAssetId,
        workingAssetId,
        now,
      );
      insertAuditRow({
        taskId,
        revisionId,
        scope,
        action: "task.created",
        status: "success",
        details: { revision: 1, status: "paused" },
        createdAt: now,
      });
      insertAuditRow({
        taskId,
        revisionId,
        assetId: sourceAssetId,
        scope,
        action: "asset.created",
        status: "success",
        details: { assetRole: "source", relativePath: sourceWritten.relativePath, sizeBytes: normalizedAsset.bytes.length },
        createdAt: now,
      });
      insertAuditRow({
        taskId,
        revisionId,
        assetId: workingAssetId,
        scope,
        action: "asset.created",
        status: "success",
        details: { assetRole: "working", relativePath: workingWritten.relativePath, sizeBytes: normalizedAsset.bytes.length },
        createdAt: now,
      });
    });
    transaction();
  } catch (error) {
    await cleanupCreatedFiles(createdPaths);
    throw error;
  }

  return requireAutomationTask({ ...scope, taskId });
}

export async function updateAutomationTask(input: UpdateAutomationTaskInput): Promise<AutomationTaskRecord> {
  const scope = assertAutomationScope(input);
  const taskId = normalizeTaskId(input.taskId);
  const task = requireTaskRow(taskId, scope);
  if (task.status === "archived") throw new AutomationTaskError("AUTOMATION_TASK_ARCHIVED", taskId);
  if (input.expectedRevision !== undefined && input.expectedRevision !== task.currentRevision) {
    throw new AutomationTaskError("AUTOMATION_REVISION_CONFLICT", String(input.expectedRevision));
  }
  const currentRevision = revisionRecordFromRow(requireRevisionForTask(task, scope));
  const hasGenericFields = input.instruction !== undefined || input.inputs !== undefined || input.output !== undefined || input.delivery !== undefined;
  if (hasGenericFields || currentRevision.inputs.length > 0 || currentRevision.output.mode !== "none" || (currentRevision.instruction.length > 0 && !currentRevision.sourceAssetId)) {
    return updateGenericAutomationTask({ scope, input, task, currentRevision });
  }
  const revision = task.currentRevision + 1;
  const revisionId = `atr_${randomUUID()}`;
  const name = normalizeTaskName(input.name ?? currentRevision.name);
  const description = input.description === undefined
    ? currentRevision.description ?? null
    : normalizeDescription(input.description);
  const schedule = normalizeAutomationSchedule(input.schedule ?? currentRevision.schedule);
  const sourceInput = input.sourceAsset ?? input.asset;
  const createdPaths: string[] = [];
  let newSource: { assetId: string; written: WrittenAsset; normalized: NormalizedAssetInput } | null = null;
  let newWorking: { assetId: string; written: WrittenAsset; normalized: NormalizedAssetInput } | null = null;

  try {
    if (sourceInput) {
      const normalized = normalizeAssetInput(sourceInput);
      await assertStructuredAsset(normalized);
      const fileName = await versionedAssetFileName(scope, taskId, normalized.fileName, revision);
      const versioned = { ...normalized, fileName };
      newSource = {
        assetId: `ata_${randomUUID()}`,
        written: await writeNewAssetFile({ scope, taskId, assetRole: "source", asset: versioned, createdPaths }),
        normalized: versioned,
      };
      newWorking = {
        assetId: `ata_${randomUUID()}`,
        written: await writeNewAssetFile({ scope, taskId, assetRole: "working", asset: versioned, createdPaths }),
        normalized: versioned,
      };
    }

    const sourceAssetId = newSource?.assetId ?? currentRevision.sourceAssetId;
    const workingAssetId = newWorking?.assetId ?? currentRevision.workingAssetId;
    const now = nowIso();
    const transaction = sqlite.transaction(() => {
      if (newSource && newWorking) {
        insertAssetRow({
          assetId: newSource.assetId,
          taskId,
          revisionId,
          scope,
          assetRole: "source",
          fileName: newSource.normalized.fileName,
          relativePath: newSource.written.relativePath,
          mimeType: newSource.normalized.mimeType,
          extension: newSource.normalized.extension,
          sizeBytes: newSource.normalized.bytes.length,
          checksum: newSource.normalized.checksum,
          createdAt: now,
          updatedAt: now,
        });
        insertAssetRow({
          assetId: newWorking.assetId,
          taskId,
          revisionId,
          scope,
          assetRole: "working",
          fileName: newWorking.normalized.fileName,
          relativePath: newWorking.written.relativePath,
          mimeType: newWorking.normalized.mimeType,
          extension: newWorking.normalized.extension,
          sizeBytes: newWorking.normalized.bytes.length,
          checksum: newWorking.normalized.checksum,
          createdAt: now,
          updatedAt: now,
        });
      }
      sqlite.prepare(`
        INSERT INTO automation_task_revisions (
          revision_id, task_id, user_id, project_id, instance_id, revision,
          name, description, schedule_json, source_asset_id, working_asset_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revisionId,
        taskId,
        scope.userId,
        scope.projectId,
        scope.instanceId,
        revision,
        name,
        description,
        JSON.stringify(schedule),
        sourceAssetId ?? null,
        workingAssetId ?? null,
        now,
      );
      sqlite.prepare(`
        UPDATE automation_tasks
        SET status = 'paused', current_revision = ?, current_revision_id = ?, next_run_at = NULL, consecutive_failures = 0, updated_at = ?
        WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
      `).run(revision, revisionId, now, taskId, scope.userId, scope.projectId, scope.instanceId);
      insertAuditRow({
        taskId,
        revisionId,
        scope,
        action: "task.revision_created",
        status: "success",
        details: { revision, status: "paused", sourceChanged: Boolean(sourceInput) },
        createdAt: now,
      });
    });
    transaction();
  } catch (error) {
    await cleanupCreatedFiles(createdPaths);
    throw error;
  }

  return requireAutomationTask({ ...scope, taskId });
}

function isGenericTaskInput(input: { instruction?: string; inputs?: AutomationTaskAssetBinding[]; output?: unknown; delivery?: unknown }, sourceInput: unknown): boolean {
  return !sourceInput || input.instruction !== undefined || input.inputs !== undefined || input.output !== undefined || input.delivery !== undefined;
}

async function createGenericAutomationTask(input: {
  scope: AutomationScope;
  input: CreateAutomationTaskInput;
  name: string;
  description: string | null;
  schedule: AutomationSchedule;
}): Promise<AutomationTaskRecord> {
  const definition = await normalizeGenericDefinition(input.scope, input.input);
  const taskId = input.input.taskId ? normalizeTaskId(input.input.taskId) : `at_${randomUUID()}`;
  if (readTaskRow(taskId)) throw new AutomationTaskError("AUTOMATION_TASK_EXISTS", taskId);
  const revisionId = `atr_${randomUUID()}`;
  const now = nowIso();
  const transaction = sqlite.transaction(() => {
    sqlite.prepare(`
      INSERT INTO automation_tasks (
        task_id, user_id, project_id, instance_id, task_type, status,
        current_revision, current_revision_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'paused', 1, ?, ?, ?)
    `).run(taskId, input.scope.userId, input.scope.projectId, input.scope.instanceId, input.input.taskType ?? null, revisionId, now, now);
    insertGenericRevision({
      revisionId, taskId, scope: input.scope, revision: 1, name: input.name,
      description: input.description, schedule: input.schedule, definition, createdAt: now,
    });
    insertGenericBindings({ taskId, revisionId, scope: input.scope, bindings: genericBindings(definition), createdAt: now });
    insertAuditRow({ taskId, revisionId, scope: input.scope, action: "task.created", status: "success", details: { revision: 1, status: "paused", kind: "generic" }, createdAt: now });
  });
  transaction();
  return requireAutomationTask({ ...input.scope, taskId });
}

async function updateGenericAutomationTask(input: {
  scope: AutomationScope;
  input: UpdateAutomationTaskInput;
  task: DbTaskRow;
  currentRevision: AutomationTaskRevisionRecord;
}): Promise<AutomationTaskRecord> {
  if (input.input.sourceAsset || input.input.asset) {
    throw new AutomationTaskError("AUTOMATION_INVALID_OUTPUT_POLICY", "generic tasks cannot use legacy sourceAsset");
  }
  const definition = await normalizeGenericDefinition(input.scope, {
    ...input.input,
    instruction: input.input.instruction ?? input.currentRevision.instruction,
    inputs: input.input.inputs ?? input.currentRevision.inputs,
    output: input.input.output ?? input.currentRevision.output,
    delivery: input.input.delivery ?? input.currentRevision.delivery,
  });
  const revision = input.task.currentRevision + 1;
  const revisionId = `atr_${randomUUID()}`;
  const name = normalizeTaskName(input.input.name ?? input.currentRevision.name);
  const description = input.input.description === undefined
    ? input.currentRevision.description ?? null
    : normalizeDescription(input.input.description);
  const schedule = normalizeAutomationSchedule(input.input.schedule ?? input.currentRevision.schedule);
  const now = nowIso();
  const transaction = sqlite.transaction(() => {
    sqlite.prepare(`
      INSERT INTO automation_task_revisions (
        revision_id, task_id, user_id, project_id, instance_id, revision,
        name, description, instruction, schedule_json, inputs_json, output_json, delivery_json,
        source_asset_id, working_asset_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    `).run(
      revisionId, input.task.taskId, input.scope.userId, input.scope.projectId, input.scope.instanceId,
      revision, name, description, definition.instruction, JSON.stringify(schedule),
      JSON.stringify(definition.inputs), JSON.stringify(definition.output), JSON.stringify(definition.delivery), now,
    );
    insertGenericBindings({ taskId: input.task.taskId, revisionId, scope: input.scope, bindings: genericBindings(definition), createdAt: now });
    sqlite.prepare(`
      UPDATE automation_tasks
      SET status = 'paused', current_revision = ?, current_revision_id = ?, next_run_at = NULL,
          consecutive_failures = 0, updated_at = ?
      WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
    `).run(revision, revisionId, now, input.task.taskId, input.scope.userId, input.scope.projectId, input.scope.instanceId);
    insertAuditRow({ taskId: input.task.taskId, revisionId, scope: input.scope, action: "task.revision_created", status: "success", details: { revision, status: "paused", kind: "generic" }, createdAt: now });
  });
  transaction();
  return requireAutomationTask({ ...input.scope, taskId: input.task.taskId });
}

type NormalizedGenericDefinition = {
  instruction: string;
  inputs: AutomationTaskAssetBinding[];
  output: AutomationTaskOutputPolicy;
  delivery: AutomationTaskDeliveryPolicy;
};

async function normalizeGenericDefinition(scope: AutomationScope, input: {
  instruction?: string;
  inputs?: AutomationTaskAssetBinding[];
  output?: AutomationTaskOutputPolicy | Record<string, unknown>;
  delivery?: AutomationTaskDeliveryPolicy | Record<string, unknown>;
}): Promise<NormalizedGenericDefinition> {
  const instruction = String(input.instruction ?? "").trim();
  if (!instruction || instruction.length > MAX_DESCRIPTION_LENGTH) throw new AutomationTaskError("AUTOMATION_INVALID_OUTPUT_POLICY", "instruction must be 1..12000 characters");
  const rawInputs = input.inputs ?? [];
  if (!Array.isArray(rawInputs) || rawInputs.length > 8) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", "inputs must contain 0..8 bindings");
  const inputs: AutomationTaskAssetBinding[] = [];
  for (const raw of rawInputs) {
    if (!raw || typeof raw !== "object") throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", "invalid input binding");
    const binding = normalizeAssetBinding(raw as unknown as Record<string, unknown>);
    const asset = await getUserAsset({ ...scope, assetId: binding.assetId });
    if (!asset) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", binding.assetId);
    if (asset.status !== "active" || !asset.currentVersion) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", "asset must be active");
    if (binding.versionPolicy === "fixed") {
      try {
        await readUserAssetVersion({ ...scope, assetId: binding.assetId, versionId: binding.versionId! });
      } catch (error) {
        if (error instanceof UserAssetError) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", binding.assetId);
        throw error;
      }
    }
    inputs.push(binding);
  }
  const output = normalizeOutputPolicy(input.output);
  for (const binding of inputs) {
    if (binding.role !== "update_target") continue;
    if (output.mode === "update" && binding.assetId === output.assetId && binding.versionPolicy === "latest") continue;
    if (output.mode === "agent" && binding.versionPolicy === "latest") continue;
    throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", "update_target must be writable by the task output mode");
  }
  await validateOutputPolicy(scope, output);
  const delivery = normalizeDeliveryPolicy(input.delivery);
  return { instruction, inputs, output, delivery };
}

function normalizeAssetBinding(raw: Record<string, unknown>): AutomationTaskAssetBinding {
  const assetId = normalizeOpaqueId(String(raw.assetId ?? ""), "assetId");
  const role = raw.role === "update_target" ? "update_target" : raw.role === "input" ? "input" : null;
  const versionPolicy = raw.versionPolicy === "fixed" ? "fixed" : raw.versionPolicy === "latest" ? "latest" : null;
  if (!role || !versionPolicy) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", "role/versionPolicy");
  const versionId = raw.versionId === undefined ? undefined : normalizeOpaqueId(String(raw.versionId), "versionId");
  if (versionPolicy === "latest" && versionId) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", "latest cannot carry versionId");
  if (versionPolicy === "fixed" && !versionId) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", "fixed requires versionId");
  return { assetId, role, versionPolicy, ...(versionId ? { versionId } : {}) };
}

function normalizeOutputPolicy(raw: AutomationTaskOutputPolicy | Record<string, unknown> | undefined): AutomationTaskOutputPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { mode: "agent" };
  const value = raw as Record<string, unknown>;
  const mode = value.mode;
  if (mode === "none") return { mode: "none" };
  if (mode === "agent") return { mode: "agent" };
  if (mode === "create") {
    const format = String(value.format || "") as AssetFormat;
    const fileName = normalizeAssetFileNameForOutput(String(value.fileName || ""));
    if (!isAssetFormat(format) || assetFormatForFileName(fileName) !== format) throw new AutomationTaskError("AUTOMATION_INVALID_OUTPUT_POLICY", "create format/fileName mismatch");
    if (format === "csv") throw new AutomationTaskError("AUTOMATION_INVALID_OUTPUT_POLICY", "new spreadsheet outputs must use xlsx");
    const titleTemplate = value.titleTemplate === undefined ? undefined : String(value.titleTemplate);
    if (titleTemplate && titleTemplate.length > 500) throw new AutomationTaskError("AUTOMATION_INVALID_OUTPUT_POLICY", "titleTemplate too long");
    return { mode: "create", format, fileName, ...(titleTemplate ? { titleTemplate } : {}) };
  }
  if (mode === "update") {
    const assetId = normalizeOpaqueId(String(value.assetId || ""), "assetId");
    if (value.versionPolicy !== "latest") throw new AutomationTaskError("AUTOMATION_INVALID_OUTPUT_POLICY", "update requires latest versionPolicy");
    const expectedVersionId = value.expectedVersionId === undefined ? undefined : normalizeOpaqueId(String(value.expectedVersionId), "expectedVersionId");
    return { mode: "update", assetId, versionPolicy: "latest", ...(expectedVersionId ? { expectedVersionId } : {}) };
  }
  throw new AutomationTaskError("AUTOMATION_INVALID_OUTPUT_POLICY", "unsupported output mode");
}

function normalizeDeliveryPolicy(raw: AutomationTaskDeliveryPolicy | Record<string, unknown> | undefined): AutomationTaskDeliveryPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { mode: "none" };
  const value = raw as Record<string, unknown>;
  if (value.mode === "none" || value.mode === "wechat_summary") return { mode: value.mode };
  if (value.mode === "wechat_on_condition" && value.conditionVersion === 1) return { mode: "wechat_on_condition", conditionVersion: 1 };
  throw new AutomationTaskError("AUTOMATION_INVALID_OUTPUT_POLICY", "unsupported delivery policy");
}

async function validateOutputPolicy(scope: AutomationScope, output: AutomationTaskOutputPolicy): Promise<void> {
  if (output.mode !== "update") return;
  const asset = await getUserAsset({ ...scope, assetId: output.assetId });
  if (!asset || asset.status !== "active" || !asset.currentVersion) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", output.assetId);
  if (!(asset.currentVersion.format === "markdown" || asset.currentVersion.format === "xlsx")) {
    throw new AutomationTaskError("AUTOMATION_INVALID_OUTPUT_POLICY", "update supports markdown/xlsx only");
  }
}

function genericBindings(definition: NormalizedGenericDefinition): Array<AutomationTaskAssetBinding & { role: "input" | "update_target" }> {
  const bindings = [...definition.inputs];
  const output = definition.output;
  if (output.mode === "update" && !bindings.some((binding) => binding.role === "update_target" && binding.assetId === output.assetId)) {
    bindings.push({ assetId: output.assetId, role: "update_target", versionPolicy: "latest" });
  }
  return bindings;
}

function insertGenericRevision(input: {
  revisionId: string; taskId: string; scope: AutomationScope; revision: number; name: string; description: string | null;
  schedule: AutomationSchedule; definition: NormalizedGenericDefinition; createdAt: string;
}): void {
  sqlite.prepare(`
    INSERT INTO automation_task_revisions (
      revision_id, task_id, user_id, project_id, instance_id, revision,
      name, description, instruction, schedule_json, inputs_json, output_json, delivery_json,
      source_asset_id, working_asset_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  `).run(
    input.revisionId, input.taskId, input.scope.userId, input.scope.projectId, input.scope.instanceId,
    input.revision, input.name, input.description, input.definition.instruction, JSON.stringify(input.schedule),
    JSON.stringify(input.definition.inputs), JSON.stringify(input.definition.output), JSON.stringify(input.definition.delivery), input.createdAt,
  );
}

function insertGenericBindings(input: { taskId: string; revisionId: string; scope: AutomationScope; bindings: AutomationTaskAssetBinding[]; createdAt: string }): void {
  const insert = sqlite.prepare(`
    INSERT INTO automation_task_asset_bindings (
      binding_id, task_id, revision_id, asset_id, user_id, project_id, instance_id, role, version_policy, version_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const binding of input.bindings) {
    insert.run(`atbind_${randomUUID()}`, input.taskId, input.revisionId, binding.assetId, input.scope.userId, input.scope.projectId, input.scope.instanceId, binding.role, binding.versionPolicy, binding.versionId ?? null, input.createdAt);
  }
}

export async function activateAutomationTask(input: AutomationTaskLookup & { expectedRevision?: number }): Promise<AutomationTaskRecord> {
  return setAutomationTaskStatus(input, "active");
}

export async function pauseAutomationTask(input: AutomationTaskLookup & { expectedRevision?: number }): Promise<AutomationTaskRecord> {
  return setAutomationTaskStatus(input, "paused");
}

export async function archiveAutomationTask(input: AutomationTaskLookup & { expectedRevision?: number }): Promise<AutomationTaskRecord> {
  return setAutomationTaskStatus(input, "archived");
}

/** Readable aliases for Portal adapters that use enable/disable wording. */
export const enableAutomationTask = activateAutomationTask;
export const disableAutomationTask = pauseAutomationTask;

export async function listAutomationTasks(input: AutomationScope, query: AutomationListQuery = {}): Promise<AutomationTaskSummary[]> {
  return (await listAutomationTaskPage(input, query)).items;
}

export async function listAutomationTaskPage(input: AutomationScope, query: AutomationListQuery = {}): Promise<{ items: AutomationTaskSummary[]; nextCursor?: string }> {
  const scope = assertAutomationScope(input);
  const rows = sqlite.prepare(`
    SELECT ${TASK_SELECT}
    FROM automation_tasks
    WHERE user_id = ? AND project_id = ? AND instance_id = ?
  `).all(scope.userId, scope.projectId, scope.instanceId) as DbTaskRow[];
  const defaultStatuses: AutomationTaskStatus[] = ["needs_attention", "active", "paused"];
  const statuses = query.statuses?.length ? query.statuses : defaultStatuses;
  const search = query.query?.trim().toLocaleLowerCase();
  const frequencySet = query.frequencies?.length ? new Set(query.frequencies) : null;
  const deliverySet = query.deliveryModes?.length ? new Set(query.deliveryModes) : null;
  const outputSet = query.outputModes?.length ? new Set(query.outputModes) : null;
  const latestRuns = latestRunsByTask(scope);
  const all = rows
    .map((row) => taskRecordFromRow(row, scope))
    .filter((task) => statuses.includes(task.status))
    .filter((task) => !search || `${task.revision.name}\n${task.revision.description ?? ""}`.toLocaleLowerCase().includes(search))
    .filter((task) => !frequencySet || frequencySet.has(task.revision.schedule.frequency))
    .filter((task) => !deliverySet || deliverySet.has(task.revision.delivery.mode))
    .filter((task) => !outputSet || outputSet.has(task.revision.output.mode))
    .map((task) => {
      const latest = latestRuns.get(task.taskId);
      return latest ? { ...task, latestRun: latest } : task;
    })
    .sort(compareTaskSummaries);
  const start = cursorIndex(all, query.cursor, taskCursorKey);
  const limit = normalizeListLimit(query.limit);
  const items = all.slice(start, start + limit);
  const last = items.at(-1);
  return { items, ...(last && start + limit < all.length ? { nextCursor: encodeListCursor(taskCursorKey(last)) } : {}) };
}

export async function getAutomationTask(input: AutomationTaskLookup): Promise<AutomationTaskRecord | null> {
  const scope = assertAutomationScope(input);
  const taskId = normalizeTaskId(input.taskId);
  const row = readTaskRow(taskId);
  if (!row) return null;
  assertRowScope(row, scope);
  return taskRecordFromRow(row, scope);
}

export async function requireAutomationTask(input: AutomationTaskLookup): Promise<AutomationTaskRecord> {
  const scope = assertAutomationScope(input);
  const taskId = normalizeTaskId(input.taskId);
  const row = requireTaskRow(taskId, scope);
  return taskRecordFromRow(row, scope);
}

export async function listAutomationTaskRevisions(input: AutomationTaskLookup): Promise<AutomationTaskRevisionRecord[]> {
  const scope = assertAutomationScope(input);
  const taskId = normalizeTaskId(input.taskId);
  requireTaskRow(taskId, scope);
  const rows = sqlite.prepare(`
    SELECT ${REVISION_SELECT}
    FROM automation_task_revisions
    WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
    ORDER BY revision DESC
  `).all(taskId, scope.userId, scope.projectId, scope.instanceId) as DbRevisionRow[];
  return rows.map(revisionRecordFromRow);
}

/**
 * Assert that the caller still owns the persisted task execution lease.  The
 * runner uses this immediately before committing a working asset and again
 * before finishing a run; after stale recovery the old run's token no longer
 * matches the task row and this guard deterministically rejects it.
 */
export async function assertAutomationTaskRunLease(input: AutomationTaskRunLeaseInput): Promise<AutomationTaskRunRecord> {
  const scope = assertAutomationScope(input);
  const runId = normalizeOpaqueId(input.runId, "runId");
  const row = requireRunRow(runId, scope);
  const nowMs = Date.parse(nowIso());
  assertAutomationTaskRunLeaseSync(row, scope, input.leaseToken, nowMs);
  if (row.executionDeadlineAt && Date.parse(row.executionDeadlineAt) <= nowMs) {
    throw new AutomationTaskError("AUTOMATION_RUN_EXECUTION_DEADLINE_EXCEEDED", runId);
  }
  return runRecordFromRow(row);
}

export async function bindAutomationTaskRunAssets(input: AutomationTaskRunBindingInput): Promise<AutomationTaskRunRecord> {
  const scope = assertAutomationScope(input);
  const runId = normalizeOpaqueId(input.runId, "runId");
  const inputs = input.inputs.map((item) => ({
    assetId: normalizeOpaqueId(item.assetId, "assetId"),
    versionId: normalizeOpaqueId(item.versionId, "versionId"),
    ...(item.fileName ? { fileName: String(item.fileName).slice(0, 255) } : {}),
  }));
  const now = nowIso();
  const result = sqlite.prepare(`
    UPDATE automation_task_runs
    SET input_asset_id = ?, input_versions_json = ?, output_asset_id = ?, output_version_id = ?, updated_at = ?
    WHERE run_id = ? AND user_id = ? AND project_id = ? AND instance_id = ? AND status = 'running'
      AND lease_token = ? AND lease_expires_at > ?
  `).run(
    inputs[0]?.assetId ?? null, JSON.stringify(inputs), input.outputAssetId ?? null, input.outputVersionId ?? null,
    now, runId, scope.userId, scope.projectId, scope.instanceId, input.leaseToken ?? null, now,
  );
  if (result.changes !== 1) throw new AutomationTaskError("AUTOMATION_RUN_LEASE_LOST", runId);
  return runRecordFromRow(requireRunRow(runId, scope));
}

export async function updateAutomationTaskRunDelivery(input: AutomationTaskRunDeliveryInput): Promise<AutomationTaskRunRecord> {
  const scope = assertAutomationScope(input);
  const runId = normalizeOpaqueId(input.runId, "runId");
  if (!["not_requested", "pending", "sent", "suppressed", "failed"].includes(input.status)) {
    throw new AutomationTaskError("AUTOMATION_RUN_STATUS_INVALID", input.status);
  }
  sqlite.prepare(`
    UPDATE automation_task_runs SET delivery_status = ?, push_job_id = COALESCE(?, push_job_id), updated_at = ?
    WHERE run_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
  `).run(input.status, input.pushJobId ?? null, nowIso(), runId, scope.userId, scope.projectId, scope.instanceId);
  return runRecordFromRow(requireRunRow(runId, scope));
}

export async function claimAutomationTaskRun(input: ClaimAutomationTaskRunInput): Promise<ClaimAutomationTaskRunResult> {
  const scope = assertAutomationScope(input);
  const taskId = normalizeTaskId(input.taskId);
  const task = requireTaskRow(taskId, scope);
  if (task.status === "archived") throw new AutomationTaskError("AUTOMATION_TASK_ARCHIVED", taskId);
  const origin = input.origin ?? "manual";
  if (origin !== "manual" && origin !== "scheduled") {
    throw new AutomationTaskError("AUTOMATION_RUN_STATUS_INVALID", String(origin));
  }
  if (origin === "scheduled" && task.status !== "active") {
    throw new AutomationTaskError("AUTOMATION_TASK_NOT_ACTIVE", taskId);
  }
  const revision = input.revisionId
    ? requireRevisionById(input.revisionId, scope, taskId)
    : requireRevisionForTask(task, scope);
  if (origin === "scheduled" && revision.revision !== task.currentRevision) {
    throw new AutomationTaskError("AUTOMATION_REVISION_CONFLICT", String(revision.revision));
  }
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const scheduledFor = input.scheduledFor?.trim() || null;
  const now = nowIso();
  const nowMs = Date.parse(now);
  const leaseExpiresAt = new Date(nowMs + AUTOMATION_RUN_LEASE_MS).toISOString();
  const executionDeadlineAt = normalizeExecutionDeadline(input.executionDeadlineAt)
    ?? new Date(nowMs + AUTOMATION_RUN_LEASE_MS).toISOString();
  let claimed = false;
  let run: AutomationTaskRunRecord;
  let staleRecoveredRunId: string | undefined;
  const transaction = sqlite.transaction(() => {
    // A caller retrying the same key must see the latest attempt, while the
    // physical key remains unique for historical stale attempts.
    let existing = selectRunByIdempotency(taskId, idempotencyKey);
    if (existing) {
      assertRowScope(existing, scope);
      assertRunIdempotencyCompatible(existing, revision.revisionId, origin, scheduledFor, input.conversationId);
    }

    // The task row is the cross-origin mutex.  A valid lock always wins over
    // a caller's idempotency key: manual and scheduled runs cannot overlap.
    let lock = readTaskLock(taskId, scope);
    if (lock?.activeRunId) {
      const active = selectRunById(lock.activeRunId, scope);
      const lockExpired = isLeaseExpired(lock.activeRunLeaseExpiresAt, active?.leaseExpiresAt, active?.claimedAt, nowMs);
      if (active?.status === "running" && !lockExpired) {
        run = runRecordFromRow(active);
        return;
      }
      if (active?.status === "running") {
        recoverExpiredRun(active, scope, now);
        staleRecoveredRunId = active.runId;
        if (existing?.runId === active.runId) existing = undefined;
      }
      clearTaskLock(taskId, scope, lock.activeRunId);
      lock = undefined;
    }

    // Old rows created before the mutex migration may still be running with
    // no active_run_id. Adopt a valid row into the DB mutex; recover an
    // expired one before accepting a new attempt.
    existing = selectRunByIdempotency(taskId, idempotencyKey);
    if (existing?.runId === staleRecoveredRunId) existing = undefined;
    if (existing?.status === "running") {
      if (!isLeaseExpired(existing.leaseExpiresAt, undefined, existing.claimedAt, nowMs)) {
        const token = existing.leaseToken || randomUUID();
        if (!tryAcquireTaskLock(taskId, scope, existing.runId, token, leaseExpiresAt, now)) {
          const active = selectActiveRun(taskId, scope);
          if (active) {
            run = runRecordFromRow(active);
            return;
          }
          throw new AutomationTaskError("AUTOMATION_RUN_LEASE_LOST", existing.runId);
        }
        if (!existing.leaseToken) {
          sqlite.prepare(`
            UPDATE automation_task_runs
            SET lease_token = ?, lease_expires_at = ?, updated_at = ?
            WHERE run_id = ? AND status = 'running'
          `).run(token, leaseExpiresAt, now, existing.runId);
        }
        run = runRecordFromRow(selectRunById(existing.runId, scope)!);
        return;
      }
      recoverExpiredRun(existing, scope, now);
      staleRecoveredRunId = existing.runId;
      existing = undefined;
    }

    // A different idempotency key may already have a valid run.  Find it
    // before inserting so this path is safe even for pre-migration rows that
    // have not yet acquired the task mutex.
    const active = selectActiveRun(taskId, scope);
    if (active) {
      if (!isLeaseExpired(active.leaseExpiresAt, undefined, active.claimedAt, nowMs)) {
        const token = active.leaseToken || randomUUID();
        if (!tryAcquireTaskLock(taskId, scope, active.runId, token, leaseExpiresAt, now)) {
          const winner = selectActiveRun(taskId, scope);
          if (winner) {
            run = runRecordFromRow(winner);
            return;
          }
          throw new AutomationTaskError("AUTOMATION_RUN_LEASE_LOST", active.runId);
        }
        if (!active.leaseToken) {
          sqlite.prepare(`
            UPDATE automation_task_runs
            SET lease_token = ?, lease_expires_at = ?, updated_at = ?
            WHERE run_id = ? AND status = 'running'
          `).run(token, leaseExpiresAt, now, active.runId);
        }
        run = runRecordFromRow(selectRunById(active.runId, scope)!);
        return;
      }
      recoverExpiredRun(active, scope, now);
      staleRecoveredRunId = active.runId;
    }

    // Terminal idempotency replays return the original result and never
    // execute ACP again.
    existing = selectRunByIdempotency(taskId, idempotencyKey);
    if (existing?.runId === staleRecoveredRunId) existing = undefined;
    if (existing) {
      assertRowScope(existing, scope);
      assertRunIdempotencyCompatible(existing, revision.revisionId, origin, scheduledFor, input.conversationId);
      run = runRecordFromRow(existing);
      return;
    }

    const runId = `atrun_${randomUUID()}`;
    const leaseToken = randomUUID();
    if (!tryAcquireTaskLock(taskId, scope, runId, leaseToken, leaseExpiresAt, now)) {
      const winner = selectActiveRun(taskId, scope);
      if (winner) {
        run = runRecordFromRow(winner);
        return;
      }
      throw new AutomationTaskError("AUTOMATION_RUN_LEASE_LOST", taskId);
    }
    const previousAttempt = sqlite.prepare(`
      SELECT MAX(attempt) AS attempt
      FROM automation_task_runs
      WHERE task_id = ? AND (idempotency_key = ? OR idempotency_base_key = ?)
    `).get(taskId, idempotencyKey, idempotencyKey) as { attempt?: number | null } | undefined;
    const attempt = Math.max(Number(previousAttempt?.attempt || 0) + 1, 1);
    sqlite.prepare(`
      INSERT INTO automation_task_runs (
        run_id, task_id, revision_id, user_id, project_id, instance_id,
        origin, idempotency_key, idempotency_base_key, attempt, scheduled_for,
        execution_deadline_at, status, claimed_at, started_at, input_asset_id, conversation_id,
        lease_token, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      taskId,
      revision.revisionId,
      scope.userId,
      scope.projectId,
      scope.instanceId,
      origin,
      idempotencyKey,
      idempotencyKey,
      attempt,
      scheduledFor,
      executionDeadlineAt,
      now,
      now,
      revision.workingAssetId ?? revision.sourceAssetId ?? null,
      input.conversationId?.trim() || null,
      leaseToken,
      leaseExpiresAt,
      now,
      now,
    );
    claimed = true;
    run = runRecordFromRow(selectRunById(runId, scope)!);
    insertAuditRow({
      taskId,
      revisionId: revision.revisionId,
      runId: run.runId,
      scope,
      action: "run.claimed",
      status: "success",
      details: { origin, idempotencyKey, attempt, leaseExpiresAt },
      createdAt: now,
    });
  });
  transaction();
  return { claimed, run: run! };
}

function selectRunByIdempotency(taskId: string, idempotencyKey: string): DbRunRow | undefined {
  return sqlite.prepare(`
    SELECT ${RUN_SELECT}
    FROM automation_task_runs
    WHERE task_id = ? AND (idempotency_key = ? OR idempotency_base_key = ?)
    ORDER BY attempt DESC, created_at DESC, run_id DESC
    LIMIT 1
  `).get(taskId, idempotencyKey, idempotencyKey) as DbRunRow | undefined;
}

function selectRunById(runId: string, scope: AutomationScope): DbRunRow | undefined {
  return sqlite.prepare(`
    SELECT ${RUN_SELECT}
    FROM automation_task_runs
    WHERE run_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
  `).get(runId, scope.userId, scope.projectId, scope.instanceId) as DbRunRow | undefined;
}

function selectActiveRun(taskId: string, scope: AutomationScope): DbRunRow | undefined {
  return sqlite.prepare(`
    SELECT ${RUN_SELECT}
    FROM automation_task_runs
    WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ? AND status = 'running'
    ORDER BY claimed_at DESC, run_id DESC
    LIMIT 1
  `).get(taskId, scope.userId, scope.projectId, scope.instanceId) as DbRunRow | undefined;
}

function readTaskLock(taskId: string, scope: AutomationScope): DbTaskLockRow | undefined {
  return sqlite.prepare(`
    SELECT active_run_id AS activeRunId,
           active_run_lease_token AS activeRunLeaseToken,
           active_run_lease_expires_at AS activeRunLeaseExpiresAt
    FROM automation_tasks
    WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
  `).get(taskId, scope.userId, scope.projectId, scope.instanceId) as DbTaskLockRow | undefined;
}

function tryAcquireTaskLock(
  taskId: string,
  scope: AutomationScope,
  runId: string,
  leaseToken: string,
  leaseExpiresAt: string,
  now: string,
): boolean {
  const result = sqlite.prepare(`
    UPDATE automation_tasks
    SET active_run_id = ?, active_run_lease_token = ?, active_run_lease_expires_at = ?, updated_at = ?
    WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
      AND (
        active_run_id IS NULL
        OR active_run_lease_expires_at IS NULL
        OR active_run_lease_expires_at <= ?
      )
  `).run(
    runId,
    leaseToken,
    leaseExpiresAt,
    now,
    taskId,
    scope.userId,
    scope.projectId,
    scope.instanceId,
    now,
  );
  return result.changes > 0;
}

function clearTaskLock(taskId: string, scope: AutomationScope, runId: string): void {
  sqlite.prepare(`
    UPDATE automation_tasks
    SET active_run_id = NULL, active_run_lease_token = NULL, active_run_lease_expires_at = NULL,
        updated_at = ?
    WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ? AND active_run_id = ?
  `).run(nowIso(), taskId, scope.userId, scope.projectId, scope.instanceId, runId);
}

function assertRunIdempotencyCompatible(
  existing: DbRunRow,
  revisionId: string,
  origin: AutomationTaskRunOrigin,
  scheduledFor: string | null,
  conversationId?: string | null,
): void {
  if (
    existing.revisionId !== revisionId
    || existing.origin !== origin
    || existing.scheduledFor !== scheduledFor
    // A retry may omit the conversation binding because the first claimant
    // creates the deterministic manual conversation after the DB claim.
    || (conversationId?.trim() && existing.conversationId !== conversationId.trim())
  ) {
    throw new AutomationTaskError("AUTOMATION_RUN_IDEMPOTENCY_CONFLICT", existing.idempotencyKey);
  }
}

function isLeaseExpired(
  primaryExpiry: string | null | undefined,
  secondaryExpiry: string | null | undefined,
  claimedAt: string | null | undefined,
  nowMs: number,
): boolean {
  const expiry = primaryExpiry || secondaryExpiry;
  if (expiry) {
    const expiryMs = Date.parse(expiry);
    if (Number.isFinite(expiryMs)) return expiryMs <= nowMs;
  }
  const claimedMs = claimedAt ? Date.parse(claimedAt) : Number.NaN;
  return !Number.isFinite(claimedMs) || claimedMs + AUTOMATION_RUN_LEASE_MS <= nowMs;
}

function recoverExpiredRun(row: DbRunRow, scope: AutomationScope, now: string): void {
  const physicalKey = row.physicalIdempotencyKey || row.idempotencyKey;
  const suffix = `::stale:${row.runId}`;
  const archiveKey = `${physicalKey.slice(0, Math.max(1, MAX_IDEMPOTENCY_KEY_LENGTH - suffix.length))}${suffix}`;
  const updated = sqlite.prepare(`
    UPDATE automation_task_runs
    SET idempotency_key = ?, status = 'failed', finished_at = ?,
        error_message = COALESCE(error_message, ?), error_category = COALESCE(error_category, 'expired'), retryable = 0, lease_token = NULL,
        lease_expires_at = NULL, updated_at = ?
    WHERE run_id = ? AND user_id = ? AND project_id = ? AND instance_id = ? AND status = 'running'
  `).run(
    archiveKey,
    now,
    "AUTOMATION_RUN_LEASE_EXPIRED: execution lease expired before completion",
    now,
    row.runId,
    scope.userId,
    scope.projectId,
    scope.instanceId,
  );
  if (updated.changes === 0) return;
  insertAuditRow({
    taskId: row.taskId,
    revisionId: row.revisionId,
    runId: row.runId,
    scope,
    action: "run.lease_expired",
    status: "recovered",
    details: {
      idempotencyKey: row.idempotencyKey,
      attempt: row.attempt,
      archiveKey,
    },
    createdAt: now,
  });
}

function assertAutomationTaskRunLeaseSync(
  row: DbRunRow,
  scope: AutomationScope,
  suppliedLeaseToken: string | null | undefined,
  nowMs: number,
): void {
  if (row.status !== "running") throw new AutomationTaskError("AUTOMATION_RUN_LEASE_LOST", row.runId);
  const lock = readTaskLock(row.taskId, scope);
  const expectedToken = suppliedLeaseToken ?? row.leaseToken;
  if (
    !lock
    || lock.activeRunId !== row.runId
    || isLeaseExpired(lock.activeRunLeaseExpiresAt, row.leaseExpiresAt, row.claimedAt, nowMs)
    || (expectedToken && lock.activeRunLeaseToken !== expectedToken)
    || (suppliedLeaseToken === undefined && row.leaseToken && lock.activeRunLeaseToken !== row.leaseToken)
  ) {
    throw new AutomationTaskError("AUTOMATION_RUN_LEASE_LOST", row.runId, {
      activeRunId: lock?.activeRunId,
      leaseExpiresAt: lock?.activeRunLeaseExpiresAt,
    });
  }
}

/**
 * Complete a run while an outer SQLite transaction is already open. Generic
 * asset output commits use this hook so the version head and run terminal
 * state cannot become visible independently.
 */
export function finalizeAutomationTaskRunInTransaction(input: FinishAutomationTaskRunInput): AutomationTaskRunRecord {
  const scope = assertAutomationScope(input);
  const runId = normalizeOpaqueId(input.runId, "runId");
  if (!["succeeded", "failed", "skipped", "cancelled"].includes(input.status)) {
    throw new AutomationTaskError("AUTOMATION_RUN_STATUS_INVALID", String(input.status));
  }
  const existing = requireRunRow(runId, scope);
  if (existing.status !== "running") {
    if (existing.status === input.status) return runRecordFromRow(existing);
    throw new AutomationTaskError("AUTOMATION_RUN_ALREADY_FINISHED", runId);
  }
  if (input.outputAssetId) {
    const revision = requireRevisionById(existing.revisionId, scope, existing.taskId);
    if (revision.outputJson !== null) {
      const output = sqlite.prepare(`SELECT asset_id FROM user_assets WHERE asset_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?`).get(input.outputAssetId, scope.userId, scope.projectId, scope.instanceId);
      if (!output) throw new AutomationTaskError("AUTOMATION_SCOPE_MISMATCH", input.outputAssetId);
    } else {
      const output = requireAssetRow(input.outputAssetId, scope);
      if (output.taskId !== existing.taskId) throw new AutomationTaskError("AUTOMATION_SCOPE_MISMATCH", input.outputAssetId);
    }
  }
  const now = nowIso();
  const resultSummary = clipNullable(input.resultSummary, 4_000);
  const errorMessage = clipNullable(input.errorMessage, 1_200);
  const traceId = clipNullable(input.traceId, 300);
  const outputChecksum = clipNullable(input.outputChecksum, 128);
  const expired = existing.executionDeadlineAt !== null && Date.parse(existing.executionDeadlineAt) <= Date.parse(now);
  const finalStatus: Exclude<AutomationTaskRunStatus, "running"> = expired ? "failed" : input.status;
  const errorCategory = expired
    ? "expired"
    : normalizeErrorCategory(input.errorCategory, finalStatus);
  const retryable = expired ? false : (input.retryable ?? defaultRetryable(errorCategory, finalStatus));
  const finalErrorMessage = expired
    ? (errorMessage || "AUTOMATION_RUN_EXECUTION_DEADLINE_EXCEEDED")
    : errorMessage;
  const task = requireTaskRow(existing.taskId, scope);
  const revision = requireRevisionById(existing.revisionId, scope, existing.taskId);
  const leaseToken = input.leaseToken ?? existing.leaseToken;
  const updated = sqlite.prepare(`
    UPDATE automation_task_runs
    SET status = ?, finished_at = ?, output_asset_id = ?, output_checksum = ?,
        output_version_id = ?, result_summary = ?, error_message = ?, error_category = ?, retryable = ?, trace_id = ?, lease_expires_at = NULL, updated_at = ?
    WHERE run_id = ? AND user_id = ? AND project_id = ? AND instance_id = ? AND status = 'running'
      AND EXISTS (
        SELECT 1 FROM automation_tasks t
        WHERE t.task_id = ? AND t.user_id = ? AND t.project_id = ? AND t.instance_id = ?
          AND t.active_run_id = ?
          AND t.active_run_lease_expires_at > ?
          AND (? IS NULL OR t.active_run_lease_token = ?)
      )
  `).run(
    finalStatus, now, expired ? null : (input.outputAssetId ?? null), expired ? null : outputChecksum, expired ? null : (input.outputVersionId ?? null),
    resultSummary, finalErrorMessage, errorCategory, retryable === null ? null : (retryable ? 1 : 0), traceId, now, runId, scope.userId, scope.projectId, scope.instanceId,
    existing.taskId, scope.userId, scope.projectId, scope.instanceId, runId, now, leaseToken, leaseToken,
  );
  if (updated.changes === 0) throw new AutomationTaskError("AUTOMATION_RUN_LEASE_LOST", runId);
  sqlite.prepare(`
    UPDATE automation_tasks
    SET active_run_id = NULL, active_run_lease_token = NULL,
        active_run_lease_expires_at = NULL, updated_at = ?
    WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
      AND active_run_id = ? AND (? IS NULL OR active_run_lease_token = ?)
  `).run(now, existing.taskId, scope.userId, scope.projectId, scope.instanceId, runId, leaseToken, leaseToken);
  insertAuditRow({
    taskId: existing.taskId, revisionId: existing.revisionId, runId, scope,
    action: "run.finished", status: "success",
    details: { runStatus: finalStatus, hasOutputAsset: Boolean(expired ? null : input.outputAssetId), attempt: existing.attempt, errorCategory, retryable },
    createdAt: now,
  });
  const schedule = parseScheduleJson(revision.scheduleJson);
  if (input.status === "succeeded" || input.status === "skipped" || input.status === "cancelled") {
    const nextRunAt = task.status === "active" ? nextAutomationRunAt(schedule, new Date(now)) : task.nextRunAt;
    sqlite.prepare(`
      UPDATE automation_tasks SET next_run_at = ?, consecutive_failures = 0, updated_at = ?
      WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
    `).run(nextRunAt ?? null, now, existing.taskId, scope.userId, scope.projectId, scope.instanceId);
  } else if (input.status === "failed") {
    const failures = Number(task.consecutiveFailures || 0) + 1;
    const needsAttention = failures >= 3;
    const nextRunAt = task.status === "active" && !needsAttention ? nextAutomationRunAt(schedule, new Date(now)) : null;
    sqlite.prepare(`
      UPDATE automation_tasks SET consecutive_failures = ?, status = CASE WHEN ? = 1 THEN 'needs_attention' ELSE status END,
        next_run_at = ?, updated_at = ?
      WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
    `).run(failures, needsAttention ? 1 : 0, nextRunAt, now, existing.taskId, scope.userId, scope.projectId, scope.instanceId);
  }
  return runRecordFromRow(requireRunRow(runId, scope));
}

export async function finishAutomationTaskRun(input: FinishAutomationTaskRunInput): Promise<AutomationTaskRunRecord> {
  return sqlite.transaction(() => finalizeAutomationTaskRunInTransaction(input))();
}

function latestRunsByTask(scope: AutomationScope): Map<string, NonNullable<AutomationTaskSummary["latestRun"]>> {
  const rows = sqlite.prepare(`
    SELECT ${RUN_SELECT}
    FROM automation_task_runs
    WHERE user_id = ? AND project_id = ? AND instance_id = ?
    ORDER BY created_at DESC, run_id DESC
  `).all(scope.userId, scope.projectId, scope.instanceId) as DbRunRow[];
  const latest = new Map<string, NonNullable<AutomationTaskSummary["latestRun"]>>();
  for (const row of rows) {
    if (latest.has(row.taskId)) continue;
    const run = runRecordFromRow(row);
    latest.set(row.taskId, {
      runId: run.runId,
      status: run.status,
      origin: run.origin,
      finishedAt: run.finishedAt,
      resultSummary: run.resultSummary,
      errorMessage: run.errorMessage,
      attempt: run.attempt,
    });
  }
  return latest;
}

function taskStatusRank(status: AutomationTaskStatus): number {
  return status === "needs_attention" ? 0 : status === "active" ? 1 : status === "paused" ? 2 : 3;
}

function taskCursorKey(task: AutomationTaskRecord): string {
  const primary = task.status === "active" ? (task.nextRunAt ?? "9999-12-31T23:59:59.999Z") : task.updatedAt;
  return `${taskStatusRank(task.status)}|${primary}|${task.taskId}`;
}

function compareTaskSummaries(left: AutomationTaskSummary, right: AutomationTaskSummary): number {
  const rankDifference = taskStatusRank(left.status) - taskStatusRank(right.status);
  if (rankDifference !== 0) return rankDifference;
  if (left.status === "active") {
    const nextDifference = (left.nextRunAt ?? "9999-12-31T23:59:59.999Z").localeCompare(right.nextRunAt ?? "9999-12-31T23:59:59.999Z");
    if (nextDifference !== 0) return nextDifference;
  } else {
    const updatedDifference = right.updatedAt.localeCompare(left.updatedAt);
    if (updatedDifference !== 0) return updatedDifference;
  }
  return left.taskId.localeCompare(right.taskId);
}

function normalizeListLimit(value: number | undefined): number {
  return Math.min(Math.max(Math.trunc(value ?? 50), 1), 100);
}

function encodeListCursor(key: string): string {
  return Buffer.from(JSON.stringify({ key }), "utf8").toString("base64url");
}

function decodeListCursor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { key?: unknown };
    if (typeof parsed.key === "string" && parsed.key.length > 0) return parsed.key;
  } catch {
    // Fall through to the stable public error below.
  }
  throw new AutomationTaskError("AUTOMATION_INVALID_CURSOR", "cursor");
}

function cursorIndex<T>(items: T[], cursor: string | undefined, keyOf: (item: T) => string): number {
  const decoded = decodeListCursor(cursor);
  if (!decoded) return 0;
  const index = items.findIndex((item) => keyOf(item as T) === decoded);
  return index < 0 ? 0 : index + 1;
}

function encodeRunCursor(run: AutomationTaskRunRecord): string {
  return Buffer.from(JSON.stringify({ createdAt: run.createdAt, attempt: run.attempt, runId: run.runId }), "utf8").toString("base64url");
}

function decodeRunCursor(value: string | undefined): { createdAt: string; attempt: number; runId: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { createdAt?: unknown; attempt?: unknown; runId?: unknown };
    if (typeof parsed.createdAt === "string" && typeof parsed.runId === "string" && parsed.runId.length > 0) {
      const attempt = Number.isInteger(parsed.attempt) && Number(parsed.attempt) > 0 ? Number(parsed.attempt) : 1;
      return { createdAt: parsed.createdAt, attempt, runId: parsed.runId };
    }
  } catch {
    // Fall through to the stable public error below.
  }
  throw new AutomationTaskError("AUTOMATION_INVALID_CURSOR", "cursor");
}

export async function listAutomationTaskRuns(input: AutomationTaskRunListInput): Promise<AutomationRunSummary[]> {
  return (await listAutomationTaskRunsPage(input)).items;
}

export async function listAutomationTaskRunsPage(input: AutomationTaskRunListInput): Promise<{ items: AutomationRunSummary[]; nextCursor?: string }> {
  const scope = assertAutomationScope(input);
  const where = ["automation_task_runs.user_id = ?", "automation_task_runs.project_id = ?", "automation_task_runs.instance_id = ?"];
  const params: unknown[] = [scope.userId, scope.projectId, scope.instanceId];
  if (input.taskId) {
    const taskId = normalizeTaskId(input.taskId);
    requireTaskRow(taskId, scope);
    where.push("automation_task_runs.task_id = ?");
    params.push(taskId);
  }
  if (input.query?.trim()) {
    const like = `%${input.query.trim()}%`;
    where.push("(revision.name LIKE ? OR COALESCE(automation_task_runs.result_summary, '') LIKE ? OR COALESCE(automation_task_runs.error_message, '') LIKE ?)");
    params.push(like, like, like);
  }
  if (input.statuses?.length) {
    where.push(`automation_task_runs.status IN (${input.statuses.map(() => "?").join(",")})`);
    params.push(...input.statuses);
  }
  if (input.origins?.length) {
    where.push(`automation_task_runs.origin IN (${input.origins.map(() => "?").join(",")})`);
    params.push(...input.origins);
  }
  if (input.deliveryStatuses?.length) {
    where.push(`automation_task_runs.delivery_status IN (${input.deliveryStatuses.map(() => "?").join(",")})`);
    params.push(...input.deliveryStatuses);
  }
  if (input.hasOutput !== undefined) {
    where.push(input.hasOutput ? "automation_task_runs.output_asset_id IS NOT NULL" : "automation_task_runs.output_asset_id IS NULL");
  }
  if (input.from) {
    where.push("automation_task_runs.created_at >= ?");
    params.push(input.from);
  }
  if (input.to) {
    where.push("automation_task_runs.created_at < ?");
    params.push(input.to);
  }
  const cursor = decodeRunCursor(input.cursor);
  if (cursor) {
    where.push("(automation_task_runs.created_at < ? OR (automation_task_runs.created_at = ? AND (automation_task_runs.attempt < ? OR (automation_task_runs.attempt = ? AND automation_task_runs.run_id < ?))))");
    params.push(cursor.createdAt, cursor.createdAt, cursor.attempt, cursor.attempt, cursor.runId);
  }
  const limit = normalizeListLimit(input.limit);
  const rows = sqlite.prepare(`
    SELECT ${RUN_SELECT}
    FROM automation_task_runs
    JOIN automation_task_revisions revision ON revision.revision_id = automation_task_runs.revision_id
    WHERE ${where.join(" AND ")}
    ORDER BY automation_task_runs.created_at DESC, automation_task_runs.attempt DESC, automation_task_runs.run_id DESC
    LIMIT ?
  `).all(...params, limit + 1) as DbRunRow[];
  const items = rows.slice(0, limit).map((row) => {
    const run = runRecordFromRow(row);
    return { ...run, taskName: run.taskName ?? "自动化任务" };
  });
  const last = items.at(-1);
  return { items, ...(rows.length > limit && last ? { nextCursor: encodeRunCursor(last) } : {}) };
}

export async function batchAutomationTaskAction(input: AutomationBatchActionInput): Promise<AutomationBatchActionResult> {
  const scope = assertAutomationScope(input);
  if (!["pause", "activate", "archive"].includes(input.action)) throw new AutomationTaskError("AUTOMATION_BATCH_INVALID", "action");
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) throw new AutomationTaskError("AUTOMATION_BATCH_INVALID", "items must contain 1..100 tasks");
  if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) throw new AutomationTaskError("AUTOMATION_BATCH_INVALID", "idempotencyKey");
  const seen = new Set<string>();
  for (const item of input.items) {
    const taskId = normalizeTaskId(item.taskId);
    if (seen.has(taskId) || !Number.isInteger(item.expectedRevision) || item.expectedRevision < 1) throw new AutomationTaskError("AUTOMATION_BATCH_INVALID", "duplicate task or invalid revision");
    seen.add(taskId);
  }
  const correlationId = `atbatch_${randomUUID()}`;
  const results: AutomationBatchActionResultItem[] = [];
  for (const item of input.items) {
    const taskId = normalizeTaskId(item.taskId);
    try {
      const current = requireTaskRow(taskId, scope);
      if (input.action === "activate" && current.status === "needs_attention") {
        throw new AutomationTaskError("AUTOMATION_TASK_NEEDS_ATTENTION", taskId);
      }
      if (input.action !== "pause" && hasRunningAutomationTaskRun(taskId, scope)) {
        throw new AutomationTaskError("AUTOMATION_TASK_BUSY", taskId);
      }
      const task = input.action === "pause"
        ? await setAutomationTaskStatus({ ...scope, taskId, expectedRevision: item.expectedRevision }, "paused", correlationId)
        : input.action === "activate"
          ? await setAutomationTaskStatus({ ...scope, taskId, expectedRevision: item.expectedRevision }, "active", correlationId)
          : await setAutomationTaskStatus({ ...scope, taskId, expectedRevision: item.expectedRevision }, "archived", correlationId);
      results.push({ taskId, ok: true, task });
    } catch (error) {
      if (error instanceof AutomationTaskError) {
        const current = readTaskRow(taskId);
        if (current && current.userId === scope.userId && current.projectId === scope.projectId && current.instanceId === scope.instanceId) {
          try {
            insertAuditRow({
              taskId,
              revisionId: current.currentRevisionId,
              scope,
              action: input.action === "activate" ? "task.activated" : input.action === "archive" ? "task.archived" : "task.paused",
              status: "failed",
              details: { revision: current.currentRevision, correlationId, errorCode: error.code },
              createdAt: nowIso(),
            });
          } catch {
            // A failed audit must never hide the original per-item result.
          }
        }
        results.push({ taskId, ok: false, error: { code: error.code, message: error.message.replace(`${error.code}:`, ""), retryable: error.code === "AUTOMATION_TASK_BUSY" } });
      } else {
        results.push({ taskId, ok: false, error: { code: "INTERNAL_ERROR", message: "批量操作失败", retryable: true } });
      }
    }
  }
  return { results, correlationId };
}

export async function getAutomationTaskRun(input: AutomationTaskRunLookup): Promise<AutomationTaskRunRecord | null> {
  const scope = assertAutomationScope(input);
  const runId = normalizeOpaqueId(input.runId, "runId");
  const row = sqlite.prepare(`SELECT ${RUN_SELECT} FROM automation_task_runs WHERE run_id = ?`).get(runId) as DbRunRow | undefined;
  if (!row) return null;
  assertRowScope(row, scope);
  return runRecordFromRow(row);
}

export async function createAutomationTaskAsset(input: CreateAutomationTaskAssetInput): Promise<AutomationTaskAssetRecord> {
  const scope = assertAutomationScope(input);
  const taskId = normalizeTaskId(input.taskId);
  requireTaskRow(taskId, scope);
  if (input.revisionId) requireRevisionById(input.revisionId, scope, taskId);
  const normalized = normalizeAssetInput(input.asset);
  await assertStructuredAsset(normalized);
  const relativePath = automationAssetRelativePath(taskId, input.assetRole, normalized.fileName);
  const existing = sqlite.prepare(`
    SELECT ${ASSET_SELECT}
    FROM automation_task_assets
    WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
      AND asset_role = ? AND relative_path = ?
  `).get(taskId, scope.userId, scope.projectId, scope.instanceId, input.assetRole, relativePath) as DbAssetRow | undefined;

  if (input.assetRole === "source" && existing) {
    throw new AutomationTaskError("AUTOMATION_ASSET_SOURCE_IMMUTABLE", relativePath);
  }
  if (input.assetRole === "working" && existing && !input.overwrite) {
    throw new AutomationTaskError("AUTOMATION_ASSET_EXISTS", relativePath);
  }

  const createdPaths: string[] = [];
  let written: WrittenAsset;
  if (existing && input.assetRole === "working") {
    written = await replaceWorkingAssetFile({ scope, taskId, assetRole: "working", asset: normalized });
  } else {
    written = await writeNewAssetFile({ scope, taskId, assetRole: input.assetRole, asset: normalized, createdPaths });
  }
  const now = nowIso();
  try {
    if (existing && input.assetRole === "working") {
      sqlite.prepare(`
        UPDATE automation_task_assets
        SET revision_id = COALESCE(?, revision_id), file_name = ?, relative_path = ?, mime_type = ?,
            extension = ?, size_bytes = ?, checksum = ?, updated_at = ?
        WHERE asset_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
      `).run(
        input.revisionId ?? null,
        normalized.fileName,
        written.relativePath,
        normalized.mimeType,
        normalized.extension,
        normalized.bytes.length,
        normalized.checksum,
        now,
        existing.assetId,
        scope.userId,
        scope.projectId,
        scope.instanceId,
      );
    } else {
      insertAssetRow({
        assetId: `ata_${randomUUID()}`,
        taskId,
        revisionId: input.revisionId ?? null,
        scope,
        assetRole: input.assetRole,
        fileName: normalized.fileName,
        relativePath: written.relativePath,
        mimeType: normalized.mimeType,
        extension: normalized.extension,
        sizeBytes: normalized.bytes.length,
        checksum: normalized.checksum,
        createdAt: now,
        updatedAt: now,
      });
    }
    const saved = sqlite.prepare(`
      SELECT ${ASSET_SELECT}
      FROM automation_task_assets
      WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
        AND asset_role = ? AND relative_path = ?
    `).get(taskId, scope.userId, scope.projectId, scope.instanceId, input.assetRole, relativePath) as DbAssetRow | undefined;
    if (!saved) throw new AutomationTaskError("AUTOMATION_DATA_CORRUPT", relativePath);
    insertAuditRow({
      taskId,
      revisionId: input.revisionId ?? saved.revisionId,
      assetId: saved.assetId,
      scope,
      action: existing ? "asset.working_replaced" : "asset.created",
      status: "success",
      details: { assetRole: input.assetRole, relativePath, sizeBytes: normalized.bytes.length },
      createdAt: now,
    });
    return assetRecordFromRow(saved);
  } catch (error) {
    await cleanupCreatedFiles(createdPaths);
    throw error;
  }
}

export async function writeAutomationTaskWorkingAsset(input: Omit<CreateAutomationTaskAssetInput, "assetRole" | "overwrite">): Promise<AutomationTaskAssetRecord> {
  return createAutomationTaskAsset({ ...input, assetRole: "working", overwrite: true });
}

/** Reconcile a working file changed by the isolated ACP process. */
export async function refreshAutomationTaskWorkingAsset(input: AutomationTaskLookup & { revisionId?: string }): Promise<AutomationTaskAssetRecord> {
  const scope = assertAutomationScope(input);
  const task = requireTaskRow(normalizeTaskId(input.taskId), scope);
  const revision = input.revisionId ? requireRevisionById(input.revisionId, scope, task.taskId) : requireRevisionForTask(task, scope);
  if (!revision.workingAssetId) throw new AutomationTaskError("AUTOMATION_ASSET_NOT_FOUND", task.taskId);
  const row = requireAssetRow(revision.workingAssetId, scope);
  if (row.assetRole !== "working") throw new AutomationTaskError("AUTOMATION_ASSET_UNSAFE", row.assetId);
  const expected = automationAssetRelativePath(row.taskId, "working", row.fileName);
  if (row.relativePath !== expected) throw new AutomationTaskError("AUTOMATION_ASSET_UNSAFE", row.relativePath);
  const workspace = workspacePathForScope(scope);
  const root = await realpath(workspace).catch(() => { throw new AutomationTaskError("AUTOMATION_WORKSPACE_NOT_FOUND", scope.userId); });
  const target = path.resolve(workspace, expected);
  const raw = await lstat(target).catch(() => null);
  if (!raw || raw.isSymbolicLink() || !raw.isFile()) throw new AutomationTaskError("AUTOMATION_ASSET_NOT_FOUND", expected);
  const realTarget = await realpath(target);
  if (!isWithin(root, realTarget)) throw new AutomationTaskError("AUTOMATION_ASSET_UNSAFE", expected);
  const bytes = await readFile(realTarget);
  if (bytes.length > MAX_ASSET_BYTES) throw new AutomationTaskError("AUTOMATION_ASSET_TOO_LARGE", row.assetId);
  const updatedAt = nowIso();
  sqlite.prepare(`UPDATE automation_task_assets SET size_bytes = ?, checksum = ?, updated_at = ? WHERE asset_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?`).run(bytes.length, sha256Hex(bytes), updatedAt, row.assetId, scope.userId, scope.projectId, scope.instanceId);
  insertAuditRow({ taskId: row.taskId, revisionId: row.revisionId, assetId: row.assetId, scope, action: "asset.working_reconciled", status: "success", details: { sizeBytes: bytes.length }, createdAt: updatedAt });
  return assetRecordFromRow(requireAssetRow(row.assetId, scope));
}

export function bindAutomationTaskRunConversation(input: AutomationTaskRunLookup & { conversationId: string }): AutomationTaskRunRecord {
  const scope = assertAutomationScope(input);
  const run = requireRunRow(normalizeOpaqueId(input.runId, "runId"), scope);
  const conversationId = normalizeOpaqueId(input.conversationId, "conversationId");
  if (run.conversationId && run.conversationId !== conversationId) throw new AutomationTaskError("AUTOMATION_RUN_IDEMPOTENCY_CONFLICT", run.runId);
  sqlite.prepare(`UPDATE automation_task_runs SET conversation_id = ?, updated_at = ? WHERE run_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?`).run(conversationId, nowIso(), run.runId, scope.userId, scope.projectId, scope.instanceId);
  return runRecordFromRow(requireRunRow(run.runId, scope));
}

export async function getAutomationTaskAsset(input: AutomationTaskAssetLookup): Promise<AutomationTaskAssetRecord | null> {
  const scope = assertAutomationScope(input);
  const assetId = normalizeOpaqueId(input.assetId, "assetId");
  const row = sqlite.prepare(`SELECT ${ASSET_SELECT} FROM automation_task_assets WHERE asset_id = ?`).get(assetId) as DbAssetRow | undefined;
  if (!row) return null;
  assertRowScope(row, scope);
  return assetRecordFromRow(row);
}

export async function readAutomationTaskAsset(input: AutomationTaskAssetLookup): Promise<AutomationTaskAssetPayload> {
  return readAutomationTaskAssetWithAction(input, "asset.read");
}

export async function downloadAutomationTaskAsset(input: AutomationTaskAssetLookup): Promise<AutomationTaskAssetPayload> {
  return readAutomationTaskAssetWithAction(input, "asset.download");
}

export async function listAutomationTaskAssets(input: AutomationTaskLookup): Promise<AutomationTaskAssetRecord[]> {
  const scope = assertAutomationScope(input);
  const taskId = normalizeTaskId(input.taskId);
  requireTaskRow(taskId, scope);
  const rows = sqlite.prepare(`
    SELECT ${ASSET_SELECT}
    FROM automation_task_assets
    WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
    ORDER BY asset_role ASC, updated_at DESC, asset_id ASC
  `).all(taskId, scope.userId, scope.projectId, scope.instanceId) as DbAssetRow[];
  return rows.map(assetRecordFromRow);
}

export async function listAutomationTaskAuditLogs(input: AutomationTaskLookup): Promise<AutomationTaskAuditRecord[]> {
  const scope = assertAutomationScope(input);
  const taskId = normalizeTaskId(input.taskId);
  requireTaskRow(taskId, scope);
  const rows = sqlite.prepare(`
    SELECT
      audit_id AS auditId, task_id AS taskId, revision_id AS revisionId, run_id AS runId,
      asset_id AS assetId, user_id AS userId, project_id AS projectId, instance_id AS instanceId,
      action, status, details_json AS detailsJson, created_at AS createdAt
    FROM automation_task_audit_logs
    WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
    ORDER BY created_at DESC, audit_id DESC
  `).all(taskId, scope.userId, scope.projectId, scope.instanceId) as Array<DbAuditRow>;
  return rows.map(auditRecordFromRow);
}

export function recordAutomationTaskAudit(input: {
  taskId: string;
  revisionId?: string | null;
  runId?: string | null;
  assetId?: string | null;
  scope: AutomationScope;
  action: string;
  status: string;
  details?: Record<string, unknown>;
  createdAt?: string;
}): void {
  insertAuditRow({ ...input, createdAt: input.createdAt ?? nowIso() });
}

/** Return the next wall-clock occurrence in the task's declared timezone. */
export function nextAutomationRunAt(schedule: AutomationSchedule | Record<string, unknown>, from = new Date()): string {
  const normalized = normalizeAutomationSchedule(schedule);
  const start = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  // Monthly needs a horizon beyond one month; everything else fits in 8 days.
  const horizonMinutes = normalized.frequency === "monthly" ? 40 * 24 * 60 : 8 * 24 * 60;
  const triggerTimes = new Set([normalized.time, ...(normalized.windows ?? [])]);
  for (let index = 0; index <= horizonMinutes; index += 1) {
    const candidate = new Date(start + index * 60_000);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: normalized.timezone,
      weekday: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(candidate);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(values.weekday));
    if (!triggerTimes.has(`${values.hour}:${values.minute}`)) continue;
    if ((normalized.frequency === "trading_days" || normalized.frequency === "weekdays") && !isAshareTradingDay(candidate)) continue;
    if (normalized.frequency === "weekly" && !normalized.weekdays?.includes(weekday)) continue;
    if (normalized.frequency === "monthly" && Number(values.day) !== normalized.monthlyDay) continue;
    return candidate.toISOString();
  }
  throw new AutomationTaskError("AUTOMATION_INVALID_SCHEDULE", "no occurrence in the schedule horizon");
}

export async function listDueAutomationTasks(at = new Date(), limit = 100): Promise<AutomationTaskRecord[]> {
  const rows = sqlite.prepare(`
    SELECT ${TASK_SELECT}
    FROM automation_tasks
    WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
    ORDER BY next_run_at ASC, task_id ASC
    LIMIT ?
  `).all(at.toISOString(), Math.min(Math.max(Math.trunc(limit), 1), 500)) as DbTaskRow[];
  return rows.map((row) => taskRecordFromRow(row, { userId: row.userId, projectId: row.projectId, instanceId: row.instanceId }));
}

type DbAuditRow = {
  auditId: string;
  taskId: string;
  revisionId: string | null;
  runId: string | null;
  assetId: string | null;
  userId: string;
  projectId: string;
  instanceId: string;
  action: string;
  status: string;
  detailsJson: string;
  createdAt: string;
};

async function setAutomationTaskStatus(input: AutomationTaskLookup & { expectedRevision?: number }, status: AutomationTaskStatus, correlationId?: string): Promise<AutomationTaskRecord> {
  const scope = assertAutomationScope(input);
  const taskId = normalizeTaskId(input.taskId);
  const task = requireTaskRow(taskId, scope);
  if (input.expectedRevision !== undefined && input.expectedRevision !== task.currentRevision) {
    throw new AutomationTaskError("AUTOMATION_REVISION_CONFLICT", String(input.expectedRevision));
  }
  if (status === "active" && task.status === "needs_attention") {
    throw new AutomationTaskError("AUTOMATION_TASK_NEEDS_ATTENTION", taskId);
  }
  if (status !== "archived" && task.status === "archived") throw new AutomationTaskError("AUTOMATION_TASK_ARCHIVED", taskId);
  if (status === "archived" && task.status === "archived") return requireAutomationTask({ ...scope, taskId });
  const now = nowIso();
  const revision = requireRevisionForTask(task, scope);
  const nextRunAt = status === "active" ? nextAutomationRunAt(parseScheduleJson(revision.scheduleJson), new Date(now)) : null;
  const transaction = sqlite.transaction(() => {
    sqlite.prepare(`
      UPDATE automation_tasks SET status = ?, next_run_at = ?, consecutive_failures = CASE WHEN ? = 'active' THEN 0 ELSE consecutive_failures END, updated_at = ?
      WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
    `).run(status, nextRunAt, status, now, taskId, scope.userId, scope.projectId, scope.instanceId);
    insertAuditRow({
      taskId,
      revisionId: task.currentRevisionId,
      scope,
      action: status === "active" ? "task.activated" : status === "archived" ? "task.archived" : "task.paused",
      status: "success",
      details: { revision: task.currentRevision, status, nextRunAt, ...(correlationId ? { correlationId } : {}) },
      createdAt: now,
    });
  });
  transaction();
  return requireAutomationTask({ ...scope, taskId });
}

function hasRunningAutomationTaskRun(taskId: string, scope: AutomationScope): boolean {
  const row = sqlite.prepare(`
    SELECT run_id
    FROM automation_task_runs
    WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ? AND status = 'running'
    LIMIT 1
  `).get(taskId, scope.userId, scope.projectId, scope.instanceId) as { run_id?: string } | undefined;
  return Boolean(row?.run_id);
}

function taskRecordFromRow(row: DbTaskRow, scope: AutomationScope): AutomationTaskRecord {
  const revision = findRevisionForTask(row, scope);
  const sourceAsset = revision.sourceAssetId ? findAssetById(revision.sourceAssetId, scope) : null;
  const workingAsset = revision.workingAssetId ? findAssetById(revision.workingAssetId, scope) : null;
  return {
    ...scope,
    taskId: row.taskId,
    taskType: row.taskType ?? null,
    status: parseTaskStatus(row.status),
    currentRevision: row.currentRevision,
    currentRevisionId: row.currentRevisionId,
    nextRunAt: row.nextRunAt,
    consecutiveFailures: Number(row.consecutiveFailures || 0),
    revision: revisionRecordFromRow(revision),
    sourceAsset: sourceAsset ? assetRecordFromRow(sourceAsset) : null,
    workingAsset: workingAsset ? assetRecordFromRow(workingAsset) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function revisionRecordFromRow(row: DbRevisionRow): AutomationTaskRevisionRecord {
  const generic = row.instruction !== null || row.inputsJson !== null || row.outputJson !== null || row.deliveryJson !== null;
  return {
    userId: row.userId,
    projectId: row.projectId,
    instanceId: row.instanceId,
    revisionId: row.revisionId,
    taskId: row.taskId,
    revision: row.revision,
    name: row.name,
    description: row.description,
    instruction: row.instruction ?? "",
    schedule: parseScheduleJson(row.scheduleJson),
    inputs: generic ? parseBindingJson(row.inputsJson) : [],
    output: generic ? parseOutputJson(row.outputJson) : { mode: "none" },
    delivery: generic ? parseDeliveryJson(row.deliveryJson) : { mode: "none" },
    sourceAssetId: row.sourceAssetId,
    workingAssetId: row.workingAssetId,
    createdAt: row.createdAt,
  };
}

function parseBindingJson(value: string | null): AutomationTaskAssetBinding[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("bindings");
    return parsed.map((item) => normalizeAssetBinding(item as Record<string, unknown>));
  } catch {
    throw new AutomationTaskError("AUTOMATION_DATA_CORRUPT", "inputs");
  }
}

function parseOutputJson(value: string | null): AutomationTaskOutputPolicy {
  try { return normalizeOutputPolicy(value ? JSON.parse(value) : undefined); }
  catch { throw new AutomationTaskError("AUTOMATION_DATA_CORRUPT", "output"); }
}

function parseDeliveryJson(value: string | null): AutomationTaskDeliveryPolicy {
  try { return normalizeDeliveryPolicy(value ? JSON.parse(value) : undefined); }
  catch { throw new AutomationTaskError("AUTOMATION_DATA_CORRUPT", "delivery"); }
}

function assetRecordFromRow(row: DbAssetRow): AutomationTaskAssetRecord {
  return {
    userId: row.userId,
    projectId: row.projectId,
    instanceId: row.instanceId,
    assetId: row.assetId,
    taskId: row.taskId,
    revisionId: row.revisionId,
    assetRole: parseAssetRole(row.assetRole),
    fileName: row.fileName,
    relativePath: row.relativePath,
    mimeType: row.mimeType,
    extension: parseExtension(row.extension),
    sizeBytes: row.sizeBytes,
    checksum: row.checksum,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function runRecordFromRow(row: DbRunRow): AutomationTaskRunRecord {
  let inputVersions: Array<{ assetId: string; versionId: string; fileName?: string }> = [];
  if (row.inputVersionsJson) {
    try {
      const parsed = JSON.parse(row.inputVersionsJson);
      if (Array.isArray(parsed)) inputVersions = parsed
        .filter((item) => item && typeof item.assetId === "string" && typeof item.versionId === "string")
        .map((item) => ({
          assetId: item.assetId,
          versionId: item.versionId,
          ...(typeof item.fileName === "string" ? { fileName: item.fileName } : {}),
        }));
    } catch {
      throw new AutomationTaskError("AUTOMATION_DATA_CORRUPT", "input_versions_json");
    }
  }
  return {
    userId: row.userId,
    projectId: row.projectId,
    instanceId: row.instanceId,
    runId: row.runId,
    taskId: row.taskId,
    revisionId: row.revisionId,
    origin: parseRunOrigin(row.origin),
    idempotencyKey: row.idempotencyKey,
    attempt: Number.isInteger(row.attempt) && row.attempt > 0 ? row.attempt : 1,
    revision: Number.isInteger(row.revisionNumber) && row.revisionNumber > 0 ? row.revisionNumber : 1,
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt,
    scheduledFor: row.scheduledFor,
    executionDeadlineAt: row.executionDeadlineAt,
    status: parseRunStatus(row.status),
    claimedAt: row.claimedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    inputAssetId: row.inputAssetId,
    inputVersions,
    outputAssetId: row.outputAssetId,
    outputVersionId: row.outputVersionId,
    outputChecksum: row.outputChecksum,
    deliveryStatus: row.deliveryStatus as AutomationTaskRunRecord["deliveryStatus"],
    pushJobId: row.pushJobId,
    resultSummary: row.resultSummary,
    errorMessage: row.errorMessage,
    errorCategory: parseErrorCategory(row.errorCategory),
    retryable: row.retryable === null || row.retryable === undefined ? null : Boolean(row.retryable),
    traceId: row.traceId,
    conversationId: row.conversationId,
    ...(row.taskName ? { taskName: row.taskName } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function auditRecordFromRow(row: DbAuditRow): AutomationTaskAuditRecord {
  return {
    userId: row.userId,
    projectId: row.projectId,
    instanceId: row.instanceId,
    auditId: row.auditId,
    taskId: row.taskId,
    revisionId: row.revisionId,
    runId: row.runId,
    assetId: row.assetId,
    action: row.action,
    status: row.status,
    details: parseJsonObject(row.detailsJson),
    createdAt: row.createdAt,
  };
}

function readTaskRow(taskId: string): DbTaskRow | undefined {
  return sqlite.prepare(`SELECT ${TASK_SELECT} FROM automation_tasks WHERE task_id = ?`).get(taskId) as DbTaskRow | undefined;
}

function requireTaskRow(taskId: string, scope: AutomationScope): DbTaskRow {
  const row = readTaskRow(taskId);
  if (!row) throw new AutomationTaskError("AUTOMATION_TASK_NOT_FOUND", taskId);
  assertRowScope(row, scope);
  return row;
}

function requireRevisionForTask(task: DbTaskRow, scope: AutomationScope): DbRevisionRow {
  const row = sqlite.prepare(`
    SELECT ${REVISION_SELECT}
    FROM automation_task_revisions
    WHERE task_id = ? AND revision = ? AND user_id = ? AND project_id = ? AND instance_id = ?
  `).get(task.taskId, task.currentRevision, scope.userId, scope.projectId, scope.instanceId) as DbRevisionRow | undefined;
  if (!row) throw new AutomationTaskError("AUTOMATION_REVISION_NOT_FOUND", `${task.taskId}:${task.currentRevision}`);
  return row;
}

function findRevisionForTask(task: DbTaskRow, scope: AutomationScope): DbRevisionRow {
  const row = task.currentRevisionId
    ? sqlite.prepare(`
        SELECT ${REVISION_SELECT}
        FROM automation_task_revisions
        WHERE revision_id = ? AND task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
      `).get(task.currentRevisionId, task.taskId, scope.userId, scope.projectId, scope.instanceId) as DbRevisionRow | undefined
    : undefined;
  return row ?? requireRevisionForTask(task, scope);
}

function requireRevisionById(revisionId: string, scope: AutomationScope, taskId?: string): DbRevisionRow {
  const id = normalizeOpaqueId(revisionId, "revisionId");
  const row = sqlite.prepare(`
    SELECT ${REVISION_SELECT}
    FROM automation_task_revisions
    WHERE revision_id = ?
  `).get(id) as DbRevisionRow | undefined;
  if (!row) throw new AutomationTaskError("AUTOMATION_REVISION_NOT_FOUND", id);
  assertRowScope(row, scope);
  if (taskId && row.taskId !== taskId) throw new AutomationTaskError("AUTOMATION_REVISION_NOT_FOUND", id);
  return row;
}

function requireRunRow(runId: string, scope: AutomationScope): DbRunRow {
  const row = sqlite.prepare(`SELECT ${RUN_SELECT} FROM automation_task_runs WHERE run_id = ?`).get(runId) as DbRunRow | undefined;
  if (!row) throw new AutomationTaskError("AUTOMATION_RUN_NOT_FOUND", runId);
  assertRowScope(row, scope);
  return row;
}

function requireAssetRow(assetId: string, scope: AutomationScope): DbAssetRow {
  const id = normalizeOpaqueId(assetId, "assetId");
  const row = sqlite.prepare(`SELECT ${ASSET_SELECT} FROM automation_task_assets WHERE asset_id = ?`).get(id) as DbAssetRow | undefined;
  if (!row) throw new AutomationTaskError("AUTOMATION_ASSET_NOT_FOUND", id);
  assertRowScope(row, scope);
  return row;
}

function findAssetById(assetId: string, scope: AutomationScope): DbAssetRow | null {
  const row = sqlite.prepare(`SELECT ${ASSET_SELECT} FROM automation_task_assets WHERE asset_id = ?`).get(assetId) as DbAssetRow | undefined;
  if (!row) return null;
  assertRowScope(row, scope);
  return row;
}

async function readAutomationTaskAssetWithAction(input: AutomationTaskAssetLookup, action: "asset.read" | "asset.download"): Promise<AutomationTaskAssetPayload> {
  const scope = assertAutomationScope(input);
  const row = requireAssetRow(input.assetId, scope);
  const descriptor = assetRecordFromRow(row);
  const expectedRelativePath = automationAssetRelativePath(row.taskId, descriptor.assetRole, row.fileName);
  if (row.relativePath !== expectedRelativePath) throw new AutomationTaskError("AUTOMATION_ASSET_UNSAFE", row.assetId);

  const workspacePath = workspacePathForScope(scope);
  const realWorkspacePath = await realpath(workspacePath).catch(() => {
    throw new AutomationTaskError("AUTOMATION_WORKSPACE_NOT_FOUND", scope.userId);
  });
  const targetPath = path.resolve(workspacePath, row.relativePath);
  const rawTarget = await lstat(targetPath).catch(() => null);
  if (!rawTarget || !rawTarget.isFile() || rawTarget.isSymbolicLink()) {
    throw new AutomationTaskError("AUTOMATION_ASSET_NOT_FOUND", row.relativePath);
  }
  const realTargetPath = await realpath(targetPath).catch(() => {
    throw new AutomationTaskError("AUTOMATION_ASSET_NOT_FOUND", row.relativePath);
  });
  if (!isWithin(realWorkspacePath, realTargetPath)) throw new AutomationTaskError("AUTOMATION_ASSET_UNSAFE", row.relativePath);
  const fileStat = await lstat(realTargetPath);
  if (!fileStat.isFile() || fileStat.size > MAX_ASSET_BYTES) {
    throw new AutomationTaskError(fileStat.size > MAX_ASSET_BYTES ? "AUTOMATION_ASSET_TOO_LARGE" : "AUTOMATION_ASSET_NOT_FOUND", row.assetId);
  }
  const bytes = await readFile(realTargetPath);
  if (bytes.length !== row.sizeBytes) throw new AutomationTaskError("AUTOMATION_ASSET_CHECKSUM_MISMATCH", row.assetId);
  const checksum = sha256Hex(bytes);
  if (checksum !== row.checksum) throw new AutomationTaskError("AUTOMATION_ASSET_CHECKSUM_MISMATCH", row.assetId);

  insertAuditRow({
    taskId: row.taskId,
    revisionId: row.revisionId,
    assetId: row.assetId,
    scope,
    action,
    status: "success",
    details: { assetRole: row.assetRole, relativePath: row.relativePath, sizeBytes: bytes.length },
    createdAt: nowIso(),
  });
  return {
    descriptor,
    fileName: descriptor.fileName,
    mimeType: descriptor.mimeType,
    sizeBytes: bytes.length,
    checksum,
    bytes,
    base64: bytes.toString("base64"),
  };
}

type WrittenAsset = { relativePath: string; absolutePath: string };

async function writeNewAssetFile(input: {
  scope: AutomationScope;
  taskId: string;
  assetRole: AutomationTaskAssetRole;
  asset: NormalizedAssetInput;
  createdPaths: string[];
}): Promise<WrittenAsset> {
  const directories = await ensureSafeAssetDirectories(input.scope, input.taskId, input.assetRole);
  const targetPath = path.join(directories.rolePath, input.asset.fileName);
  const existing = await lstat(targetPath).catch(() => null);
  if (existing) {
    throw new AutomationTaskError(
      input.assetRole === "source" ? "AUTOMATION_ASSET_SOURCE_IMMUTABLE" : "AUTOMATION_ASSET_EXISTS",
      input.asset.fileName,
    );
  }
  try {
    await writeFile(targetPath, input.asset.bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new AutomationTaskError(
        input.assetRole === "source" ? "AUTOMATION_ASSET_SOURCE_IMMUTABLE" : "AUTOMATION_ASSET_EXISTS",
        input.asset.fileName,
      );
    }
    throw error;
  }
  input.createdPaths.push(targetPath);
  await assertRegularAssetPath(directories.rootPath, targetPath);
  return { relativePath: automationAssetRelativePath(input.taskId, input.assetRole, input.asset.fileName), absolutePath: targetPath };
}

async function replaceWorkingAssetFile(input: {
  scope: AutomationScope;
  taskId: string;
  assetRole: "working";
  asset: NormalizedAssetInput;
}): Promise<WrittenAsset> {
  const directories = await ensureSafeAssetDirectories(input.scope, input.taskId, input.assetRole);
  const targetPath = path.join(directories.rolePath, input.asset.fileName);
  const existing = await lstat(targetPath).catch(() => null);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new AutomationTaskError("AUTOMATION_ASSET_UNSAFE", input.asset.fileName);
  const temporaryPath = path.join(directories.rolePath, `.automation-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, input.asset.bytes, { flag: "wx", mode: 0o600 });
    await assertRegularAssetPath(directories.rootPath, temporaryPath);
    await rename(temporaryPath, targetPath);
    await assertRegularAssetPath(directories.rootPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return { relativePath: automationAssetRelativePath(input.taskId, input.assetRole, input.asset.fileName), absolutePath: targetPath };
}

async function ensureSafeAssetDirectories(scope: AutomationScope, taskId: string, assetRole: AutomationTaskAssetRole): Promise<{ rootPath: string; rolePath: string }> {
  const workspacePath = workspacePathForScope(scope);
  const rootPath = await realpath(workspacePath).catch(() => {
    throw new AutomationTaskError("AUTOMATION_WORKSPACE_NOT_FOUND", scope.userId);
  });
  let current = rootPath;
  for (const segment of ["automations", taskId, assetRole]) {
    current = path.join(current, segment);
    let item = await lstat(current).catch(() => null);
    if (!item) {
      try {
        await mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      item = await lstat(current).catch(() => null);
    }
    if (!item || !item.isDirectory() || item.isSymbolicLink()) throw new AutomationTaskError("AUTOMATION_ASSET_UNSAFE", segment);
    const realCurrent = await realpath(current).catch(() => {
      throw new AutomationTaskError("AUTOMATION_ASSET_UNSAFE", segment);
    });
    if (!isWithin(rootPath, realCurrent)) throw new AutomationTaskError("AUTOMATION_ASSET_UNSAFE", segment);
    current = realCurrent;
  }
  return { rootPath, rolePath: current };
}

async function assertRegularAssetPath(rootPath: string, targetPath: string): Promise<void> {
  const raw = await lstat(targetPath).catch(() => null);
  if (!raw || raw.isSymbolicLink() || !raw.isFile()) throw new AutomationTaskError("AUTOMATION_ASSET_UNSAFE", "asset");
  const realTarget = await realpath(targetPath).catch(() => {
    throw new AutomationTaskError("AUTOMATION_ASSET_UNSAFE", "asset");
  });
  if (!isWithin(rootPath, realTarget)) throw new AutomationTaskError("AUTOMATION_ASSET_UNSAFE", "asset");
}

async function versionedAssetFileName(scope: AutomationScope, taskId: string, fileName: string, revision: number): Promise<string> {
  const extension = path.posix.extname(fileName).toLowerCase();
  const stem = fileName.slice(0, -extension.length);
  let candidate = `${stem}-r${revision}${extension}`;
  let suffix = 0;
  while (true) {
    const relativePath = automationAssetRelativePath(taskId, "source", candidate);
    const row = sqlite.prepare(`
      SELECT asset_id FROM automation_task_assets
      WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ? AND asset_role = 'source' AND relative_path = ?
    `).get(taskId, scope.userId, scope.projectId, scope.instanceId, relativePath);
    const filePath = path.join(workspacePathForScope(scope), relativePath);
    const existing = await lstat(filePath).catch(() => null);
    if (!row && !existing) return candidate;
    suffix += 1;
    candidate = `${stem}-r${revision}-${suffix}${extension}`;
  }
}

function insertAssetRow(input: {
  assetId: string;
  taskId: string;
  revisionId?: string | null;
  scope: AutomationScope;
  assetRole: AutomationTaskAssetRole;
  fileName: string;
  relativePath: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
  updatedAt: string;
}): void {
  sqlite.prepare(`
    INSERT INTO automation_task_assets (
      asset_id, task_id, revision_id, user_id, project_id, instance_id, asset_role,
      file_name, relative_path, mime_type, extension, size_bytes, checksum, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.assetId,
    input.taskId,
    input.revisionId ?? null,
    input.scope.userId,
    input.scope.projectId,
    input.scope.instanceId,
    input.assetRole,
    input.fileName,
    input.relativePath,
    input.mimeType,
    input.extension,
    input.sizeBytes,
    input.checksum,
    input.createdAt,
    input.updatedAt,
  );
}

function insertAuditRow(input: {
  taskId: string;
  revisionId?: string | null;
  runId?: string | null;
  assetId?: string | null;
  scope: AutomationScope;
  action: string;
  status: string;
  details?: Record<string, unknown>;
  createdAt: string;
}): void {
  sqlite.prepare(`
    INSERT INTO automation_task_audit_logs (
      audit_id, task_id, revision_id, run_id, asset_id, user_id, project_id, instance_id,
      action, status, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `ataudit_${randomUUID()}`,
    input.taskId,
    input.revisionId ?? null,
    input.runId ?? null,
    input.assetId ?? null,
    input.scope.userId,
    input.scope.projectId,
    input.scope.instanceId,
    input.action,
    input.status,
    JSON.stringify(sanitizeDetails(input.details)),
    input.createdAt,
  );
}

function normalizeAssetInput(input: AutomationTaskAssetInput): NormalizedAssetInput {
  if (!input || typeof input.fileName !== "string") throw new AutomationTaskError("AUTOMATION_ASSET_INVALID_PATH", "fileName");
  const fileName = normalizeAssetFileName(input.fileName);
  const extension = path.posix.extname(fileName).toLowerCase() as ".csv" | ".xlsx";
  if (extension !== ".csv" && extension !== ".xlsx") {
    throw new AutomationTaskError("AUTOMATION_ASSET_UNSUPPORTED_TYPE", fileName);
  }
  const bytes = Buffer.from(input.bytes ?? new Uint8Array());
  if (bytes.length > MAX_ASSET_BYTES) {
    throw new AutomationTaskError("AUTOMATION_ASSET_TOO_LARGE", String(bytes.length), { limitBytes: MAX_ASSET_BYTES });
  }
  const declaredMime = normalizeMime(input.mimeType);
  const mimeType = extension === ".csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (declaredMime && declaredMime !== "application/octet-stream" && !compatibleMime(extension, declaredMime)) {
    throw new AutomationTaskError("AUTOMATION_ASSET_MIME_MISMATCH", `${extension}:${declaredMime}`);
  }
  return { fileName, mimeType, extension, bytes, checksum: sha256Hex(bytes) };
}

async function assertStructuredAsset(asset: NormalizedAssetInput): Promise<void> {
  try {
    await validateAutomationSpreadsheet({ extension: asset.extension, bytes: asset.bytes });
  } catch (error) {
    const message = error instanceof AutomationSpreadsheetValidationError
      ? error.message
      : "自动化表格格式校验失败";
    throw new AutomationTaskError("AUTOMATION_ASSET_INVALID_CONTENT", message, { extension: asset.extension });
  }
}

function normalizeAssetFileName(value: string): string {
  const trimmed = value.trim();
  if (
    !trimmed
    || trimmed.length > 255
    || trimmed.includes("\u0000")
    || path.posix.isAbsolute(trimmed)
    || path.win32.isAbsolute(trimmed)
    || /[\\/]/.test(trimmed)
    || trimmed === "."
    || trimmed === ".."
  ) {
    throw new AutomationTaskError("AUTOMATION_ASSET_INVALID_PATH", value || "empty");
  }
  return trimmed;
}

function normalizeAssetFileNameForOutput(value: string): string {
  try { return normalizeAssetFileName(value); }
  catch { throw new AutomationTaskError("AUTOMATION_INVALID_OUTPUT_POLICY", "invalid output fileName"); }
}

function isAssetFormat(value: string): value is AssetFormat {
  return ["markdown", "html", "csv", "xlsx", "pdf", "png", "jpeg", "webp", "svg"].includes(value);
}

function automationAssetRelativePath(taskId: string, assetRole: AutomationTaskAssetRole, fileName: string): string {
  const safeTaskId = normalizeTaskId(taskId);
  const safeFileName = normalizeAssetFileName(fileName);
  if (assetRole !== "source" && assetRole !== "working") throw new AutomationTaskError("AUTOMATION_ASSET_INVALID_PATH", assetRole);
  return path.posix.join("automations", safeTaskId, assetRole, safeFileName);
}

function compatibleMime(extension: ".csv" | ".xlsx", mimeType: string): boolean {
  if (extension === ".csv") return new Set(["text/csv", "text/plain", "application/csv"]).has(mimeType);
  return mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

function normalizeMime(value?: string): string {
  return String(value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function normalizeAutomationSchedule(input: AutomationSchedule | Record<string, unknown>): AutomationSchedule {
  let value: unknown = input;
  if (typeof input === "string") {
    try { value = JSON.parse(input); } catch { throw new AutomationTaskError("AUTOMATION_INVALID_SCHEDULE", "invalid JSON"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AutomationTaskError("AUTOMATION_INVALID_SCHEDULE", "object required");
  const raw = value as Record<string, unknown>;
  const frequency = String(raw.frequency ?? raw.cadence ?? raw.kind ?? "").trim() as AutomationSchedule["frequency"];
  const time = String(raw.time ?? raw.timeOfDay ?? raw.at ?? "").trim();
  const timezoneValue = raw.timezone ?? raw.tz;
  const timezone = String(timezoneValue === undefined ? DEFAULT_AUTOMATION_TIMEZONE : timezoneValue).trim();
  if (!["daily", "trading_days", "weekdays", "weekly", "monthly"].includes(frequency)) throw new AutomationTaskError("AUTOMATION_INVALID_SCHEDULE", "unsupported frequency");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new AutomationTaskError("AUTOMATION_INVALID_SCHEDULE", "time must be HH:mm");
  if (!timezone) throw new AutomationTaskError("AUTOMATION_INVALID_SCHEDULE", "timezone required");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); } catch { throw new AutomationTaskError("AUTOMATION_INVALID_SCHEDULE", `invalid timezone ${timezone}`); }
  const weekdaysValue = raw.weekdays ?? raw.daysOfWeek;
  let weekdays: number[] | undefined;
  if (weekdaysValue !== undefined) {
    if (!Array.isArray(weekdaysValue) || weekdaysValue.length === 0 || weekdaysValue.some((day) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6)) {
      throw new AutomationTaskError("AUTOMATION_INVALID_SCHEDULE", "weekdays must contain integers 0..6");
    }
    weekdays = [...new Set(weekdaysValue as number[])].sort((a, b) => a - b);
  }
  if (frequency === "weekly" && (!weekdays || weekdays.length === 0)) throw new AutomationTaskError("AUTOMATION_INVALID_SCHEDULE", "weekly weekdays required");
  const monthlyDayValue = raw.monthlyDay ?? raw.dayOfMonth;
  let monthlyDay: number | undefined;
  if (monthlyDayValue !== undefined) {
    if (!Number.isInteger(Number(monthlyDayValue)) || Number(monthlyDayValue) < 1 || Number(monthlyDayValue) > 28) {
      throw new AutomationTaskError("AUTOMATION_INVALID_SCHEDULE", "monthlyDay must be an integer 1..28");
    }
    monthlyDay = Number(monthlyDayValue);
  }
  if (frequency === "monthly" && monthlyDay === undefined) throw new AutomationTaskError("AUTOMATION_INVALID_SCHEDULE", "monthly monthlyDay required");
  const windowsValue = raw.windows ?? raw.intradayWindows;
  let windows: string[] | undefined;
  if (windowsValue !== undefined) {
    if (!Array.isArray(windowsValue) || windowsValue.length === 0 || windowsValue.some((window) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(window)))) {
      throw new AutomationTaskError("AUTOMATION_INVALID_SCHEDULE", "windows must be non-empty HH:mm strings");
    }
    windows = [...new Set(windowsValue.map(String))].sort();
  }
  return { ...raw, frequency, time, timezone, ...(weekdays ? { weekdays } : {}), ...(monthlyDay !== undefined ? { monthlyDay } : {}), ...(windows ? { windows } : {}) };
}

function parseScheduleJson(value: string): AutomationSchedule {
  try { return normalizeAutomationSchedule(JSON.parse(value) as Record<string, unknown>); } catch (error) {
    if (error instanceof AutomationTaskError) throw new AutomationTaskError("AUTOMATION_DATA_CORRUPT", value);
    throw new AutomationTaskError("AUTOMATION_DATA_CORRUPT", "schedule");
  }
}

function normalizeTaskName(value: string): string {
  const name = String(value ?? "").trim();
  if (!name || name.length > MAX_TASK_NAME_LENGTH) throw new AutomationTaskError("AUTOMATION_INVALID_NAME", name || "empty");
  return name;
}

function normalizeDescription(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const description = String(value).trim();
  if (description.length > MAX_DESCRIPTION_LENGTH) throw new AutomationTaskError("AUTOMATION_INVALID_DESCRIPTION", "description too long");
  return description || null;
}

function normalizeTaskId(value: string): string {
  const taskId = normalizeOpaqueId(value, "taskId");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw new AutomationTaskError("AUTOMATION_INVALID_TASK_ID", taskId);
  return taskId;
}

function normalizeOpaqueId(value: string, label: string): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > 300 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new AutomationTaskError("AUTOMATION_INVALID_SCOPE", label);
  }
  return result;
}

function normalizeScopePart(value: string, label: string): string {
  return normalizeOpaqueId(value, label);
}

function normalizeIdempotencyKey(value: string): string {
  const key = String(value ?? "").trim();
  if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) throw new AutomationTaskError("AUTOMATION_RUN_IDEMPOTENCY_CONFLICT", key || "empty");
  return key;
}

const AUTOMATION_ERROR_CATEGORIES: AutomationErrorCategory[] = [
  "transient", "timeout", "dependency_unavailable", "invalid_input", "validation_failed",
  "scope_or_permission", "expired", "cancelled", "unknown",
];

function normalizeExecutionDeadline(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new AutomationTaskError("AUTOMATION_INVALID_DEADLINE", "executionDeadlineAt");
  return new Date(parsed).toISOString();
}

function parseErrorCategory(value: string | null | undefined): AutomationErrorCategory | null {
  if (value === null || value === undefined || value === "") return null;
  if (AUTOMATION_ERROR_CATEGORIES.includes(value as AutomationErrorCategory)) return value as AutomationErrorCategory;
  throw new AutomationTaskError("AUTOMATION_DATA_CORRUPT", value);
}

function normalizeErrorCategory(value: AutomationErrorCategory | null | undefined, status: AutomationTaskRunStatus): AutomationErrorCategory | null {
  if (status === "succeeded") return null;
  if (value !== null && value !== undefined) {
    if (!AUTOMATION_ERROR_CATEGORIES.includes(value)) throw new AutomationTaskError("AUTOMATION_RUN_STATUS_INVALID", String(value));
    return value;
  }
  if (status === "failed") return "unknown";
  if (status === "cancelled") return "cancelled";
  return null;
}

function defaultRetryable(category: AutomationErrorCategory | null, status: AutomationTaskRunStatus): boolean | null {
  if (status === "succeeded") return null;
  if (category === "expired" || category === "cancelled" || category === "invalid_input" || category === "validation_failed" || category === "scope_or_permission" || category === "dependency_unavailable") return false;
  if (status === "failed") return true;
  return null;
}

export function workspacePathForScope(scope: AutomationScope): string {
  try {
    if (ACTIVE_BACKEND === "mastra") {
      const registered = mastraWorkspaceRegistry.registeredPath(scope);
      if (!registered) throw new Error("Mastra project is not registered");
      return registered;
    }
    return resolveWorkspacePath(scope.userId);
  } catch (error) {
    throw new AutomationTaskError("AUTOMATION_INVALID_SCOPE", (error as Error).message);
  }
}

function assertRowScope(row: { userId: string; projectId: string; instanceId: string }, scope: AutomationScope): void {
  if (row.userId !== scope.userId || row.projectId !== scope.projectId || row.instanceId !== scope.instanceId) {
    throw new AutomationTaskError("AUTOMATION_SCOPE_MISMATCH", "resource");
  }
}

function parseTaskStatus(value: string): AutomationTaskStatus {
  if (["paused", "active", "needs_attention", "archived"].includes(value)) return value as AutomationTaskStatus;
  throw new AutomationTaskError("AUTOMATION_DATA_CORRUPT", value);
}

function parseRunOrigin(value: string): AutomationTaskRunOrigin {
  if (value === "manual" || value === "scheduled") return value;
  throw new AutomationTaskError("AUTOMATION_DATA_CORRUPT", value);
}

function parseRunStatus(value: string): AutomationTaskRunStatus {
  if (["running", "succeeded", "failed", "skipped", "cancelled"].includes(value)) return value as AutomationTaskRunStatus;
  throw new AutomationTaskError("AUTOMATION_DATA_CORRUPT", value);
}

function parseAssetRole(value: string): AutomationTaskAssetRole {
  if (value === "source" || value === "working") return value;
  throw new AutomationTaskError("AUTOMATION_DATA_CORRUPT", value);
}

function parseExtension(value: string): ".csv" | ".xlsx" {
  if (value === ".csv" || value === ".xlsx") return value;
  throw new AutomationTaskError("AUTOMATION_DATA_CORRUPT", value);
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function sanitizeDetails(input?: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (/absolute|fullpath|base64|bytes/i.test(key)) continue;
    if (typeof value === "string") result[key] = value.slice(0, 500);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) result[key] = value;
    else if (Array.isArray(value)) result[key] = value.slice(0, 20);
  }
  return result;
}

function clipNullable(value: string | null | undefined, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const clipped = String(value).trim().slice(0, maxLength);
  return clipped || null;
}

function nowIso(): string { return new Date().toISOString(); }

function sha256Hex(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function isWithin(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function cleanupCreatedFiles(paths: string[]): Promise<void> {
  for (const targetPath of paths.reverse()) await rm(targetPath, { force: true }).catch(() => undefined);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
