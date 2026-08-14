import { ACTIVE_BACKEND } from "../lib/data-backend.js";
import { resolveWorkspacePath } from "../lib/workspace.js";
import { mastraWorkspaceRegistry } from "../mastra/workspace-registry.js";

export class ProjectStorageRootError extends Error {
  constructor(readonly code: "PROJECT_STORAGE_SCOPE_REQUIRED" | "PROJECT_STORAGE_SCOPE_UNAVAILABLE", message: string) {
    super(`${code}:${message}`);
    this.name = "ProjectStorageRootError";
  }
}

export async function resolveProjectStorageRoot(input: {
  userId: string;
  projectId?: string;
  instanceId?: string;
}): Promise<string> {
  if (ACTIVE_BACKEND !== "mastra") return resolveWorkspacePath(input.userId);
  const projectId = input.projectId?.trim();
  const instanceId = input.instanceId?.trim();
  if (!projectId || !instanceId) throw new ProjectStorageRootError("PROJECT_STORAGE_SCOPE_REQUIRED", "complete project scope is required");
  const project = await mastraWorkspaceRegistry.resolve({ userId: input.userId, projectId, instanceId });
  if (!project) throw new ProjectStorageRootError("PROJECT_STORAGE_SCOPE_UNAVAILABLE", "Mastra project is not registered");
  return project.realProjectRoot;
}
