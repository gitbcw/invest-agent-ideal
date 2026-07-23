import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

export const WORKSPACE_COMPATIBILITY_VERSION = 2;
export const WORKSPACE_MIGRATION_CONFIRMATION = "apply-managed-workspace-assets-v1";
export const WORKSPACE_TEMPLATE_ADOPTION_CONFIRMATION = "adopt-template-assets-v1";

/**
 * Hard runtime contracts belong in the service/MCP layer. Workspace files are
 * not trusted enforcement points, so no Skill is automatically replaceable.
 * Keep this list for future non-customizable runtime metadata only.
 */
export const WORKSPACE_MANAGED_ASSETS = [] as const;

/**
 * These files are seeded into new Workspaces and may evolve there. A version
 * difference is an available update, not a migration requirement.
 */
export const WORKSPACE_OPTIONAL_TEMPLATE_ASSETS = [
  ".codex/skills/service-capability-policy/SKILL.md",
  ".codex/skills/conversation-recovery/SKILL.md",
  ".codex/skills/capability-extension/SKILL.md",
  ".codex/skills/capability-extension/agents/openai.yaml",
  ".codex/skills/core-company-fundamental-review/SKILL.md",
  ".codex/skills/core-company-fundamental-review/agents/openai.yaml",
  ".codex/skills/investment-onboarding/SKILL.md",
  ".codex/skills/market-watch/SKILL.md",
  ".codex/skills/daily-portfolio-review/SKILL.md",
  ".codex/skills/daily-portfolio-review/agents/openai.yaml",
  ".codex/skills/monthly-portfolio-review/SKILL.md",
  ".codex/skills/monthly-portfolio-review/agents/openai.yaml",
  ".codex/skills/observation-pool/SKILL.md",
  ".codex/skills/weekly-portfolio-review/SKILL.md",
  ".codex/skills/weekly-portfolio-review/agents/openai.yaml",
  "knowledge/capability_extension_protocol.md",
] as const;

const REQUIRED_USER_CONFIGS = [
  "config/tenant.yaml",
  "config/portfolio.yaml",
  "config/strategy.yaml",
  "config/watch.yaml",
  "config/schedules.yaml",
  "config/notification.yaml",
] as const;

const LEGACY_AGENT_MARKERS = [
  "invest-agent-service-tools",
  "onboarding.draft.get",
  "reviews.save",
] as const;

export type WorkspaceCompatibilityStatus = "ready" | "migration_required" | "blocked";
export type ManagedAssetAction = "add" | "replace";

export interface ManagedAssetChange {
  relativePath: string;
  action: ManagedAssetAction;
  currentSha256: string | null;
  targetSha256: string;
}

export interface WorkspaceCompatibilityReport {
  workspaceId: string;
  workspacePath: string;
  compatibilityVersion: number;
  status: WorkspaceCompatibilityStatus;
  managedAssetChanges: ManagedAssetChange[];
  availableTemplateUpdates: ManagedAssetChange[];
  blockers: string[];
  warnings: string[];
}

export interface InspectWorkspaceInput {
  workspacePath: string;
  templatePath: string;
}

export interface MigrateWorkspaceInput extends InspectWorkspaceInput {
  backupRoot: string;
  confirmation: string;
  runId?: string;
}

export interface WorkspaceMigrationResult {
  workspaceId: string;
  workspacePath: string;
  compatibilityVersion: number;
  changed: boolean;
  backupPath: string | null;
  changes: ManagedAssetChange[];
}

export interface AdoptWorkspaceTemplateAssetsInput extends InspectWorkspaceInput {
  backupRoot: string;
  confirmation: string;
  relativePaths: string[];
  runId?: string;
}

export async function discoverWorkspacePaths(workspaceRoot: string): Promise<string[]> {
  if (!existsSync(workspaceRoot)) return [];
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(workspaceRoot, entry.name))
    .filter((workspacePath) => existsSync(path.join(workspacePath, "AGENTS.md")))
    .sort((a, b) => a.localeCompare(b));
}

