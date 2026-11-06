/**
 * A TTL memo that a revision counter invalidates.
 *
 * Shared by `GET /api/branding` and the email service's `portal_name`, so
 * both see a branding save on the same terms: at once on the instance that
 * committed it, within the TTL everywhere else.
 */

/** A memoised value and the moment it was assembled. */
export interface RevisionMemoResult<T> {
  value: T;
  /** Epoch milliseconds at which the underlying reads started. */
  checkedAt: number;
}

/**
 * Memoise `run` for `ttlMs`, coalescing concurrent callers onto one call.
 *
 * Same shape as the health-route cache: a TTL bounds sustained traffic and a
 * shared in-flight promise bounds simultaneous bursts. `ttlMs <= 0` removes the
 * memo entirely rather than shrinking it to nothing. Committed service writes
 * change the revision immediately, including for callers awaiting an assembly.
 */
export function memoizeByRevision<T>(
  ttlMs: number,
  getRevision: () => number,
  run: () => Promise<T>,
): () => Promise<RevisionMemoResult<T>> {
  if (ttlMs <= 0) {
    return async () => {
      const checkedAt = Date.now();
      return { value: await run(), checkedAt };
    };
  }

  let cached: (RevisionMemoResult<T> & { expiresAt: number; revision: number }) | null = null;
  let pending: { revision: number; promise: Promise<RevisionMemoResult<T>> } | null = null;

  return async function load(): Promise<RevisionMemoResult<T>> {
    const revision = getRevision();
    if (cached && cached.revision === revision && cached.expiresAt > Date.now()) {
      return { value: cached.value, checkedAt: cached.checkedAt };
    }
    if (!pending || pending.revision !== revision) {
      const promise: Promise<RevisionMemoResult<T>> = (async () => {
        const checkedAt = Date.now();
        const value = await run();
        // A write during assembly must not repopulate the cache with old data.
        if (getRevision() === revision) {
          cached = { value, checkedAt, expiresAt: Date.now() + ttlMs, revision };
        }
        return { value, checkedAt };
      })().finally(() => {
        if (pending?.promise === promise) pending = null;
      });
      pending = { revision, promise };
    }
    const result = await pending.promise;
    return getRevision() === revision ? result : load();
  };
}
