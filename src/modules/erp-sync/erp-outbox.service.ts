import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';

import { VoucherHeader } from '../vouchers/entities/voucher-header.entity';
import { VoucherTransaction } from '../vouchers/entities/voucher-transaction.entity';
import { SettingsService } from '../settings/settings.service';
import { ErpHttpClient } from './erp-http.client';
import { ErpIdMap } from './entities/erp-id-map.entity';
import {
  ErpOutbox,
  ErpOutboxKind,
  ErpOutboxStatus,
} from './entities/erp-outbox.entity';

const MAX_ATTEMPTS = 6;
const BATCH = 20;

@Injectable()
export class ErpOutboxService {
  private readonly logger = new Logger(ErpOutboxService.name);
  private draining = false;

  constructor(
    private readonly erp: ErpHttpClient,
    private readonly settings: SettingsService,
    @InjectRepository(ErpOutbox) private readonly outbox: Repository<ErpOutbox>,
    @InjectRepository(ErpIdMap) private readonly idmap: Repository<ErpIdMap>,
    @InjectRepository(VoucherHeader) private readonly headers: Repository<VoucherHeader>,
    @InjectRepository(VoucherTransaction) private readonly lines: Repository<VoucherTransaction>,
  ) {}

  /** Queue a van document for push to the ERP (best-effort; never throws to the caller). */
  async enqueue(kind: ErpOutboxKind, ref: string): Promise<void> {
    try {
      const existing = await this.outbox.findOne({ where: { kind, ref } });
      if (existing && existing.status !== 'failed' && existing.status !== 'dead_letter') return;
      const row = existing ?? this.outbox.create({ kind, ref });
      row.status = 'pending';
      row.nextAttemptAt = new Date();
      await this.outbox.save(row);
    } catch (e) {
      this.logger.warn(`enqueue ${kind} ${ref} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  list(status?: ErpOutboxStatus): Promise<ErpOutbox[]> {
    return this.outbox.find({
      where: status ? { status } : {},
      order: { createdAt: 'DESC' },
      take: 200,
    });
  }

  async retry(id: string): Promise<ErpOutbox> {
    const row = await this.outbox.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Outbox item ${id} not found`);
    if (row.status === 'posted') return row;
    row.status = 'pending';
    row.nextAttemptAt = new Date();
    await this.outbox.save(row);
    await this.pushOne(row);
    return this.outbox.findOneByOrFail({ id });
  }

  /** Drain due rows every 30s when ERP mode is on. */
  @Interval(30000)
  async drain(): Promise<void> {
    if (this.draining) return;
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled || !cfg.baseUrl || !cfg.apiKey) return;
    this.draining = true;
    try {
      const due = await this.outbox.find({
        where: { status: 'pending', nextAttemptAt: LessThanOrEqual(new Date()) },
        order: { createdAt: 'ASC' },
        take: BATCH,
      });
      for (const row of due) await this.pushOne(row);
    } finally {
      this.draining = false;
    }
  }

  private async pushOne(row: ErpOutbox): Promise<void> {
    try {
      const built = await this.buildPayload(row);
      if (!built) {
        return this.fail(row, 'payload could not be built (source missing)');
      }
      const res = await this.erp.post(built.path, built.body, row.ref);
      if (res.ok) {
        row.status = 'posted';
        row.error = null;
        row.resultRef = this.extractResultRef(res.data);
        await this.outbox.save(row);
        if (row.kind === 'SALE_INVOICE' && row.resultRef) {
          await this.mapVoucher(row.ref, row.resultRef);
        }
        return;
      }
      await this.fail(row, res.error ?? 'ERP rejected the document');
    } catch (e) {
      await this.fail(row, e instanceof Error ? e.message : String(e));
    }
  }

  private async fail(row: ErpOutbox, error: string): Promise<void> {
    row.attempts += 1;
    row.error = error;
    if (row.attempts >= MAX_ATTEMPTS) {
      row.status = 'dead_letter';
    } else {
      row.status = 'pending';
      const backoffMs = Math.min(60_000 * row.attempts * row.attempts, 3_600_000);
      row.nextAttemptAt = new Date(Date.now() + backoffMs);
    }
    await this.outbox.save(row);
    this.logger.warn(`outbox ${row.kind} ${row.ref} attempt ${row.attempts}: ${error}`);
  }

  /** Build the ERP request for a queued document, or null if its source is gone. */
  private async buildPayload(
    row: ErpOutbox,
  ): Promise<{ path: string; body: Record<string, unknown> } | null> {
    if (row.kind === 'SALE_INVOICE') return this.buildSale(row.ref);
    if (row.kind === 'SALES_RETURN') return this.buildReturn(row.ref);
    return null; // PAYMENT: next increment
  }

  private async buildSale(
    voucherNumber: string,
  ): Promise<{ path: string; body: Record<string, unknown> } | null> {
    const header = await this.headers.findOne({ where: { voucherNumber } });
    if (!header) return null;
    const lines = await this.lines.find({ where: { voucherNumber } });
    return {
      path: 'sales-invoices',
      body: {
        externalId: voucherNumber,
        deviceId: header.userCode,
        customerCode: header.customerNumber ?? undefined,
        invoiceDate: header.inDate,
        items: lines.map((l) => ({
          skuCode: l.itemNumber, // cash-van item_number == ERP sku (set on inbound sync)
          quantity: Number(l.itemQty) || 0,
          unitPrice: Number(l.unitPrice) || 0, // JOD major decimal — ERP expects decimal
          discount: Number(l.discountValue) || 0,
        })),
      },
    };
  }

  private async buildReturn(
    voucherNumber: string,
  ): Promise<{ path: string; body: Record<string, unknown> } | null> {
    const header = await this.headers.findOne({ where: { voucherNumber } });
    if (!header) return null;
    // The ERP needs the ORIGINAL ERP invoice number; resolve it from the
    // referenced sale's push result.
    const ref = header.referenceVoucherNumber;
    if (!ref) return null;
    const map = await this.idmap.findOne({ where: { entity: 'voucher', localId: ref } });
    const originalInvoiceNumber = map?.erpCode ?? ref;
    const lines = await this.lines.find({ where: { voucherNumber } });
    return {
      path: 'sales-returns',
      body: {
        externalId: voucherNumber,
        deviceId: header.userCode,
        customerCode: header.customerNumber ?? undefined,
        originalInvoiceNumber,
        lines: lines.map((l) => ({
          skuCode: l.itemNumber,
          quantity: Number(l.itemQty) || 0,
        })),
      },
    };
  }

  private extractResultRef(data: unknown): string | null {
    if (data && typeof data === 'object') {
      const d = (data as Record<string, unknown>).data as Record<string, unknown> | undefined;
      const num = d?.invoiceNumber ?? d?.returnNumber ?? d?.paymentId;
      if (typeof num === 'string') return num;
    }
    return null;
  }

  private async mapVoucher(voucherNumber: string, erpInvoiceNumber: string): Promise<void> {
    let m = await this.idmap.findOne({ where: { entity: 'voucher', erpId: voucherNumber } });
    if (!m) m = this.idmap.create({ entity: 'voucher', erpId: voucherNumber });
    m.localId = voucherNumber;
    m.erpCode = erpInvoiceNumber;
    await this.idmap.save(m);
  }
}
