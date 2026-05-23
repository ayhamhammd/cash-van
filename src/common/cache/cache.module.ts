import { Global, Module } from '@nestjs/common';

import { LruCacheAdapter } from './lru-cache.adapter';
import { CACHE_SERVICE } from './cache.service';

@Global()
@Module({
  providers: [
    LruCacheAdapter,
    {
      provide: CACHE_SERVICE,
      useExisting: LruCacheAdapter,
    },
  ],
  exports: [CACHE_SERVICE],
})
export class CacheModule {}
