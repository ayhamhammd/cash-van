import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SettingsService } from '../settings/settings.service';
import { ErpOutboxService } from './erp-outbox.service';
import { OUTBOX_KIND_BY_TRANS } from './outbox-enqueue';

/** Don't chase a voucher the drain has not plausibly had a go at yet. */
const GRACE_MINUTES = 10;
const LIMIT = 500;

/**
 * Find posted vouchers that carry no ERP outbox row, and queue them.
 *
 * This is the backstop that makes the transactional outbox **verifiable rather
 * than merely believed**. After that change there is no path by which a posted
 * van document can fail to be queued — so this must find nothing, and any
 * non-zero count is either a bug in the enqueue or a route creating posted
 * vouchers that does not go through it.
 *
 * Run it once by hand on each installation BEFORE the transactional enqueue
 * ships. Whatever it turns up there is the accumulated backlog of the old
 * post-commit listener: real invoices that exist in VanFlow and have never
 * existed in the ERP.
 *
 * The count is the metric. It belongs next to the outbox counters on the ERP
 * status page, not only in a log nobody greps.
 */
@Injectable()
export class ErpOutboxSweepService {
  private readonly logger = new Logger(ErpOutboxSweepService.name);
  private sweeping = false;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    private readonly outbox: ErpOutboxService,
  ) {}

  @Cron('7 * * * *', { name: 'erp-outbox-sweep' })
  async sweep(): Promise<{ found: number; queued: number }> {
    if (this.sweeping) return { found: 0, queued: 0 };
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled) return { found: 0, queued: 0 };

    this.sweeping = true;
    try {
      const missing = await this.findUnqueued();
      if (missing.length === 0) return { found: 0, queued: 0 };

      // Loud on purpose. Silence here is the expected state, so a message means
      // something is creating posted vouchers outside the transactional path.
      this.logger.warn(
        `${missing.length} posted voucher(s) have no ERP outbox row — queueing them. ` +
          'After the transactional enqueue shipped this should be zero; a non-zero ' +
          'count means a document is reaching voucher_headers by some other route. ' +
          `First few: ${missing
            .slice(0, 5)
            .map((m) => m.voucher_number)
            .join(', ')}`,
      );

      let queued = 0;
      for (const m of missing) {
        const kind = OUTBOX_KIND_BY_TRANS[m.trans_kind];
        if (!kind) continue;
        await this.outbox.enqueue(kind, m.voucher_number);
        queued++;
      }
      return { found: missing.length, queued };
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Posted van documents with no matching outbox row.
   *
   * `ERP-` numbers are excluded: those were mirrored IN from the ERP, and
   * pushing one back would hand the ERP its own invoice as a new one.
   */
  private async findUnqueued(): Promise<
    Array<{ voucher_number: string; trans_kind: string }>
  > {
    return this.ds.query(
      `SELECT h.voucher_number, h.trans_kind
         FROM voucher_headers h
         LEFT JOIN erp_outbox o
                ON o.ref = h.voucher_number
               AND o.kind = CASE h.trans_kind
                              WHEN 'SALE'   THEN 'SALE_INVOICE'
                              WHEN 'RETURN' THEN 'SALES_RETURN'
                              WHEN 'ORDER'  THEN 'SALES_ORDER'
                            END
        WHERE h.is_posted
          AND h.trans_kind IN ('SALE', 'RETURN', 'ORDER')
          AND h.voucher_number NOT LIKE 'ERP-%'
          AND h.created_at < now() - ($1 || ' minutes')::interval
          AND o.id IS NULL
        ORDER BY h.created_at
        LIMIT $2`,
      [GRACE_MINUTES, LIMIT],
    );
  }
}
