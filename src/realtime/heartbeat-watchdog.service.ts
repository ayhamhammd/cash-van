import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Rep } from '../modules/reps/entities/rep.entity';
import { RepLocationEvent } from '../modules/reps/entities/rep-location-event.entity';

const OFFLINE_MS = 2 * 60 * 60 * 1000; // 2h

/**
 * Every 60s, finds active reps whose last GPS ping is older than 2h and emits
 * `rep.offline` once per rep (the EventBridge forwards it over WebSocket).
 *
 * Debounced via an in-memory set: a rep re-fires only after it comes back
 * online (a fresh ping within 2h).
 */
@Injectable()
export class HeartbeatWatchdogService {
  private readonly logger = new Logger(HeartbeatWatchdogService.name);
  private readonly offlineAlerted = new Set<string>();

  constructor(
    @InjectRepository(Rep) private readonly reps: Repository<Rep>,
    @InjectRepository(RepLocationEvent)
    private readonly events: Repository<RepLocationEvent>,
    private readonly bus: EventEmitter2,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'rep-offline-watchdog' })
  async tick(): Promise<void> {
    try {
      await this.check();
    } catch (err) {
      this.logger.warn(`heartbeat check failed: ${(err as Error).message}`);
    }
  }

  async check(now: Date = new Date()): Promise<void> {
    const activeReps = await this.reps.find({ where: { isActive: true } });
    if (activeReps.length === 0) return;

    // Last ping per rep (only those that ever pinged).
    const rows = (await this.events.query(
      `SELECT DISTINCT ON (rep_id) rep_id, recorded_at
       FROM rep_location_events
       ORDER BY rep_id, recorded_at DESC`,
    )) as Array<{ rep_id: string; recorded_at: Date }>;
    const lastSeen = new Map(rows.map((r) => [r.rep_id, new Date(r.recorded_at)]));

    for (const rep of activeReps) {
      const seen = lastSeen.get(rep.id);
      if (!seen) continue; // never pinged → not "went offline"
      const ageMs = now.getTime() - seen.getTime();
      if (ageMs > OFFLINE_MS) {
        if (!this.offlineAlerted.has(rep.id)) {
          this.offlineAlerted.add(rep.id);
          this.bus.emit('rep.offline', { repId: rep.id, lastSeen: seen });
          this.logger.log(`rep.offline rep=${rep.id} lastSeen=${seen.toISOString()}`);
        }
      } else {
        this.offlineAlerted.delete(rep.id); // back online
      }
    }
  }
}
