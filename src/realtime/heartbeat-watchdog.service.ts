import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

import { Rep } from '../modules/reps/entities/rep.entity';
import { RepStatus } from '../modules/reps/entities/rep-status.entity';

/**
 * Every 60s, finds active reps whose last liveness signal (heartbeat or GPS
 * ping) is older than the configured threshold and emits `rep.offline` once per
 * rep; on recovery it emits `rep.online`. Reps who deliberately closed their day
 * (`last_app_state = 'signed_out'`) are never alerted.
 *
 * Dedup is persisted in rep_statuses.offline_alerted_at (survives redeploys),
 * and the pre-emit UPDATE guard makes alerting idempotent across instances.
 */
@Injectable()
export class HeartbeatWatchdogService {
  private readonly logger = new Logger(HeartbeatWatchdogService.name);
  private readonly thresholdMs: number;

  constructor(
    @InjectRepository(Rep) private readonly reps: Repository<Rep>,
    @InjectRepository(RepStatus)
    private readonly statuses: Repository<RepStatus>,
    private readonly bus: EventEmitter2,
    config: ConfigService,
  ) {
    const minutes = config.get<number>('heartbeat.offlineThresholdMin') ?? 10;
    this.thresholdMs = minutes * 60_000;
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'rep-offline-watchdog' })
  async tick(): Promise<void> {
    try {
      await this.check();
    } catch (err) {
      this.logger.warn(`heartbeat check failed: ${(err as Error).message}`);
    }
  }

  async check(now: Date = new Date()): Promise<void> {
    const rows = (await this.statuses.query(
      `SELECT r.id AS rep_id, s.last_seen_at, s.offline_alerted_at, s.last_app_state
       FROM reps r
       JOIN rep_statuses s ON s.rep_id = r.id
       WHERE r.is_active = true`,
    )) as Array<{
      rep_id: string;
      last_seen_at: Date | null;
      offline_alerted_at: Date | null;
      last_app_state: string;
    }>;

    for (const row of rows) {
      // Day closed / signed out: never alert; clear any stale pending flag.
      if (row.last_app_state === 'signed_out') {
        if (row.offline_alerted_at) {
          await this.statuses.query(
            `UPDATE rep_statuses SET offline_alerted_at = NULL WHERE rep_id = $1`,
            [row.rep_id],
          );
        }
        continue;
      }

      const seen = row.last_seen_at ? new Date(row.last_seen_at) : null;
      if (!seen) continue; // never pinged → not "went offline"
      const ageMs = now.getTime() - seen.getTime();

      if (ageMs > this.thresholdMs && !row.offline_alerted_at) {
        // Idempotent claim: RETURNING yields a row only for the instance that
        // actually flipped NULL→now(), so only it emits.
        const claimed = (await this.statuses.query(
          `UPDATE rep_statuses SET offline_alerted_at = now()
           WHERE rep_id = $1 AND offline_alerted_at IS NULL
           RETURNING rep_id`,
          [row.rep_id],
        )) as Array<{ rep_id: string }>;
        if (claimed.length > 0) {
          this.bus.emit('rep.offline', { repId: row.rep_id, lastSeen: seen });
          this.logger.log(
            `rep.offline rep=${row.rep_id} lastSeen=${seen.toISOString()}`,
          );
        }
      } else if (ageMs <= this.thresholdMs && row.offline_alerted_at) {
        await this.statuses.query(
          `UPDATE rep_statuses SET offline_alerted_at = NULL WHERE rep_id = $1`,
          [row.rep_id],
        );
        this.bus.emit('rep.online', { repId: row.rep_id, at: now });
        this.logger.log(`rep.online rep=${row.rep_id}`);
      }
    }
  }
}