export async function inspectWorkspaceCompatibility(
  input: InspectWorkspaceInput,
): Promise<WorkspaceCompatibilityReport> {
  const workspacePath = path.resolve(input.workspacePath);
  const templatePath = path.resolve(input.templatePath);
  const workspaceId = path.basename(workspacePath);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const managedAssetChanges: ManagedAssetChange[] = [];
  const availableTemplateUpdates: ManagedAssetChange[] = [];

  const agentsPath = path.join(workspacePath, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    blockers.push("missing AGENTS.md");
  } else {
    const agents = await readFile(agentsPath, "utf8");
    const missingMarkers = LEGACY_AGENT_MARKERS.filter((marker) => !agents.includes(marker));
    if (missingMarkers.length > 0) {
      warnings.push(`legacy AGENTS.md contract markers missing: ${missingMarkers.join(", ")}`);
    }
  }

  for (const relativePath of REQUIRED_USER_CONFIGS) {
    const filePath = path.join(workspacePath, relativePath);
    if (!existsSync(filePath)) {
      blockers.push(`missing required user config: ${relativePath}`);
      continue;
    }
    try {
      parse(await readFile(filePath, "utf8"));
    } catch {
      blockers.push(`invalid YAML in required user config: ${relativePath}`);
    }
  }

  for (const relativePath of WORKSPACE_MANAGED_ASSETS) {
    const sourcePath = path.join(templatePath, relativePath);
    const targetPath = path.join(workspacePath, relativePath);
    if (!existsSync(sourcePath)) {
      blockers.push(`managed template asset missing: ${relativePath}`);
      continue;
    }
    const targetSha256 = await sha256File(sourcePath);
    if (!existsSync(targetPath)) {
      managedAssetChanges.push({ relativePath, action: "add", currentSha256: null, targetSha256 });
      continue;
    }
    const currentSha256 = await sha256File(targetPath);
    if (currentSha256 !== targetSha256) {
      managedAssetChanges.push({ relativePath, action: "replace", currentSha256, targetSha256 });
    }
  }

  for (const relativePath of WORKSPACE_OPTIONAL_TEMPLATE_ASSETS) {
    const sourcePath = path.join(templatePath, relativePath);
    const targetPath = path.join(workspacePath, relativePath);
    if (!existsSync(sourcePath)) {
      warnings.push(`optional template asset unavailable: ${relativePath}`);
      continue;
    }
    const targetSha256 = await sha256File(sourcePath);
    if (!existsSync(targetPath)) {
      availableTemplateUpdates.push({ relativePath, action: "add", currentSha256: null, targetSha256 });
      continue;
    }
    const currentSha256 = await sha256File(targetPath);
    if (currentSha256 !== targetSha256) {
      availableTemplateUpdates.push({ relativePath, action: "replace", currentSha256, targetSha256 });
    }
  }

  const status: WorkspaceCompatibilityStatus = blockers.length > 0
    ? "blocked"
    : managedAssetChanges.length > 0
      ? "migration_required"
      : "ready";

  return {
    workspaceId,
    workspacePath,
    compatibilityVersion: WORKSPACE_COMPATIBILITY_VERSION,
    status,
    managedAssetChanges,
    availableTemplateUpdates,
    blockers,
    warnings,
  };
}

export async function adoptWorkspaceTemplateAssets(
  input: AdoptWorkspaceTemplateAssetsInput,
): Promise<WorkspaceMigrationResult> {
  if (input.confirmation !== WORKSPACE_TEMPLATE_ADOPTION_CONFIRMATION) {
    throw new Error(`workspace template adoption confirmation must equal ${WORKSPACE_TEMPLATE_ADOPTION_CONFIRMATION}`);
  }
  if (input.relativePaths.length === 0) {
    throw new Error("workspace template adoption requires at least one explicit asset");
  }

  const allowedAssets = new Set<string>(WORKSPACE_OPTIONAL_TEMPLATE_ASSETS);
  const relativePaths = [...new Set(input.relativePaths)];
  const unsupported = relativePaths.filter((relativePath) => !allowedAssets.has(relativePath));
  if (unsupported.length > 0) {
    throw new Error(`workspace template adoption contains unsupported assets: ${unsupported.join(", ")}`);
  }

  const workspacePath = path.resolve(input.workspacePath);
  const templatePath = path.resolve(input.templatePath);
  const backupRoot = validateBackupRoot(input.backupRoot, workspacePath);
  const report = await inspectWorkspaceCompatibility({ workspacePath, templatePath });
  if (report.status === "blocked") {
    throw new Error(`workspace compatibility blocked: ${report.blockers.join("; ")}`);
  }
  const selectedChanges = report.availableTemplateUpdates.filter((change) => relativePaths.includes(change.relativePath));
  if (selectedChanges.length === 0) {
    return {
      workspaceId: report.workspaceId,
      workspacePath,
      compatibilityVersion: WORKSPACE_COMPATIBILITY_VERSION,
      changed: false,
      backupPath: null,
      changes: [],
    };
  }

  return applyAssetChanges({
    workspacePath,
    templatePath,
    backupRoot,
    runId: validateRunId(input.runId || timestampId()),
    workspaceId: report.workspaceId,
    changes: selectedChanges,
    recordName: "workspace-template-adoption.json",
  });
}

