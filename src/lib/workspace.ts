import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { config } from "./config.js";
import { logger } from "./logger.js";

const TENANT_FILE = "config/tenant.yaml";

export interface WorkspaceIdentity {
  tenantId?: string;
  userId: string;
  projectId?: string;
}

export interface EnsureWorkspaceResult {
  path: string;
  created: boolean;
}

export function resolveWorkspacePath(userId: string): string {
  const safe = sanitizeUserId(userId);
  return path.join(config.workspace.root, safe);
}

/**
 * 只读检查 workspace 是否已就绪(AGENTS.md 存在)。
 * 不创建目录、不复制模板、不写任何文件。
 * 用于 GET 类摘要端点,避免读路径触发 ensureWorkspace 副作用。
 */
export function workspaceExists(userId: string): boolean {
  const targetPath = resolveWorkspacePath(userId);
  return existsSync(path.join(targetPath, "AGENTS.md"));
}

function legacyWorkspacePath(userId: string): string {
  return path.join(process.cwd(), "workspaces", sanitizeUserId(userId));
}

export function workspaceTemplatePath(): string {
  return config.workspace.templatePath;
}

export async function ensureWorkspace(identity: WorkspaceIdentity): Promise<EnsureWorkspaceResult> {
  const targetPath = resolveWorkspacePath(identity.userId);
  await migrateLegacyWorkspaceIfNeeded(identity.userId, targetPath);
  if (existsSync(path.join(targetPath, "AGENTS.md"))) {
    await ensureManagedRuntimeAssets(targetPath);
    await stampTenantIdentity(targetPath, identity).catch((error) => {
      logger.warn(`workspace.stampTenantIdentity failed (existing) path=${targetPath}: ${error}`);
    });
    return { path: targetPath, created: false };
  }

  if (!existsSync(workspaceTemplatePath())) {
    throw new Error(`WORKSPACE_TEMPLATE_NOT_FOUND:${workspaceTemplatePath()}`);
  }

  await mkdir(config.workspace.root, { recursive: true });
  await cp(workspaceTemplatePath(), targetPath, { recursive: true });
  await ensureManagedRuntimeAssets(targetPath);
  await stampTenantIdentity(targetPath, identity).catch((error) => {
    logger.warn(`workspace.stampTenantIdentity failed (fresh) path=${targetPath}: ${error}`);
  });
  logger.info(`workspace.created userId=${identity.userId} path=${targetPath}`);
  return { path: targetPath, created: true };
}

async function ensureManagedRuntimeAssets(workspacePath: string) {
  const managedAssets = [
    { relativePath: path.join(".codex", "skills", "conversation-recovery", "SKILL.md"), overwrite: false },
    { relativePath: path.join(".codex", "skills", "service-capability-policy", "SKILL.md"), overwrite: true },
    { relativePath: path.join(".codex", "skills", "capability-extension", "SKILL.md"), overwrite: true },
    { relativePath: path.join("knowledge", "capability_extension_protocol.md"), overwrite: true },
  ];
  for (const asset of managedAssets) {
    const sourcePath = path.join(workspaceTemplatePath(), asset.relativePath);
    const targetPath = path.join(workspacePath, asset.relativePath);
    if (!existsSync(sourcePath) || (!asset.overwrite && existsSync(targetPath))) continue;
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
  }
}

async function migrateLegacyWorkspaceIfNeeded(userId: string, targetPath: string) {
  const legacyPath = legacyWorkspacePath(userId);
  if (path.resolve(legacyPath) === path.resolve(targetPath)) return;
  if (existsSync(path.join(targetPath, "AGENTS.md"))) return;
  if (!existsSync(path.join(legacyPath, "AGENTS.md"))) return;

  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await rename(legacyPath, targetPath);
  } catch {
    await cp(legacyPath, targetPath, { recursive: true });
    await rm(legacyPath, { recursive: true, force: true });
  }
  logger.info(`workspace.migrated userId=${userId} from=${legacyPath} to=${targetPath}`);
}

async function stampTenantIdentity(workspacePath: string, identity: WorkspaceIdentity) {
  const tenantPath = path.join(workspacePath, TENANT_FILE);
  if (!existsSync(tenantPath)) return;
  const raw = await readFile(tenantPath, "utf-8");
  const doc = parse(raw) ?? {};
  if (!doc.workspace || typeof doc.workspace !== "object") {
    doc.workspace = {};
  }
  doc.workspace.tenant_id = identity.tenantId ?? null;
  doc.workspace.user_id = identity.userId;
  doc.workspace.project_id = identity.projectId ?? null;
  doc.workspace.workspace_root = ".";
  await writeFile(tenantPath, stringify(doc), "utf-8");
}

function sanitizeUserId(userId: string): string {
  const trimmed = userId.trim();
  if (!trimmed) throw new Error("INVALID_USER_ID_EMPTY");
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    throw new Error(`INVALID_USER_ID_CHARS:${trimmed}`);
  }
  return trimmed;
}
