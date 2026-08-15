import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { recordFileLifecycleEvent } from "../services/file-lifecycle-audit.js";
import type { MastraBindings, MastraWorkspaceLike } from "./bindings.js";

export interface MastraWorkspaceScope {
  userId: string;
  projectId: string;
  instanceId: string;
}

export interface RegisteredMastraProject extends MastraWorkspaceScope {
  projectRoot: string;
}

export interface MastraProjectManifest extends MastraWorkspaceScope {
  schemaVersion: 1;
  projectIdDigest: string;
  createdAt: string;
  migrationSource: "none";
}

export class MastraWorkspaceScopeError extends Error {
  constructor(readonly code: "MASTRA_WORKSPACE_SCOPE_INVALID" | "MASTRA_WORKSPACE_ROOT_INVALID", message: string) {
    super(`${code}: ${message}`);
    this.name = "MastraWorkspaceScopeError";
  }
}

type RegisteredProject = RegisteredMastraProject & { realProjectRoot: string; realProjectsRoot: string };

/**
 * Explicit, service-owned mapping from an authenticated scope to a project
 * directory. It intentionally does not call legacy ensureWorkspace helpers.
 */
export class MastraWorkspaceRegistry {
  private readonly entries = new Map<string, RegisteredProject>();

  constructor(private readonly projectsRoot: string) {}

  async register(input: RegisteredMastraProject): Promise<void> {
    const scope = normalizeScope(input);
    const projectsRoot = await resolveDirectory(this.projectsRoot, "projects root");
    const projectRoot = await resolveDirectory(input.projectRoot, "project root");
    if (!isWithin(projectsRoot, projectRoot)) {
      throw new MastraWorkspaceScopeError("MASTRA_WORKSPACE_ROOT_INVALID", "project root escapes the dedicated projects root");
    }
    this.entries.set(scopeKey(scope), { ...scope, projectRoot: input.projectRoot, realProjectRoot: projectRoot, realProjectsRoot: projectsRoot });
  }

  unregister(scope: MastraWorkspaceScope): void {
    this.entries.delete(scopeKey(normalizeScope(scope)));
  }

  /**
   * Create the minimal, non-legacy project skeleton below the dedicated root.
   * There is no source Workspace copy in this operation: importing user files
   * remains a later snapshot-only migration phase.
   */
  async bootstrap(scopeInput: MastraWorkspaceScope): Promise<RegisteredMastraProject> {
    const scope = normalizeScope(scopeInput);
    await mkdir(this.projectsRoot, { recursive: true, mode: 0o700 });
    const projectsRoot = await resolveDirectory(this.projectsRoot, "projects root");
    const projectRoot = path.join(projectsRoot, scopeDigest(scope));
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
    for (const directory of ["reports", "methods", "templates", "skills", "files", "tools", "data", ".agent-project"]) {
      await mkdir(path.join(projectRoot, directory), { recursive: true, mode: 0o700 });
    }
    const manifestPath = path.join(projectRoot, ".agent-project", "manifest.json");
    const manifest: MastraProjectManifest = {
      schemaVersion: 1,
      userId: scope.userId,
      projectId: scope.projectId,
      instanceId: scope.instanceId,
      projectIdDigest: scopeDigest(scope),
      createdAt: new Date().toISOString(),
      migrationSource: "none",
    };
    try {
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await seedSystemSkills(path.join(projectRoot, "skills"));
    const project = { ...scope, projectRoot };
    await this.register(project);
    recordFileLifecycleEvent({
      entityType: "workspace_project",
      entityId: `project_${scopeDigest(scope)}`,
      userId: scope.userId,
      instanceId: scope.instanceId,
      event: "workspace_project.bootstrapped",
      status: "success",
      summary: { projectId: scope.projectId, migrationSource: "none" },
    });
    return project;
  }

  async resolve(scope: MastraWorkspaceScope): Promise<RegisteredProject | undefined> {
    const normalized = normalizeScope(scope);
    let entry = this.entries.get(scopeKey(normalized));
    if (!entry) {
      entry = await this.hydrate(normalized);
      if (!entry) return undefined;
      this.entries.set(scopeKey(normalized), entry);
    }
    const projectRoot = await resolveDirectory(entry.projectRoot, "registered project root");
    const projectsRoot = await resolveDirectory(this.projectsRoot, "projects root");
    if (projectRoot !== entry.realProjectRoot || projectsRoot !== entry.realProjectsRoot || !isWithin(projectsRoot, projectRoot)) {
      throw new MastraWorkspaceScopeError("MASTRA_WORKSPACE_ROOT_INVALID", "registered project root changed or escaped its dedicated root");
    }
    return entry;
  }

  /**
   * Recover a project after process restart only from its deterministic
   * directory and a matching service-written manifest. This never scans user
   * directories or guesses a path from a user id.
   */
  private async hydrate(scope: MastraWorkspaceScope): Promise<RegisteredProject | undefined> {
    const projectsRoot = await resolveDirectory(this.projectsRoot, "projects root").catch(() => undefined);
    if (!projectsRoot) return undefined;
    const projectRoot = path.join(projectsRoot, scopeDigest(scope));
    const manifestPath = path.join(projectRoot, ".agent-project", "manifest.json");
    let manifest: MastraProjectManifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MastraProjectManifest;
    } catch {
      return undefined;
    }
    if (
      manifest.schemaVersion !== 1
      || manifest.userId !== scope.userId
      || manifest.projectId !== scope.projectId
      || manifest.instanceId !== scope.instanceId
      || manifest.projectIdDigest !== scopeDigest(scope)
    ) return undefined;
    const realProjectRoot = await resolveDirectory(projectRoot, "registered project root").catch(() => undefined);
    if (!realProjectRoot || !isWithin(projectsRoot, realProjectRoot)) return undefined;
    return { ...scope, projectRoot, realProjectRoot, realProjectsRoot: projectsRoot };
  }

