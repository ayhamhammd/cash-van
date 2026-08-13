import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { AllocatedLine, AllocationPlan } from './allocate';
import { VouchersService } from '../vouchers.service';
import type { CreateVoucherDto } from '../dto/create-voucher.dto';

/**
 * Turn a confirmed allocation into RETURN vouchers — one per source sale.
 *
 * See docs/RETURNS-without-a-sale-voucher.md.
 *
 * ## One voucher per source sale, decided here and not at push time
 *
 * The ERP's `POST /api/v1/sales-returns` takes a single `originalInvoiceNumber`,
 * and one credit note per invoice is a JoFotara constraint (`BillingReference`
 * holds one invoice id). A return of ten units drawn from two sales is two
 * documents on both sides.
 *
 * Splitting here rather than in the ERP outbox also keeps idempotency honest:
 * `externalId` is the idempotency key, so each document needs its own voucher
 * number. Fanning out at push time would mean synthesising ids, and a retry
 * after a timeout could double-post.
 *
 * ## Re-checked under lock, not trusted from the preview
 *
 * The preview read candidates outside any transaction. Between preview and
 * confirm someone else may have returned the same goods. `SELECT … FOR UPDATE`
 * re-reads every source line and refuses the whole batch if any no longer has
 * the units — refusing is recoverable, over-returning is not.
 */
@Injectable()
export class ReturnCreateService {
  constructor(
    private readonly ds: DataSource,
    private readonly vouchers: VouchersService,
  ) {}

  /** Group a plan's lines by the sale they came from. */
  private byVoucher(lines: AllocatedLine[]): Map<string, AllocatedLine[]> {
    const out = new Map<string, AllocatedLine[]>();
    for (const l of lines) {
      out.set(l.voucherNumber, [...(out.get(l.voucherNumber) ?? []), l]);
    }
    return out;
  }

  async createFromPlan(args: {
    plan: AllocationPlan;
    userCode: string;
    customerNumber?: string | null;
    storeNumber?: string | null;
    /** Post immediately. The ERP push is triggered by posting, not by creation. */
    post?: boolean;
  }): Promise<{ vouchers: string[] }> {
    const { plan, userCode } = args;
    if (plan.error) throw new BadRequestException(plan.error);
    if (plan.lines.length === 0) {
      throw new BadRequestException('Nothing to return — the allocation is empty.');
    }

    const created: string[] = [];

    await this.ds.transaction(async (trx) => {
      // Lock every source line for the life of the transaction, then re-check.
      // Ordered by id so two concurrent returns take the locks in the same
      // sequence and deadlock instead of interleaving.
      const lineIds = [...new Set(plan.lines.map((l) => l.lineId))].sort();
      const locked = await trx.query<
        Array<{ id: string; item_qty: string; qty_returned: string }>
      >(
        `SELECT id::text, item_qty, qty_returned
           FROM voucher_transactions
          WHERE id = ANY($1::uuid[])
          ORDER BY id
            FOR UPDATE`,
        [lineIds],
      );

      const remainingOf = new Map(
        locked.map((r) => [r.id, Number(r.item_qty) - Number(r.qty_returned)]),
      );
      for (const [lineId, lines] of this.groupByLine(plan.lines)) {
        const want = lines.reduce((s, l) => s + l.quantity, 0);
        const have = remainingOf.get(lineId);
        if (have === undefined) {
          throw new ConflictException(
            'A source sale line disappeared while you were confirming. Re-run the preview.',
          );
        }
        if (want > have + 1e-9) {
          throw new ConflictException(
            `Only ${have} left to return on one of the source sales (you asked for ${want}). ` +
              'Someone else returned these goods first — re-run the preview.',
          );
        }
      }

      // Create one RETURN per source sale. Each carries referenceVoucherNumber,
      // so the existing ERP push (buildReturn) handles it with no changes.
      for (const [sourceVoucher, lines] of this.byVoucher(plan.lines)) {
        const dto: CreateVoucherDto = {
          transKind: 'RETURN',
          userCode,
          customerNumber: args.customerNumber ?? lines[0].customerNumber ?? undefined,
          referenceVoucherNumber: sourceVoucher,
          // Posting is what moves stock and fires erp.voucher.posted → the ERP
          // push. Left false the documents are drafts the office must post.
          isPosted: args.post ?? false,
          transactions: lines.map((l) => ({
            itemNumber: l.itemNumber,
            // Name as sold, not as currently catalogued — the return document
            // should read like the sale it reverses.
            itemName: l.itemName,
            itemQty: l.quantity.toString(),
            // The price AS SOLD, never today's price list: a refund must return
            // what the customer was charged.
            unitPrice: l.unitPrice.toString(),
            itemUnitId: l.itemUnitId ?? undefined,
            storeNumber: args.storeNumber ?? undefined,
          })),
        };

        const voucher = await this.vouchers.create(dto);
        created.push(voucher.voucherNumber);
      }

      // Consume the allowance only once the documents exist, inside the same
      // transaction — so a failure part-way leaves neither the vouchers nor the
      // consumed quantity behind.
      for (const [lineId, lines] of this.groupByLine(plan.lines)) {
        const qty = lines.reduce((s, l) => s + l.quantity, 0);
        await trx.query(
          `UPDATE voucher_transactions
              SET qty_returned = qty_returned + $2
            WHERE id = $1::uuid`,
          [lineId, qty],
        );
      }
    });

    return { vouchers: created };
  }

  private groupByLine(lines: AllocatedLine[]): Map<string, AllocatedLine[]> {
    const out = new Map<string, AllocatedLine[]>();
    for (const l of lines) out.set(l.lineId, [...(out.get(l.lineId) ?? []), l]);
    return out;
  }
}
