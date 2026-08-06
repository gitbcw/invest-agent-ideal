import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  getAutomationTask,
  readAutomationTaskAsset,
  recordAutomationTaskAudit,
  updateAutomationTask,
  AutomationTaskError,
  type AutomationScope,
  type AutomationTaskRecord,
} from "./automation-tasks.js";
import { archiveUserAsset, createUserAsset, type UserAssetDescriptor } from "./user-assets.js";
import { resolveWorkspacePath } from "../lib/workspace.js";

export interface LegacyAutomationMigrationResult {
  status: "migrated";
  task: AutomationTaskRecord;
  sourceAsset: UserAssetDescriptor;
  workingAsset: UserAssetDescriptor;
  backupRelativePath: string;
}

export async function migrateLegacyAutomationTaskToAssets(input: AutomationScope & { taskId: string }): Promise<LegacyAutomationMigrationResult> {
  const task = await getAutomationTask(input);
  if (!task) throw new AutomationTaskError("AUTOMATION_TASK_NOT_FOUND", input.taskId);
  if (!task.sourceAsset || !task.workingAsset) throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", "task is already generic or missing legacy assets");
  if (task.sourceAsset.extension !== ".csv" && task.sourceAsset.extension !== ".xlsx") throw new AutomationTaskError("AUTOMATION_ASSET_BINDING_INVALID", "only CSV/XLSX legacy tasks can migrate");

  const source = await readAutomationTaskAsset({ ...input, assetId: task.sourceAsset.assetId });
  const working = await readAutomationTaskAsset({ ...input, assetId: task.workingAsset.assetId });
  const backupRelativePath = await backupLegacyAssets(input, task, source.bytes, working.bytes);
  let sourceAsset: UserAssetDescriptor | null = null;
  let workingAsset: UserAssetDescriptor | null = null;
  try {
    sourceAsset = await createUserAsset({
      ...input,
      name: `${task.revision.name} source`,
      fileName: source.fileName,
      mimeType: source.mimeType,
      bytes: source.bytes,
      source: "system",
      taskId: task.taskId,
    });
    workingAsset = await createUserAsset({
      ...input,
      name: `${task.revision.name} working`,
      fileName: working.fileName,
      mimeType: working.mimeType,
      bytes: working.bytes,
      source: "system",
      taskId: task.taskId,
    });
    const migrated = await updateAutomationTask({
      ...input,
      taskId: task.taskId,
      expectedRevision: task.currentRevision,
      instruction: `按原任务要求维护工作产物：${task.revision.description || task.revision.name}`,
      inputs: [{ assetId: sourceAsset.assetId, role: "input", versionPolicy: "fixed", versionId: sourceAsset.currentVersionId! }],
      output: { mode: "update", assetId: workingAsset.assetId, versionPolicy: "latest" },
      delivery: { mode: "none" },
    });
    recordAutomationTaskAudit({
      taskId: task.taskId,
      revisionId: migrated.currentRevisionId,
      scope: input,
      action: "task.migration",
      status: "success",
      details: { fromRevision: task.currentRevision, toRevision: migrated.currentRevision, backupRelativePath, sourceAssetId: sourceAsset.assetId, workingAssetId: workingAsset.assetId },
    });
    return { status: "migrated", task: migrated, sourceAsset, workingAsset, backupRelativePath };
  } catch (error) {
    if (sourceAsset) await archiveUserAsset({ ...input, assetId: sourceAsset.assetId }).catch(() => undefined);
    if (workingAsset) await archiveUserAsset({ ...input, assetId: workingAsset.assetId }).catch(() => undefined);
    recordAutomationTaskAudit({
      taskId: task.taskId,
      revisionId: task.currentRevisionId,
      scope: input,
      action: "task.migration",
      status: "failed",
      details: { fromRevision: task.currentRevision, backupRelativePath, error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) },
    });
    throw error;
  }
}

async function backupLegacyAssets(scope: AutomationScope & { taskId: string }, task: AutomationTaskRecord, source: Buffer, working: Buffer): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(scope.taskId)) throw new AutomationTaskError("AUTOMATION_INVALID_TASK_ID", scope.taskId);
  const workspace = resolveWorkspacePath(scope.userId);
  const root = await realpath(workspace).catch(() => null);
  if (!root) throw new AutomationTaskError("AUTOMATION_WORKSPACE_NOT_FOUND", scope.userId);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const relative = path.posix.join(".automation-migration-backups", scope.taskId, stamp);
  const directory = path.resolve(root, relative);
  if (!isWithin(root, directory)) throw new AutomationTaskError("AUTOMATION_ASSET_UNSAFE", relative);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, `source-${safeBackupName(task.sourceAsset!.fileName)}`), source, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(directory, `working-${safeBackupName(task.workingAsset!.fileName)}`), working, { flag: "wx", mode: 0o600 });
  return relative;
}

function safeBackupName(value: string): string {
  const name = path.posix.basename(value);
  if (!name || name === "." || name === ".." || /[\\/\u0000]/.test(name)) throw new AutomationTaskError("AUTOMATION_ASSET_UNSAFE", value);
  return name;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
