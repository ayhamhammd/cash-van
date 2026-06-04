import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { dirname, join, normalize, sep } from 'path';

/**
 * Local-disk object storage for uploaded artifacts (cheque images, voice
 * clips, etc.). Files are written under `storage.localRoot` and served from
 * `storage.publicBaseUrl`.
 *
 * NOTE: on ephemeral hosts (e.g. Render's free tier) the disk does not survive
 * restarts — point `localRoot` at a mounted volume or swap this for an R2/S3
 * adapter for durable storage.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly root: string;
  private readonly publicBaseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.root = this.config.get<string>('storage.localRoot', './storage');
    this.publicBaseUrl = this.config.get<string>(
      'storage.publicBaseUrl',
      '/storage',
    );
  }

  /** Resolve a storage key to an absolute path, guarding against traversal. */
  private resolve(key: string): string {
    const safe = normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');
    if (safe.split(sep).includes('..')) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return join(this.root, safe);
  }

  /** Persist a buffer at `key`, creating parent directories as needed. */
  async save(key: string, data: Buffer): Promise<string> {
    const target = this.resolve(key);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    this.logger.debug(`Stored ${data.length} bytes at ${key}`);
    return this.publicUrl(key);
  }

  /** Read the bytes stored at `key`. */
  async read(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  /** Remove the object at `key` (no-op if it does not exist). */
  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  /** Public URL under which `key` is served. */
  publicUrl(key: string): string {
    const base = this.publicBaseUrl.replace(/\/+$/, '');
    const path = key.replace(/^\/+/, '');
    return `${base}/${path}`;
  }
}
