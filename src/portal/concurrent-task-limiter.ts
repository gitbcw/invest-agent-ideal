/** Bounds concurrent Portal chat turns for one assistant connector. */
export class ConcurrentTaskLimiter {
  private active = 0;

  constructor(readonly limit: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.limit) return false;
    this.active += 1;
    return true;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
  }

  get activeCount(): number {
    return this.active;
  }
}

export function portalConcurrentTaskLimit(value = process.env.PORTAL_MAX_CONCURRENT_TASKS_PER_ASSISTANT): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return 3;
  return Math.min(parsed, 10);
}
