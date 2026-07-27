import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { config } from "../lib/config.js";

export interface ResourceMutationScope {
  userId: string;
  instanceId: string;
}

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  resourceKey: string;
  instanceId: string;
}

interface ResourceMutationLockOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  lockRoot?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const INCOMPLETE_OWNER_GRACE_MS = 5_000;

export class ResourceMutationLockTimeoutError extends Error {
  constructor(resourceKey: string, timeoutMs: number) {
    super(`RESOURCE_MUTATION_LOCK_TIMEOUT: ${resourceKey} remained busy for ${timeoutMs}ms`);
    this.name = "ResourceMutationLockTimeoutError";
  }
}

export function resourceMutationLockIdentity(scope: ResourceMutationScope, resourceKey: string): string {
  // Workspace domain files are physically user-scoped today. instanceId remains
  // metadata, but must not split the lock for two instances sharing one workspace.
  return `${scope.userId}\0${resourceKey.trim().toLowerCase()}`;
}

function lockDirectory(root: string, identity: string): string {
  const digest = createHash("sha256").update(identity).digest("hex");
  return join(root, digest);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readOwner(directory: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, "owner.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.token !== "string") return null;
    return parsed as LockOwner;
  } catch {
    return null;
  }
}

async function clearAbandonedLock(directory: string): Promise<boolean> {
  const owner = await readOwner(directory);
  if (owner) {
    if (owner.hostname !== hostname() || !Number.isInteger(owner.pid) || isProcessAlive(owner.pid)) return false;
    await rm(directory, { recursive: true, force: true });
    return true;
  }

  try {
    const info = await stat(directory);
    if (Date.now() - info.mtimeMs < INCOMPLETE_OWNER_GRACE_MS) return false;
    await rm(directory, { recursive: true, force: true });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function acquireResourceLock(
  scope: ResourceMutationScope,
  resourceKey: string,
  options: ResourceMutationLockOptions,
): Promise<() => Promise<void>> {
  const identity = resourceMutationLockIdentity(scope, resourceKey);
  const root = options.lockRoot ?? join(config.runtimeData.root, "resource-mutation-locks");
  const directory = lockDirectory(root, identity);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startedAt = Date.now();
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
    resourceKey,
    instanceId: scope.instanceId,
  };
  await mkdir(root, { recursive: true });

  while (true) {
    try {
      await mkdir(directory);
      try {
        await writeFile(join(directory, "owner.json"), JSON.stringify(owner), { encoding: "utf8", flag: "wx" });
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        const currentOwner = await readOwner(directory);
        if (currentOwner?.token === owner.token) {
          await rm(directory, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await clearAbandonedLock(directory)) continue;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new ResourceMutationLockTimeoutError(resourceKey, timeoutMs);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

/**
 * Serializes a complete mutation transaction across runtime and MCP processes.
 * Keys are sorted before acquisition so callers can safely request overlapping sets.
 */
export async function withResourceMutationLock<T>(
  scope: ResourceMutationScope,
  resourceKeys: string | string[],
  operation: () => Promise<T>,
  options: ResourceMutationLockOptions = {},
): Promise<T> {
  const keys = [...new Set((Array.isArray(resourceKeys) ? resourceKeys : [resourceKeys])
    .map((key) => key.trim().toLowerCase())
    .filter(Boolean))].sort();
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const key of keys) releases.push(await acquireResourceLock(scope, key, options));
    return await operation();
  } finally {
    for (const release of releases.reverse()) await release();
  }
}
