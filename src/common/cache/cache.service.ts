/**
 * Provider-neutral key/value cache interface.
 *
 * v1 implementation = LruCacheAdapter (in-process, per Node instance).
 * Production swap target = RedisCacheAdapter (shared across instances).
 *
 * Use for AI response caching, briefing reuse, forecast memoization.
 * Do NOT use for tenant/user data — RLS-scoped queries belong in Postgres.
 */
export interface CacheService {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T, ttlSec?: number): Promise<void>;
  del(key: string): Promise<void>;
}

export const CACHE_SERVICE = Symbol('CACHE_SERVICE');
