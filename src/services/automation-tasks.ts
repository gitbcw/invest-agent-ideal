import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { sqlite } from "../db/index.js";
import { ensureWorkspace, resolveWorkspacePath } from "../lib/workspace.js";
import { AutomationSpreadsheetValidationError, validateAutomationSpreadsheet } from "./automation-spreadsheet.js";

const DEFAULT_ASSET_MAX_BYTES = 25 * 1024 * 1024;
const MAX_ASSET_BYTES = positiveInteger(process.env.AUTOMATION_TASK_ASSET_MAX_BYTES, DEFAULT_ASSET_MAX_BYTES);
const MAX_TASK_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 12_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 500;
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
export type AutomationTaskAssetRole = "source" | "working";

export interface AutomationScope {
  userId: string;
  instanceId: string;
  projectId: string;
}

export interface AutomationSchedule {
  frequency: "daily" | "weekdays" | "weekly";
  time: string;
  timezone: string;
  weekdays?: number[];
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
  schedule: AutomationSchedule;
  sourceAssetId?: string | null;
  workingAssetId?: string | null;
  createdAt: string;
}

export interface AutomationTaskRecord extends AutomationScope {
  taskId: string;
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

export interface AutomationTaskRunRecord extends AutomationScope {
  runId: string;
  taskId: string;
  revisionId: string;
  origin: AutomationTaskRunOrigin;
  idempotencyKey: string;
  /** Monotonic attempt number for recovery of an expired lease. */
  attempt: number;
  /** Opaque ownership token used to fence an old ACP process after recovery. */
  leaseToken?: string | null;
  leaseExpiresAt?: string | null;
  scheduledFor?: string | null;
  status: AutomationTaskRunStatus;
  claimedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  inputAssetId?: string | null;
  outputAssetId?: string | null;
  outputChecksum?: string | null;
  resultSummary?: string | null;
  errorMessage?: string | null;
  traceId?: string | null;
  conversationId?: string | null;
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
  schedule: AutomationSchedule | Record<string, unknown>;
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
  /** A new source is stored as a new immutable source file; it never replaces an old one. */
  sourceAsset?: AutomationTaskAssetInput;
  asset?: AutomationTaskAssetInput;
}

export interface AutomationTaskLookup extends AutomationScope {
  taskId: string;
}

export interface AutomationTaskRunListInput extends AutomationScope {
  taskId: string;
  limit?: number;
}

export interface AutomationTaskRunLookup extends AutomationScope {
  runId: string;
}

export interface ClaimAutomationTaskRunInput extends AutomationScope {
  taskId: string;
  revisionId?: string;
  origin?: AutomationTaskRunOrigin;
  idempotencyKey: string;
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
  outputAssetId?: string | null;
  outputChecksum?: string | null;
  traceId?: string | null;
}

export interface AutomationTaskRunLeaseInput extends AutomationScope {
  runId: string;
  leaseToken?: string | null;
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
      | "AUTOMATION_TASK_BUSY"
      | "AUTOMATION_TASK_NOT_ACTIVE"
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
  scheduleJson: string;
  sourceAssetId: string | null;
  workingAssetId: string | null;
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
  scheduledFor: string | null;
  status: string;
  claimedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  inputAssetId: string | null;
  outputAssetId: string | null;
  outputChecksum: string | null;
  resultSummary: string | null;
  errorMessage: string | null;
  traceId: string | null;
  conversationId: string | null;
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
  schedule_json AS scheduleJson,
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
  run_id AS runId,
  task_id AS taskId,
  revision_id AS revisionId,
  user_id AS userId,
  project_id AS projectId,
  instance_id AS instanceId,
  origin,
  idempotency_key AS physicalIdempotencyKey,
  idempotency_base_key AS idempotencyBaseKey,
  COALESCE(idempotency_base_key, idempotency_key) AS idempotencyKey,
  attempt,
  scheduled_for AS scheduledFor,
  status,
  claimed_at AS claimedAt,
  started_at AS startedAt,
  finished_at AS finishedAt,
  input_asset_id AS inputAssetId,
  output_asset_id AS outputAssetId,
  output_checksum AS outputChecksum,
  result_summary AS resultSummary,
  error_message AS errorMessage,
  trace_id AS traceId,
  conversation_id AS conversationId,
  lease_token AS leaseToken,
  lease_expires_at AS leaseExpiresAt,
  created_at AS createdAt,
  updated_at AS updatedAt
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
  await ensureWorkspace({ userId: scope.userId, tenantId: scope.userId, projectId: scope.projectId });
  const name = normalizeTaskName(input.name);
  const description = normalizeDescription(input.description);
  const schedule = normalizeAutomationSchedule(input.schedule);
  const sourceInput = input.sourceAsset ?? input.asset;
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
          task_id, user_id, project_id, instance_id, status,
          current_revision, current_revision_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'paused', 1, ?, ?, ?)
      `).run(taskId, scope.userId, scope.projectId, scope.instanceId, revisionId, now, now);
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
  if (input.expectedRevision !== undefined && input.expectedRevision !== task.currentRevision) {
    throw new AutomationTaskError("AUTOMATION_REVISION_CONFLICT", String(input.expectedRevision));
  }
  const currentRevision = revisionRecordFromRow(requireRevisionForTask(task, scope));
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

export async function activateAutomationTask(input: AutomationTaskLookup & { expectedRevision?: number }): Promise<AutomationTaskRecord> {
  return setAutomationTaskStatus(input, "active");
}

export async function pauseAutomationTask(input: AutomationTaskLookup & { expectedRevision?: number }): Promise<AutomationTaskRecord> {
  return setAutomationTaskStatus(input, "paused");
}

/** Readable aliases for Portal adapters that use enable/disable wording. */
export const enableAutomationTask = activateAutomationTask;
export const disableAutomationTask = pauseAutomationTask;

export async function listAutomationTasks(input: AutomationScope): Promise<AutomationTaskRecord[]> {
  const scope = assertAutomationScope(input);
  const rows = sqlite.prepare(`
    SELECT ${TASK_SELECT}
    FROM automation_tasks
    WHERE user_id = ? AND project_id = ? AND instance_id = ?
    ORDER BY updated_at DESC, task_id ASC
  `).all(scope.userId, scope.projectId, scope.instanceId) as DbTaskRow[];
  return rows.map((row) => taskRecordFromRow(row, scope));
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
  assertAutomationTaskRunLeaseSync(row, scope, input.leaseToken, Date.parse(nowIso()));
  return runRecordFromRow(row);
}

export async function claimAutomationTaskRun(input: ClaimAutomationTaskRunInput): Promise<ClaimAutomationTaskRunResult> {
  const scope = assertAutomationScope(input);
  const taskId = normalizeTaskId(input.taskId);
  const task = requireTaskRow(taskId, scope);
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
        status, claimed_at, started_at, input_asset_id, conversation_id,
        lease_token, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)
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
        error_message = COALESCE(error_message, ?), lease_token = NULL,
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

export async function finishAutomationTaskRun(input: FinishAutomationTaskRunInput): Promise<AutomationTaskRunRecord> {
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
    const output = requireAssetRow(input.outputAssetId, scope);
    if (output.taskId !== existing.taskId) throw new AutomationTaskError("AUTOMATION_SCOPE_MISMATCH", input.outputAssetId);
  }
  const now = nowIso();
  const resultSummary = clipNullable(input.resultSummary, 4_000);
  const errorMessage = clipNullable(input.errorMessage, 1_200);
  const traceId = clipNullable(input.traceId, 300);
  const outputChecksum = clipNullable(input.outputChecksum, 128);
  const task = requireTaskRow(existing.taskId, scope);
  const revision = requireRevisionById(existing.revisionId, scope, existing.taskId);
  const leaseToken = input.leaseToken ?? existing.leaseToken;
  const transaction = sqlite.transaction(() => {
    const updated = sqlite.prepare(`
      UPDATE automation_task_runs
      SET status = ?, finished_at = ?, output_asset_id = ?, output_checksum = ?,
          result_summary = ?, error_message = ?, trace_id = ?, lease_expires_at = NULL, updated_at = ?
      WHERE run_id = ? AND user_id = ? AND project_id = ? AND instance_id = ? AND status = 'running'
        AND EXISTS (
          SELECT 1 FROM automation_tasks t
          WHERE t.task_id = ? AND t.user_id = ? AND t.project_id = ? AND t.instance_id = ?
            AND t.active_run_id = ?
            AND t.active_run_lease_expires_at > ?
            AND (? IS NULL OR t.active_run_lease_token = ?)
        )
    `).run(
      input.status,
      now,
      input.outputAssetId ?? null,
      outputChecksum,
      resultSummary,
      errorMessage,
      traceId,
      now,
      runId,
      scope.userId,
      scope.projectId,
      scope.instanceId,
      existing.taskId,
      scope.userId,
      scope.projectId,
      scope.instanceId,
      runId,
      now,
      leaseToken,
      leaseToken,
    );
    if (updated.changes === 0) throw new AutomationTaskError("AUTOMATION_RUN_LEASE_LOST", runId);
    sqlite.prepare(`
      UPDATE automation_tasks
      SET active_run_id = NULL, active_run_lease_token = NULL,
          active_run_lease_expires_at = NULL, updated_at = ?
      WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
        AND active_run_id = ?
        AND (? IS NULL OR active_run_lease_token = ?)
    `).run(
      now,
      existing.taskId,
      scope.userId,
      scope.projectId,
      scope.instanceId,
      runId,
      leaseToken,
      leaseToken,
    );
    insertAuditRow({
      taskId: existing.taskId,
      revisionId: existing.revisionId,
      runId,
      scope,
      action: "run.finished",
      status: "success",
      details: { runStatus: input.status, hasOutputAsset: Boolean(input.outputAssetId), attempt: existing.attempt },
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
  });
  transaction();
  return runRecordFromRow(requireRunRow(runId, scope));
}

export async function listAutomationTaskRuns(input: AutomationTaskRunListInput): Promise<AutomationTaskRunRecord[]> {
  const scope = assertAutomationScope(input);
  const taskId = normalizeTaskId(input.taskId);
  requireTaskRow(taskId, scope);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200);
  const rows = sqlite.prepare(`
    SELECT ${RUN_SELECT}
    FROM automation_task_runs
    WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
    ORDER BY created_at DESC, run_id DESC
    LIMIT ?
  `).all(taskId, scope.userId, scope.projectId, scope.instanceId, limit) as DbRunRow[];
  return rows.map(runRecordFromRow);
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

/** Return the next wall-clock occurrence in the task's declared timezone. */
export function nextAutomationRunAt(schedule: AutomationSchedule | Record<string, unknown>, from = new Date()): string {
  const normalized = normalizeAutomationSchedule(schedule);
  const start = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  for (let index = 0; index <= 8 * 24 * 60; index += 1) {
    const candidate = new Date(start + index * 60_000);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: normalized.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(candidate);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(values.weekday));
    const [hour, minute] = normalized.time.split(":").map(Number);
    if (Number(values.hour) !== hour || Number(values.minute) !== minute) continue;
    if (normalized.frequency === "weekdays" && (weekday < 1 || weekday > 5)) continue;
    if (normalized.frequency === "weekly" && !normalized.weekdays?.includes(weekday)) continue;
    return candidate.toISOString();
  }
  throw new AutomationTaskError("AUTOMATION_INVALID_SCHEDULE", "no occurrence in the next 8 days");
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

async function setAutomationTaskStatus(input: AutomationTaskLookup & { expectedRevision?: number }, status: AutomationTaskStatus): Promise<AutomationTaskRecord> {
  const scope = assertAutomationScope(input);
  const taskId = normalizeTaskId(input.taskId);
  const task = requireTaskRow(taskId, scope);
  if (input.expectedRevision !== undefined && input.expectedRevision !== task.currentRevision) {
    throw new AutomationTaskError("AUTOMATION_REVISION_CONFLICT", String(input.expectedRevision));
  }
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
      action: status === "active" ? "task.activated" : "task.paused",
      status: "success",
      details: { revision: task.currentRevision, status, nextRunAt },
      createdAt: now,
    });
  });
  transaction();
  return requireAutomationTask({ ...scope, taskId });
}

function taskRecordFromRow(row: DbTaskRow, scope: AutomationScope): AutomationTaskRecord {
  const revision = findRevisionForTask(row, scope);
  const sourceAsset = revision.sourceAssetId ? findAssetById(revision.sourceAssetId, scope) : null;
  const workingAsset = revision.workingAssetId ? findAssetById(revision.workingAssetId, scope) : null;
  return {
    ...scope,
    taskId: row.taskId,
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
  return {
    userId: row.userId,
    projectId: row.projectId,
    instanceId: row.instanceId,
    revisionId: row.revisionId,
    taskId: row.taskId,
    revision: row.revision,
    name: row.name,
    description: row.description,
    schedule: parseScheduleJson(row.scheduleJson),
    sourceAssetId: row.sourceAssetId,
    workingAssetId: row.workingAssetId,
    createdAt: row.createdAt,
  };
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
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt,
    scheduledFor: row.scheduledFor,
    status: parseRunStatus(row.status),
    claimedAt: row.claimedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    inputAssetId: row.inputAssetId,
    outputAssetId: row.outputAssetId,
    outputChecksum: row.outputChecksum,
    resultSummary: row.resultSummary,
    errorMessage: row.errorMessage,
    traceId: row.traceId,
    conversationId: row.conversationId,
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
  const timezone = String(raw.timezone ?? raw.tz ?? "").trim();
  if (!["daily", "weekdays", "weekly"].includes(frequency)) throw new AutomationTaskError("AUTOMATION_INVALID_SCHEDULE", "unsupported frequency");
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
  return { ...raw, frequency, time, timezone, ...(weekdays ? { weekdays } : {}) };
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

function workspacePathForScope(scope: AutomationScope): string {
  try { return resolveWorkspacePath(scope.userId); } catch (error) {
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
