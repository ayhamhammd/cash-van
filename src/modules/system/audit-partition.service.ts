import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Keeps `audit_log` monthly partitions ahead of the calendar (mirrors plan 02).
 * Ensures next month's partition on boot and on the 25th of each month.
 */
@Injectable()
export class AuditPartitionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuditPartitionService.name);

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensureNextMonthPartition();
    } catch (err) {
      this.logger.error(`audit partition ensure failed on boot: ${(err as Error).message}`);
    }
  }

  async ensureNextMonthPartition(now: Date = new Date()): Promise<void> {
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const year = next.getUTCFullYear();
    const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
    const after = new Date(Date.UTC(year, next.getUTCMonth() + 1, 1));
    const table = `audit_log_${year}${mm}`;
    const from = `${year}-${mm}-01`;
    const to = `${after.getUTCFullYear()}-${String(after.getUTCMonth() + 1).padStart(2, '0')}-01`;
    await this.ds.query(`
      CREATE TABLE IF NOT EXISTS "${table}"
      PARTITION OF "audit_log" FOR VALUES FROM ('${from}') TO ('${to}')
    `);
    this.logger.log(`Ensured audit partition ${table} (${from} → ${to})`);
  }

  @Cron('5 0 25 * *', { name: 'audit-next-month-partition' })
  async monthlyTick(): Promise<void> {
    await this.ensureNextMonthPartition();
  }
}
