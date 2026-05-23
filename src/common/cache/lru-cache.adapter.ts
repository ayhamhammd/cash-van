import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LRUCache } from 'lru-cache';

import { CacheService } from './cache.service';

@Injectable()
export class LruCacheAdapter implements CacheService {
  private readonly cache: LRUCache<string, object>;

  constructor(config: ConfigService) {
    this.cache = new LRUCache({
      max: config.get<number>('cache.maxEntries', 5_000),
      ttl: config.get<number>('cache.defaultTtlSec', 300) * 1000,
    });
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.cache.get(key) as T | undefined;
  }

  async set<T = unknown>(key: string, value: T, ttlSec?: number): Promise<void> {
    this.cache.set(
      key,
      value as object,
      ttlSec ? { ttl: ttlSec * 1000 } : undefined,
    );
  }

  async del(key: string): Promise<void> {
    this.cache.delete(key);
  }
}
