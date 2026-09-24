/**
 * A small in-process LRU cache bounded by entry count **and** total size.
 *
 * An entry-count bound alone is not a memory bound when the values vary by
 * three orders of magnitude — a catalog spec can be a few hundred bytes or a
 * few megabytes — so every entry also carries a caller-supplied size, and the
 * least recently used entries are evicted until both bounds hold. A value
 * larger than the whole byte budget is simply not cached: admitting it would
 * evict everything else and then itself.
 *
 * `Map` iteration order is insertion order, so re-inserting on every hit keeps
 * the least recently used entry at the front. Every operation is synchronous,
 * which is what lets a caller check, compute and store without an `await` in
 * between — the property that makes a burst of identical misses cost one
 * computation rather than one per request.
 */

/** Bounds for {@link LruCache}. */
export interface LruCacheOptions {
  /** Most entries held at once. `0` disables the cache. */
  maxEntries: number;
  /** Largest total of entry sizes held at once. `0` disables the cache. */
  maxBytes: number;
}

/** Counters for tests and diagnostics. */
export interface LruCacheStats {
  hits: number;
  misses: number;
  entries: number;
  bytes: number;
}

interface Entry<V> {
  value: V;
  size: number;
}

/** A synchronous LRU cache bounded by entry count and total size. */
export class LruCache<V> {
  private readonly options: LruCacheOptions;
  private readonly entries = new Map<string, Entry<V>>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;

  constructor(options: LruCacheOptions) {
    this.options = options;
  }

  /** The cached value, refreshed as most recently used, or `undefined`. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Store `value` as most recently used, evicting until both bounds hold. */
  set(key: string, value: V, size: number): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.bytes -= existing.size;
    }
    if (
      this.options.maxEntries <= 0 ||
      this.options.maxBytes <= 0 ||
      size > this.options.maxBytes ||
      !Number.isFinite(size) ||
      size < 0
    ) {
      return;
    }
    this.entries.set(key, { value, size });
    this.bytes += size;
    while (this.entries.size > this.options.maxEntries || this.bytes > this.options.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (evicted) this.bytes -= evicted.size;
    }
  }

  /** Drop every entry; the counters are kept. */
  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  /** Hit and miss counters since construction, and what is held now. */
  stats(): LruCacheStats {
    return { hits: this.hits, misses: this.misses, entries: this.entries.size, bytes: this.bytes };
  }
}
