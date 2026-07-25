const lockTails = new Map<string, Promise<void>>();

export function artifactPathLockKey(userId: string, relativePath: string): string {
  return `${userId}\0${relativePath}`;
}

/** Serializes artifact reads and deletes for one workspace path. */
export async function withArtifactPathLock<T>(
  userId: string,
  relativePath: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = artifactPathLockKey(userId, relativePath);
  const previous = lockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  lockTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (lockTails.get(key) === tail) lockTails.delete(key);
  }
}