  /** Fast path for callers whose API is synchronous; async resolve remains the
   * authoritative containment check at service boundaries. */
  registeredPath(scope: MastraWorkspaceScope): string | undefined {
    const entry = this.entries.get(scopeKey(normalizeScope(scope)));
    return entry?.realProjectRoot;
  }
}

/** Global registry starts empty. Production receives no Workspace until a service-owned bootstrap registers it. */
export const mastraWorkspaceRegistry = new MastraWorkspaceRegistry(
  path.resolve(process.env.MASTRA_PROJECTS_ROOT || path.join(process.cwd(), "data", "mastra-projects")),
);

export async function createRegisteredMastraWorkspace(input: {
  scope: MastraWorkspaceScope;
  registry?: MastraWorkspaceRegistry;
  bindings: MastraBindings;
}): Promise<MastraWorkspaceLike | undefined> {
  const scope = normalizeScope(input.scope);
  const entry = await (input.registry ?? mastraWorkspaceRegistry).resolve(scope);
  if (!entry) return undefined;
  if (!input.bindings.Workspace || !input.bindings.LocalFilesystem) {
    throw new Error("MASTRA_BINDINGS_INVALID: Workspace bindings are unavailable");
  }
  const workspace = new input.bindings.Workspace({
    id: `project-${scopeDigest(scope)}`,
    name: "Scoped user project",
    filesystem: new input.bindings.LocalFilesystem({
      basePath: entry.realProjectRoot,
      contained: true,
      allowedPaths: [],
    }),
    skills: ["skills"],
    tools: workspaceToolPolicy(scope),
  });
  return workspace;
}

/** Resolve a registered project root for service-owned temporary staging. */
export async function resolveRegisteredMastraProjectRoot(scope: MastraWorkspaceScope): Promise<string | undefined> {
  const entry = await mastraWorkspaceRegistry.resolve(scope);
  return entry?.realProjectRoot;
}

