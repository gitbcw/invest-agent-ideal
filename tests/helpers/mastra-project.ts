import path from "node:path";

/**
 * E8 shared test fixture: the mastra registry is the only storage-root source,
 * so tests that touch artifacts/assets/automation storage must bootstrap the
 * project for their scope before the service resolves a root.
 *
 * Usage inside a test fixture (before importing the service modules):
 *   process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
 *   const projectRoot = await registerTestProject({ userId, projectId, instanceId });
 */
export async function registerTestProject(scope: { userId: string; projectId: string; instanceId: string }): Promise<string> {
  const { mastraWorkspaceRegistry } = await import("../../src/mastra/workspace-registry.js");
  const entry = await mastraWorkspaceRegistry.bootstrap(scope);
  if (!entry?.projectRoot) throw new Error(`test project bootstrap failed for ${scope.userId}`);
  return entry.projectRoot;
}

export function tempProjectsRoot(root: string): string {
  const projectsRoot = path.join(root, "projects");
  process.env.MASTRA_PROJECTS_ROOT = projectsRoot;
  return projectsRoot;
}
