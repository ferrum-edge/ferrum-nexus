export interface FerrumCacheBackend {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  clear(): Promise<void>;
}

export interface FerrumCacheTtls {
  apiSpec: number;
  apiSpecList: number;
  apiSpecRaw: number;
  consumer: number;
  namespaces: number;
  health: number;
  negative: number;
}

