import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Keeps `rep_location_events` monthly partitions ahead of the calendar.
 *
 * - On boot: ensures the next month's partition exists (covers fresh deploys
 *   on the 26th of a month).
 * - On the 25th at 00:05 every month: ensures the NEXT month's partition
 *   exists. Idempotent — uses `CREATE TABLE IF NOT EXISTS`.
 *
 * Old partitions are NOT dropped automatically. A separate retention task
 * (out of scope here) can drop partitions older than N months when needed.
 */
@Injectable()
export class PartitionMaintenanceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PartitionMaintenanceService.name);

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensureNextMonthPartition();
    } catch (err: unknown) {
      this.logger.error(
        `Failed to ensure next-month partition on boot: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  /** Idempotent. Safe to call repeatedly. */
  async ensureNextMonthPartition(now: Date = new Date()): Promise<void> {
    const next = addMonthsUtc(now, 1);
    const year = next.getUTCFullYear();
    const month = next.getUTCMonth() + 1;
    const mm = String(month).padStart(2, '0');
    const tableName = `rep_location_events_${year}${mm}`;
    const from = `${year}-${mm}-01`;
    const after = addMonthsUtc(next, 1);
    const to = `${after.getUTCFullYear()}-${String(after.getUTCMonth() + 1).padStart(2, '0')}-01`;

    await this.ds.query(`
      CREATE TABLE IF NOT EXISTS "${tableName}"
      PARTITION OF "rep_location_events"
      FOR VALUES FROM ('${from}') TO ('${to}')
    `);
    this.logger.log(
      `Ensured partition ${tableName} (range ${from} → ${to})`,
    );
  }

  // 00:05 on the 25th of every month, in the server's local time.
  @Cron('5 0 25 * *', { name: 'rle-next-month-partition' })
  async monthlyTick(): Promise<void> {
    await this.ensureNextMonthPartition();
  }
}

function addMonthsUtc(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

// Silence unused-import lint when @nestjs/schedule re-exports change.
void CronExpression;