export function workspaceToolPolicy(scope: MastraWorkspaceScope): Record<string, unknown> {
  const audit = (event: string, status: "success" | "failure" | "pending", input: unknown, error?: unknown) => {
    recordFileLifecycleEvent({
      entityType: "workspace_project",
      entityId: `project_${scopeDigest(scope)}`,
      userId: scope.userId,
      instanceId: scope.instanceId,
      event,
      status,
      reason: error instanceof Error ? error.message : undefined,
      summary: { projectId: scope.projectId, path: relativePathFromToolInput(input) },
    });
  };
  return {
    enabled: false,
    hooks: {
      beforeToolCall: (context: { workspaceToolName: string; input: unknown }) => audit(context.workspaceToolName, "pending", context.input),
      afterToolCall: (context: { workspaceToolName: string; input: unknown; error?: unknown }) =>
        audit(context.workspaceToolName, context.error ? "failure" : "success", context.input, context.error),
    },
    mastra_workspace_read_file: { enabled: true },
    mastra_workspace_list_files: { enabled: true },
    mastra_workspace_grep: { enabled: true },
    mastra_workspace_search: { enabled: true },
    // Per docs/mastra-workspace-exit-mapping.md §8.1: ordinary writes are
    // audited (hooks below) + read-before-write; conversational confirmation
    // is the product-level gate for user assets. Tool-level approval has no
    // interactive surface in the runtime and would suspend writes forever
    // while the model still claims success. Destructive tools stay disabled.
    mastra_workspace_write_file: { enabled: true, requireApproval: false, requireReadBeforeWrite: true },
    mastra_workspace_edit_file: { enabled: true, requireApproval: false, requireReadBeforeWrite: true },
    mastra_workspace_mkdir: { enabled: true, requireApproval: false },
    mastra_workspace_delete: { enabled: false },
    mastra_workspace_ast_edit: { enabled: false },
    mastra_workspace_file_stat: { enabled: false },
    mastra_workspace_index: { enabled: false },
    mastra_workspace_execute_command: { enabled: false },
    mastra_workspace_get_process_output: { enabled: false },
    mastra_workspace_kill_process: { enabled: false },
    mastra_workspace_lsp_inspect: { enabled: false },
  };
}

export function systemSkillsTemplateRoot(): string {
  return path.resolve(process.env.SYSTEM_SKILLS_TEMPLATE_ROOT || path.join(process.cwd(), "templates", "skills"));
}

/**
 * Seed the initial methodology skills into a fresh project's skills/ directory.
 * Skills are user-evolvable assets from the moment they land: existing files
 * are never overwritten, and a missing template root is not an error (older
 * deployments may not carry templates/).
 */
export async function seedSystemSkills(targetSkillsDir: string): Promise<string[]> {
  const templateRoot = systemSkillsTemplateRoot();
  const entries = await readdir(templateRoot).catch(() => null);
  if (!entries) return [];
  const seeded: string[] = [];
  for (const entry of entries) {
    const sourceSkillDir = path.join(templateRoot, entry);
    if (!(await stat(sourceSkillDir).catch(() => null))?.isDirectory()) continue;
    const sourceFiles: string[] = [];
    for (const file of await readdir(sourceSkillDir)) {
      const sourceFile = path.join(sourceSkillDir, file);
      if ((await stat(sourceFile).catch(() => null))?.isFile()) sourceFiles.push(file);
    }
    if (sourceFiles.length === 0) continue;
    const targetSkillDir = path.join(targetSkillsDir, entry);
    await mkdir(targetSkillDir, { recursive: true, mode: 0o700 });
    for (const file of sourceFiles) {
      const sourceFile = path.join(sourceSkillDir, file);
      const targetFile = path.join(targetSkillDir, file);
      const existed = await lstat(targetFile).then(() => true, () => false);
      if (existed) continue;
      await copyFile(sourceFile, targetFile);
      seeded.push(path.posix.join("skills", entry, file));
    }
  }
  return seeded;
}

function normalizeScope(scope: MastraWorkspaceScope): MastraWorkspaceScope {
  const userId = normalizeId(scope.userId, "userId");
  const projectId = normalizeId(scope.projectId, "projectId");
  const instanceId = normalizeId(scope.instanceId, "instanceId");
  return { userId, projectId, instanceId };
}

function normalizeId(value: string, label: string): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 160 || /[\\/\0]/.test(normalized)) {
    throw new MastraWorkspaceScopeError("MASTRA_WORKSPACE_SCOPE_INVALID", `${label} is missing or invalid`);
  }
  return normalized;
}

async function resolveDirectory(value: string, label: string): Promise<string> {
  const entry = await lstat(value).catch(() => null);
  if (!entry?.isDirectory() || entry.isSymbolicLink()) {
    throw new MastraWorkspaceScopeError("MASTRA_WORKSPACE_ROOT_INVALID", `${label} must be a non-symlink directory`);
  }
  return realpath(value);
}

function scopeKey(scope: MastraWorkspaceScope): string {
  return `${scope.userId}\u0000${scope.projectId}\u0000${scope.instanceId}`;
}

function scopeDigest(scope: MastraWorkspaceScope): string {
  return createHash("sha256").update(scopeKey(scope)).digest("hex").slice(0, 24);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function relativePathFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>).path;
  if (typeof value !== "string" || path.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized.startsWith("../") || normalized === ".." ? null : normalized.slice(0, 300);
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
