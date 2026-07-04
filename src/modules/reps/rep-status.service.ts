import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Rep } from './entities/rep.entity';
import { RepStatus } from './entities/rep-status.entity';
import { HeartbeatDto } from './dto/heartbeat.dto';

/** Don't re-alert GPS-off more than once per rep per this window (multi-device flip-flop guard). */
const GPS_ALERT_COOLDOWN_MS = 15 * 60_000;

@Injectable()
export class RepStatusService {
  private readonly logger = new Logger(RepStatusService.name);

  constructor(
    @InjectRepository(RepStatus)
    private readonly statuses: Repository<RepStatus>,
    @InjectRepository(Rep)
    private readonly reps: Repository<Rep>,
    private readonly bus: EventEmitter2,
  ) {}

  /**
   * Bump last_seen_at from location traffic. Fail-safe: a status write must
   * never break a location upload, so failures are swallowed with a warning.
   * Server time only (client timestamps are historical for bulk uploads).
   */
  async touch(repId: string): Promise<void> {
    try {
      await this.statuses.query(
        `INSERT INTO rep_statuses (rep_id, last_seen_at)
         VALUES ($1, now())
         ON CONFLICT (rep_id)
         DO UPDATE SET last_seen_at = now(), updated_at = now()`,
        [repId],
      );
    } catch (err) {
      this.logger.warn(`touch(${repId}) failed: ${(err as Error).message}`);
    }
  }

  /**
   * Record a liveness heartbeat. Updates last_seen_at + gps/app state and, on a
   * GPS enabled→disabled transition (while still signed in), emits `rep.gps_off`
   * once per cooldown window; disabled→enabled emits `rep.gps_on`.
   */
  async heartbeat(repId: string, dto: HeartbeatDto): Promise<{ ok: true }> {
    await this.assertRepExists(repId);

    const prev = await this.statuses.findOne({ where: { repId } });
    const appState = dto.appState ?? 'active';
    const now = new Date();

    const next: RepStatus =
      prev ??
      this.statuses.create({
        repId,
        offlineAlertedAt: null,
        gpsAlertedAt: null,
      });
    next.lastSeenAt = now;
    next.gpsEnabled = dto.gpsEnabled;
    next.lastAppState = appState;
    next.batteryPct = dto.batteryPct ?? null;

    // GPS transitions are only meaningful for a working rep, not a sign-out.
    if (appState !== 'signed_out') {
      const wasOn = prev?.gpsEnabled === true;
      const wasOff = prev?.gpsEnabled === false;
      if (wasOn && dto.gpsEnabled === false) {
        const alertedAt = prev?.gpsAlertedAt ? new Date(prev.gpsAlertedAt).getTime() : 0;
        if (now.getTime() - alertedAt > GPS_ALERT_COOLDOWN_MS) {
          next.gpsAlertedAt = now;
          this.bus.emit('rep.gps_off', { repId, at: now });
          this.logger.log(`rep.gps_off rep=${repId}`);
        }
      } else if (wasOff && dto.gpsEnabled === true) {
        next.gpsAlertedAt = null;
        this.bus.emit('rep.gps_on', { repId, at: now });
        this.logger.log(`rep.gps_on rep=${repId}`);
      }
    }

    await this.statuses.save(next);
    return { ok: true };
  }

  private async assertRepExists(repId: string): Promise<void> {
    const exists = await this.reps.exist({ where: { id: repId } });
    if (!exists) throw new NotFoundException(`Rep ${repId} not found`);
  }
}
