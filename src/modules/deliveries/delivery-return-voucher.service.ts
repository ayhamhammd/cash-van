import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { VoucherHeader } from '../vouchers/entities/voucher-header.entity';
import { VoucherTransaction } from '../vouchers/entities/voucher-transaction.entity';
import { Payment } from '../vouchers/entities/payment.entity';
import { ErpIdMap } from '../erp-sync/entities/erp-id-map.entity';
import { DeliveryStop } from './entities/delivery-stop.entity';
import {
  buildReturnVoucher,
  returnRep,
  returnVoucherNote,
  returnVoucherNumber,
  type RepCandidate,
  type ReturnSourceLine,
} from './delivery-return-voucher';

export type EnsureOutcome =
  | { status: 'created' | 'exists'; voucherNumber: string; voucherId: string; repSource?: string }
  | { status: 'skipped'; reason: string };

/**
 * Turns an approved delivery return into its CashVan RETURN voucher — once.
 *
 * The ONE place it happens. approve() calls it after the ERP answers; the
 * mirror calls it whenever it sees a stop APPROVED with a credit note and no
 * voucher yet (which covers a return approved in the ERP's own screen, a
 * retried approve, an already-decided answer, and every re-read); the backfill
 * walks the stops already approved. However many of them arrive, one voucher:
 * it is keyed on the credit note (its number IS the voucher number), built
 * under a lock on it, and voucher numbers are unique.
 *
 * What it never does: queue it for the ERP (see delivery-return-voucher.ts —
 * the `ERP-` number keeps every push path away), move stock (no store on any
 * line), touch the customer's balance (the ERP ledger already has the credit
 * note, and total_debt is mirrored from it), or touch rep cash (CREDIT only,
 * and no erp.voucher.posted event is fired).
 */
