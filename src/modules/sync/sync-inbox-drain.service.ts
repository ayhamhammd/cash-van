import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { VoucherInbox } from './entities/voucher-inbox.entity';
import { SyncService } from './sync.service';
import { intakeBackoffMs } from './intake-failure';

// Read from process.env, not ConfigService: @Interval() is evaluated when the
// class is defined, before DI exists — the same constraint ErpOutboxService
// documents for ERP_OUTBOX_DRAIN_MS.
const DRAIN_INTERVAL_MS = parseInt(process.env.SYNC_INBOX_DRAIN_MS ?? '20000', 10);
const BATCH = 20;

/**
 * Promote staged documents that have not made it into the main tables yet.
 *
 * Before this, a document that failed promotion sat in `voucher_inbox` until a
 * human opened the dashboard and pressed retry — and nothing told them to. A
 * sale rejected because the van's load transfer had not arrived yet would wait
 * there indefinitely, while the handset, having been told the document was
 * accepted, had every right to drop its copy.
 *
 * The queue now drains itself, and only a document that genuinely needs a
 * person stops moving (`rejected` / `dead_letter`, both announced by
 * `SyncService.markFailed`).
 *
 * Deliberately modelled on `ErpOutboxService`: same batch size, same
 * claim-then-work shape, same in-flight guard. Two queues that behave alike are
 * two queues an operator only has to learn once.
 */
@Injectable()
export class SyncInboxDrainService {
  private readonly logger = new Logger(SyncInboxDrainService.name);
  private draining = false;

  constructor(
    @InjectRepository(VoucherInbox)
    private readonly inbox: Repository<VoucherInbox>,
    private readonly sync: SyncService,
  ) {}

  @Interval(DRAIN_INTERVAL_MS)
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const due = await this.claimDue(BATCH);
      if (due.length === 0) return;
      this.logger.log(`Draining ${due.length} staged document(s)`);
      for (const row of due) {
        await this.sync.promoteRow(row).catch((e: unknown) => {
          // promoteRow records its own outcome; anything escaping it is a bug in
          // this service, not a document problem, and must not stop the batch.
          this.logger.error(
            `Unhandled error promoting inbox ${row.id}: ${(e as Error).message}`,
            (e as Error).stack,
          );
        });
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Take ownership of the next due rows.
   *
   * `FOR UPDATE SKIP LOCKED` is the whole mechanism: a second instance running
   * this same interval skips whatever the first is holding instead of promoting
   * it a second time. The rest of the scheduler layer is still single-instance
   * (in-process `@Interval` with a local flag, sockets without a Redis adapter),
   * so this does not make the API horizontally scalable by itself — it makes
   * sure the inbox is not the thing standing in the way when that changes.
   *
   * `next_attempt_at` is pushed forward as part of the claim, so a row that
   * crashes mid-promotion still backs off instead of being picked up again on
   * the very next tick.
   */
  private async claimDue(limit: number): Promise<VoucherInbox[]> {
    const rows: Array<{ id: string }> = await this.inbox.manager.query(
      `UPDATE voucher_inbox
          SET next_attempt_at = now() + ($2 || ' milliseconds')::interval,
              last_attempt_at = now()
        WHERE id IN (
          SELECT id FROM voucher_inbox
           WHERE status IN ('accepted', 'pending')
             AND next_attempt_at <= now()
           ORDER BY created_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
      [limit, intakeBackoffMs(0)],
    );
    if (rows.length === 0) return [];
    // Re-read through the repository so the rows arrive mapped, rather than as
    // the snake_case shape RETURNING hands back.
    return this.inbox.find({ where: { id: In(rows.map((r) => r.id)) } });
  }
}
