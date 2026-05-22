import { LRUCache } from 'lru-cache';
import type { FerrumCacheBackend } from './types.js';

export function createLruBackend(opts: { max: number }): FerrumCacheBackend {
  const cache = new LRUCache<string, { value: unknown }>({ max: opts.max });
  return {
    async get<T>(key: string) {
      return cache.get(key)?.value as T | undefined;
    },
    async set<T>(key: string, value: T, ttlMs: number) {
      cache.set(key, { value }, { ttl: ttlMs });
    },
    async delete(key) {
      cache.delete(key);
    },
    async deletePrefix(prefix) {
      for (const key of cache.keys()) {
        if (key.startsWith(prefix)) cache.delete(key);
      }
    },
    async clear() {
      cache.clear();
    },
  };
}