@Injectable()
export class DeliveryReturnVoucherService {
  private readonly logger = new Logger(DeliveryReturnVoucherService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Build the voucher for one stop if it is due; a no-op when it already exists. */
  async ensureFor(stopId: string): Promise<EnsureOutcome> {
    const stop = await this.dataSource.getRepository(DeliveryStop).findOne({ where: { id: stopId } });
    if (!stop) return { status: 'skipped', reason: 'STOP_NOT_FOUND' };
    if (stop.returnStatus !== 'APPROVED') return { status: 'skipped', reason: 'NOT_APPROVED' };
    if (!stop.creditNoteNumber) return { status: 'skipped', reason: 'NO_CREDIT_NOTE' };
    if (stop.creditNoteTotalFils == null) return { status: 'skipped', reason: 'NO_CREDIT_NOTE_TOTAL' };
    const voucherNumber = returnVoucherNumber(stop.creditNoteNumber);

    const outcome = await this.dataSource.transaction(async (em) => {
      await em.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`delivery_return_voucher:${voucherNumber}`]);
      const existing = await em.getRepository(VoucherHeader).findOne({
        where: { voucherNumber },
        select: { id: true, voucherNumber: true },
      });
      if (existing) {
        await this.linkStop(em, stop.id, existing.voucherNumber, existing.id);
        return { status: 'exists' as const, voucherNumber, voucherId: existing.id };
      }
      return this.create(em, stop, voucherNumber);
    });
    if (outcome.status === 'created') {
      this.logger.log(`Delivery return ${stop.creditNoteNumber} → RETURN voucher ${voucherNumber} (${outcome.repSource})`);
    } else if (outcome.status === 'skipped') {
      this.logger.warn(`No RETURN voucher for stop ${stop.id} (${stop.creditNoteNumber}): ${outcome.reason}`);
    }
    return outcome;
  }

  /** Every stop of a run that is approved with a credit note and has no voucher yet. */
  async ensureForRun(runId: string): Promise<void> {
    const due: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM delivery_stops
        WHERE run_id = $1 AND return_status = 'APPROVED'
          AND credit_note_number IS NOT NULL AND return_voucher_number IS NULL`,
      [runId],
    );
    for (const d of due) {
      await this.ensureFor(d.id).catch((e: unknown) =>
        this.logger.warn(`RETURN voucher for stop ${d.id} failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  /** Every approved return without its voucher — the one-off for returns approved before this existed. */
  async backfill(): Promise<{ total: number; created: number; existing: number; skipped: Array<{ stopId: string; reason: string }> }> {
    const due: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM delivery_stops
        WHERE return_status = 'APPROVED' AND credit_note_number IS NOT NULL AND return_voucher_number IS NULL
        ORDER BY return_decided_at NULLS LAST, id`,
    );
    const out = { total: due.length, created: 0, existing: 0, skipped: [] as Array<{ stopId: string; reason: string }> };
    for (const d of due) {
      const r: EnsureOutcome = await this.ensureFor(d.id).catch((e: unknown) => ({
        status: 'skipped' as const,
        reason: e instanceof Error ? e.message : String(e),
      }));
      if (r.status === 'created') out.created += 1;
      else if (r.status === 'exists') out.existing += 1;
      else if ('reason' in r) out.skipped.push({ stopId: d.id, reason: r.reason });
    }
    return out;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async create(em: EntityManager, stop: DeliveryStop, voucherNumber: string): Promise<EnsureOutcome> {
    const customer = stop.customerId
      ? ((await em.query(
          `SELECT id, customer_number, rep_id FROM customers WHERE id = $1`,
          [stop.customerId],
        )) as Array<{ id: string; customer_number: string; rep_id: string | null }>)[0]
      : undefined;
    if (!customer) return { status: 'skipped', reason: 'CUSTOMER_NOT_FOUND' };

    const run = ((await em.query(`SELECT run_number, rep_id FROM delivery_runs WHERE id = $1`, [stop.runId])) as Array<{
      run_number: string | null;
      rep_id: string | null;
    }>)[0];

    // The approved lines, resolved to CashVan items the way the ERP mirror does.
    const lineRows: Array<{
      erp_invoice_item_id: string;
      sku_code: string | null;
      name_ar: string | null;
      name_en: string | null;
      approved_qty: string | null;
      billed_qty: string | null;
      line_total_fils: string;
      unit_price_fils: string;
      tax_rate: string | null;
      reason_code: string | null;
    }> = await em.query(
      `SELECT erp_invoice_item_id, sku_code, name_ar, name_en, approved_qty, billed_qty,
              line_total_fils, unit_price_fils, tax_rate, reason_code
         FROM delivery_stop_lines
        WHERE stop_id = $1 AND COALESCE(approved_qty, 0) > 0
        ORDER BY line_no NULLS LAST, erp_invoice_item_id`,
      [stop.id],
    );
    if (!lineRows.length) return { status: 'skipped', reason: 'NOTHING_APPROVED' };
    const lines: ReturnSourceLine[] = [];
    for (const l of lineRows) {
      const item = l.sku_code ? await this.itemForSku(em, l.sku_code) : null;
      // No partial voucher: a line left off would make it disagree with the credit note.
      if (!item) return { status: 'skipped', reason: `UNKNOWN_SKU:${l.sku_code ?? '?'}` };
      lines.push({
        itemNumber: item.itemNumber,
        itemName: l.name_ar || l.name_en || item.itemName,
        itemUnitId: item.itemUnitId,
        approvedQty: Number(l.approved_qty),
        billedQty: Number(l.billed_qty ?? 0),
        lineTotalFils: Number(l.line_total_fils ?? 0),
        unitPriceFils: Number(l.unit_price_fils ?? 0),
        taxRate: Number(l.tax_rate ?? 0),
        reasonCode: l.reason_code,
      });
    }

    const sale = await this.originalSale(em, stop.invoiceNumber ?? null);
    const rep = returnRep({
      saleSeller: sale ? await this.repByCode(em, sale.userCode) : null,
      invoiceRep: await this.invoiceRep(em, stop.erpInvoiceId ?? null),
      customerRep: customer.rep_id ? await this.repById(em, customer.rep_id) : null,
      deliveryRep: run?.rep_id ? await this.repById(em, run.rep_id) : null,
    });
    if (!rep) return { status: 'skipped', reason: 'NO_REP_WITH_LOGIN' };

    const taxMode = ((await em.query(`SELECT tax_calc_method FROM app_settings WHERE id = 1`)) as Array<{
      tax_calc_method: string | null;
    }>)[0]?.tax_calc_method === 'INCLUSIVE'
      ? 'INCLUSIVE'
      : 'EXCLUSIVE';

    const voucher = buildReturnVoucher({
      voucherNumber,
      userCode: rep.rep.code!,
      customerNumber: customer.customer_number,
      referenceVoucherNumber: sale?.voucherNumber ?? null,
      inDate: stop.returnDecidedAt ?? new Date(),
      notes: returnVoucherNote({
        runNumber: run?.run_number ?? null,
        invoiceNumber: stop.invoiceNumber ?? null,
        creditNoteNumber: stop.creditNoteNumber!,
        reasons: lines.map((l) => l.reasonCode).filter((r): r is string => !!r),
        officeNote: stop.returnDecisionNote ?? null,
      }),
      creditNote: {
        totalFils: Number(stop.creditNoteTotalFils),
        taxFils: Number(stop.creditNoteTaxFils ?? 0),
        qr: stop.creditNoteQr ?? null,
        jofotaraStatus: stop.creditNoteJofotaraStatus ?? null,
      },
      taxMode,
      lines,
    });
    if (!voucher) return { status: 'skipped', reason: 'NOTHING_APPROVED' };

    const header = await em.getRepository(VoucherHeader).save(em.getRepository(VoucherHeader).create(voucher.header));
    await em
      .getRepository(VoucherTransaction)
      .save(voucher.lines.map((l) => em.getRepository(VoucherTransaction).create(l)));
    await em.getRepository(Payment).save(em.getRepository(Payment).create(voucher.payment));

    // The credit note is this voucher's ERP document — the same id-map entry a
    // pushed return gets, written here because nothing will ever push it.
    const map =
      (await em.getRepository(ErpIdMap).findOne({ where: { entity: 'voucher', erpId: voucherNumber } })) ??
      em.getRepository(ErpIdMap).create({ entity: 'voucher', erpId: voucherNumber });
    map.localId = voucherNumber;
    map.erpCode = stop.creditNoteNumber!;
    await em.getRepository(ErpIdMap).save(map);

    // Against a CashVan sale: what it took back is no longer returnable there.
    if (sale) await this.consumeReturnable(em, sale.voucherNumber, voucher.lines);

    await this.linkStop(em, stop.id, voucherNumber, header.id);
    return { status: 'created', voucherNumber, voucherId: header.id, repSource: rep.source };
  }

  private async linkStop(em: EntityManager, stopId: string, voucherNumber: string, voucherId: string): Promise<void> {
    await em.query(
      `UPDATE delivery_stops SET return_voucher_number = $2, return_voucher_id = $3
        WHERE id = $1 AND return_voucher_number IS DISTINCT FROM $2`,
      [stopId, voucherNumber, voucherId],
    );
  }

  /**
   * The CashVan SALE the invoice came from, if any: a van sale pushed to the
   * ERP, or the `ERP-` sale an invoiced order became. Both are id-mapped to the
   * ERP invoice number.
   */
  private async originalSale(
    em: EntityManager,
    invoiceNumber: string | null,
  ): Promise<{ voucherNumber: string; userCode: string } | null> {
    if (!invoiceNumber) return null;
    const rows: Array<{ voucher_number: string; user_code: string }> = await em.query(
      `SELECT h.voucher_number, h.user_code
         FROM erp_id_map m
         JOIN voucher_headers h ON h.voucher_number = m.local_id AND h.trans_kind = 'SALE' AND h.deleted_at IS NULL
        WHERE m.entity = 'voucher' AND m.erp_code = $1
        ORDER BY h.created_at
        LIMIT 1`,
      [invoiceNumber],
    );
    return rows[0] ? { voucherNumber: rows[0].voucher_number, userCode: rows[0].user_code } : null;
  }

  /** The rep the ERP invoice is credited to in the invoice mirror, else the one its salesman name names. */
  private async invoiceRep(em: EntityManager, erpInvoiceId: string | null): Promise<RepCandidate | null> {
    if (!erpInvoiceId) return null;
    const rows: Array<{ rep_id: string | null; salesman_name: string | null }> = await em.query(
      `SELECT rep_id, salesman_name FROM erp_invoices WHERE erp_id = $1 AND deleted_at IS NULL`,
      [erpInvoiceId],
    );
    const inv = rows[0];
    if (!inv) return null;
    if (inv.rep_id) return this.repById(em, inv.rep_id);
    if (!inv.salesman_name) return null;
    const byName: Array<{ id: string }> = await em.query(
      `SELECT id FROM reps WHERE deleted_at IS NULL AND (name_ar = $1 OR name_en = $1) LIMIT 2`,
      [inv.salesman_name],
    );
    return byName.length === 1 ? this.repById(em, byName[0].id) : null;
  }

  private async repById(em: EntityManager, id: string): Promise<RepCandidate | null> {
    return this.repWhere(em, `r.id = $1`, id);
  }

  private async repByCode(em: EntityManager, code: string): Promise<RepCandidate | null> {
    return this.repWhere(em, `r.code = $1`, code);
  }

  private async repWhere(em: EntityManager, cond: string, v: string): Promise<RepCandidate | null> {
    const rows: Array<{ id: string; code: string | null; kind: string; is_active: boolean; has_login: boolean }> = await em.query(
      `SELECT r.id, r.code, r.kind, r.is_active,
              EXISTS (SELECT 1 FROM users u WHERE u.user_number = r.code) AS has_login
         FROM reps r WHERE ${cond} AND r.deleted_at IS NULL LIMIT 1`,
      [v],
    );
    const r = rows[0];
    return r ? { id: r.id, code: r.code, kind: r.kind, isActive: r.is_active, hasLogin: r.has_login } : null;
  }

  /** ERP SKU → CashVan item, as the ERP mirror resolves it (unit SKU first, then the item map, then the number). */
  private async itemForSku(
    em: EntityManager,
    sku: string,
  ): Promise<{ itemNumber: string; itemName: string; itemUnitId: string | null } | null> {
    const unit: Array<{ id: string; item_number: string; name: string }> = await em.query(
      `SELECT iu.id, ic.item_number, COALESCE(NULLIF(ic.name_ar, ''), ic.item_name) AS name
         FROM item_units iu JOIN item_cart ic ON ic.id = iu.item_id
        WHERE iu.erp_sku_code = $1 LIMIT 1`,
      [sku],
    );
    if (unit[0]) return { itemNumber: unit[0].item_number, itemName: unit[0].name, itemUnitId: unit[0].id };
    const item: Array<{ item_number: string; name: string }> = await em.query(
      `SELECT ic.item_number, COALESCE(NULLIF(ic.name_ar, ''), ic.item_name) AS name
         FROM item_cart ic
        WHERE ic.item_number = COALESCE(
                (SELECT m.local_id FROM erp_id_map m WHERE m.entity = 'item' AND m.erp_code = $1 LIMIT 1), $1)
        LIMIT 1`,
      [sku],
    );
    return item[0] ? { itemNumber: item[0].item_number, itemName: item[0].name, itemUnitId: null } : null;
  }

  /** Charge the returned quantity against the source sale's lines, oldest line first, never past what was sold. */
  private async consumeReturnable(
    em: EntityManager,
    saleNumber: string,
    lines: Array<{ itemNumber: string; itemQty: string }>,
  ): Promise<void> {
    for (const l of lines) {
      let left = Number(l.itemQty);
      const rows: Array<{ id: string; remaining: string }> = await em.query(
        `SELECT id::text, (item_qty - qty_returned) AS remaining
           FROM voucher_transactions
          WHERE voucher_number = $1 AND item_number = $2 AND qty_returned < item_qty
          ORDER BY id FOR UPDATE`,
        [saleNumber, l.itemNumber],
      );
      for (const r of rows) {
        if (left <= 1e-9) break;
        const take = Math.min(left, Number(r.remaining));
        await em.query(`UPDATE voucher_transactions SET qty_returned = qty_returned + $2 WHERE id = $1::uuid`, [r.id, take]);
        left -= take;
      }
    }
  }
}
