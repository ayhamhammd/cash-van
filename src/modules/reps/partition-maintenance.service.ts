import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { NotificationsService } from '../notifications/notifications.service';

/**
 * Keeps `rep_location_events` monthly partitions ahead of the calendar.
 *
 * - On boot and on the 25th of every month: ensure the next MONTHS_AHEAD months
 *   exist. Idempotent — `CREATE TABLE IF NOT EXISTS`.
 * - Reports the state of the DEFAULT catch-all partition, because a row sitting
 *   in it is an outage in waiting (see below).
 *
 * ## Why more than one month ahead
 *
 * This used to ensure exactly one. A single failed tick was then a cliff: the
 * month arrives with no partition, every ping lands in the DEFAULT partition,
 * and the next attempt to create that month's table fails *because* of those
 * rows. One missed run turned into a permanent one.
 *
 * ## Why the DEFAULT partition is watched
 *
 * The schema has a DEFAULT catch-all so a late ping never errors, which is
 * right. The consequence is not obvious: **a row in the default partition
 * blocks creation of the partition it belongs to.** Postgres scans the default
 * partition on `CREATE TABLE ... PARTITION OF ... FOR VALUES FROM (a) TO (b)`
 * and refuses if any row falls in `[a,b)`:
 *
 *     ERROR: updated partition constraint for default partition
 *            "rep_location_events_default" would be violated by some row
 *
 * So one handset with its clock set into the future writes one row, and this
 * job fails for that month forever. It used to fail *silently*: `monthlyTick`
 * had no try/catch, so it threw inside the scheduler and the only trace was an
 * unhandled rejection. Now every failure is caught, logged with the remedy, and
 * raised to the managers' inbox.
 *
 * Old partitions are NOT dropped here — retention is a separate job
 * (docs/SPEC-location-ingest-integrity.md §4.5).
 */
@Injectable()
export class PartitionMaintenanceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PartitionMaintenanceService.name);

  /** Months of runway kept ahead of today. */
  private static readonly MONTHS_AHEAD = 3;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureRunway('boot');
  }

  // 00:05 on the 25th of every month, in the server's local time.
  @Cron('5 0 25 * *', { name: 'rle-next-month-partition' })
  async monthlyTick(): Promise<void> {
    await this.ensureRunway('monthly tick');
  }

  /**
   * Ensure the next MONTHS_AHEAD months exist, then report on the default
   * partition. Never throws: a partition job that throws inside the scheduler
   * is an outage with no message.
   */
  async ensureRunway(trigger: string, now: Date = new Date()): Promise<void> {
    const failures: string[] = [];

    for (let i = 1; i <= PartitionMaintenanceService.MONTHS_AHEAD; i++) {
      try {
        await this.ensureMonthPartition(addMonthsUtc(now, i));
      } catch (err: unknown) {
        const message = (err as Error).message;
        failures.push(message);
        this.logger.error(
          `[${trigger}] Failed to ensure partition +${i} month(s): ${message}`,
          (err as Error).stack,
        );
      }
    }

    const stranded = await this.defaultPartitionRows().catch(() => null);
    if (stranded && stranded > 0) {
      this.logger.warn(
        `rep_location_events_default holds ${stranded} row(s). A row there blocks ` +
          'creation of the partition it belongs to — almost always a handset with ' +
          'a wrong clock. Inspect: SELECT rep_id, min(recorded_at), max(recorded_at), ' +
          'count(*) FROM rep_location_events_default GROUP BY rep_id;',
      );
    }

    if (failures.length > 0) {
      await this.raise(trigger, failures, stranded);
    }
  }

  /** Idempotent. Safe to call repeatedly. */
  async ensureNextMonthPartition(now: Date = new Date()): Promise<void> {
    await this.ensureMonthPartition(addMonthsUtc(now, 1));
  }

  private async ensureMonthPartition(month: Date): Promise<void> {
    const year = month.getUTCFullYear();
    const mm = String(month.getUTCMonth() + 1).padStart(2, '0');
    const tableName = `rep_location_events_${year}${mm}`;
    const from = `${year}-${mm}-01`;
    const after = addMonthsUtc(month, 1);
    const to = `${after.getUTCFullYear()}-${String(after.getUTCMonth() + 1).padStart(2, '0')}-01`;

    await this.ds.query(`
      CREATE TABLE IF NOT EXISTS "${tableName}"
      PARTITION OF "rep_location_events"
      FOR VALUES FROM ('${from}') TO ('${to}')
    `);
    this.logger.log(`Ensured partition ${tableName} (range ${from} → ${to})`);
  }

  /**
   * Rows stranded in the catch-all. Counted exactly rather than estimated: the
   * table is meant to be empty, so the count is cheap, and "about 200" is not an
   * answer anyone can act on.
   */
  private async defaultPartitionRows(): Promise<number> {
    const rows: Array<{ n: string }> = await this.ds.query(
      `SELECT count(*)::text AS n FROM "rep_location_events_default"`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  private async raise(
    trigger: string,
    failures: string[],
    stranded: number | null,
  ): Promise<void> {
    const blocked = failures.some((f) => /default partition/i.test(f));
    const bodyEn = blocked
      ? `Partition creation is blocked by ${stranded ?? 'some'} row(s) in ` +
        'rep_location_events_default — a device clock is wrong. Location history ' +
        'still records, but the table is no longer partitioned for those months.'
      : `Could not create upcoming location partitions (${trigger}): ${failures[0]}`;

    await this.notifications
      .notifyManagers({
        kind: 'system.partition_maintenance_failed',
        titleAr: 'فشل تجهيز جداول تتبع المواقع',
        titleEn: 'Location tracking partitions could not be prepared',
        bodyAr: blocked
          ? 'هناك سجلات بتاريخ غير صحيح تمنع إنشاء جداول الأشهر القادمة — ساعة أحد الأجهزة غير مضبوطة.'
          : 'تعذّر إنشاء جداول المواقع للأشهر القادمة. راجع سجلّ الخادم.',
        bodyEn,
      })
      .catch((e: unknown) => {
        // A failed notification must not mask the failure it was reporting.
        this.logger.error(
          `Could not raise partition-maintenance alert: ${(e as Error).message}`,
        );
      });
  }
}

function addMonthsUtc(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

// Silence unused-import lint when @nestjs/schedule re-exports change.
void CronExpression;