export async function migrateWorkspaceCompatibility(
  input: MigrateWorkspaceInput,
): Promise<WorkspaceMigrationResult> {
  if (input.confirmation !== WORKSPACE_MIGRATION_CONFIRMATION) {
    throw new Error(`workspace migration confirmation must equal ${WORKSPACE_MIGRATION_CONFIRMATION}`);
  }

  const workspacePath = path.resolve(input.workspacePath);
  const templatePath = path.resolve(input.templatePath);
  const backupRoot = validateBackupRoot(input.backupRoot, workspacePath);

  const report = await inspectWorkspaceCompatibility({ workspacePath, templatePath });
  if (report.status === "blocked") {
    throw new Error(`workspace compatibility blocked: ${report.blockers.join("; ")}`);
  }
  if (report.managedAssetChanges.length === 0) {
    return {
      workspaceId: report.workspaceId,
      workspacePath,
      compatibilityVersion: WORKSPACE_COMPATIBILITY_VERSION,
      changed: false,
      backupPath: null,
      changes: [],
    };
  }

  return applyAssetChanges({
    workspacePath,
    templatePath,
    backupRoot,
    runId: validateRunId(input.runId || timestampId()),
    workspaceId: report.workspaceId,
    changes: report.managedAssetChanges,
    recordName: "workspace-compatibility.json",
  });
}

async function applyAssetChanges(input: {
  workspacePath: string;
  templatePath: string;
  backupRoot: string;
  runId: string;
  workspaceId: string;
  changes: ManagedAssetChange[];
  recordName: string;
}): Promise<WorkspaceMigrationResult> {
  const backupPath = path.join(input.backupRoot, input.runId, input.workspaceId);
  await mkdir(backupPath, { recursive: true });

  for (const change of input.changes) {
    const targetPath = path.join(input.workspacePath, change.relativePath);
    if (change.action === "replace") {
      const backupFile = path.join(backupPath, change.relativePath);
      await mkdir(path.dirname(backupFile), { recursive: true });
      await copyFile(targetPath, backupFile);
    }
  }

  const statePath = path.join(input.workspacePath, ".invest-agent", input.recordName);
  if (existsSync(statePath)) {
    await copyFile(statePath, path.join(backupPath, `previous-${input.recordName}`));
  }

  const migrationRecord = {
    compatibilityVersion: WORKSPACE_COMPATIBILITY_VERSION,
    workspaceId: input.workspaceId,
    appliedAt: new Date().toISOString(),
    backupPath,
    changes: input.changes,
  };
  const manifestPath = path.join(backupPath, "manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...migrationRecord, status: "in_progress" }, null, 2)}\n`,
    "utf8",
  );

  for (const change of input.changes) {
    await atomicCopy(
      path.join(input.templatePath, change.relativePath),
      path.join(input.workspacePath, change.relativePath),
    );
  }

  await mkdir(path.dirname(statePath), { recursive: true });
  await atomicWriteJson(statePath, migrationRecord);
  await atomicWriteJson(manifestPath, { ...migrationRecord, status: "completed" });

  return {
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    compatibilityVersion: WORKSPACE_COMPATIBILITY_VERSION,
    changed: true,
    backupPath,
    changes: input.changes,
  };
}

function validateBackupRoot(backupRootInput: string, workspacePath: string): string {
  if (!path.isAbsolute(backupRootInput)) {
    throw new Error("workspace migration backup root must be absolute");
  }
  const backupRoot = path.resolve(backupRootInput);
  if (isSameOrChildPath(backupRoot, workspacePath)) {
    throw new Error("workspace migration backup root must be outside the workspace");
  }
  return backupRoot;
}

function validateRunId(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId.includes("..")) {
    throw new Error("workspace migration runId must be a safe path segment");
  }
  return runId;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function atomicCopy(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.compat-${process.pid}-${Date.now()}`;
  await copyFile(sourcePath, temporaryPath);
  await rename(temporaryPath, targetPath);
}

async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.compat-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, targetPath);
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function timestampId(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
