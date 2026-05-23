import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import {
  LedgerDocumentKind,
  LedgerEntryType,
  TaxLedgerEntry,
} from './entities/tax-ledger-entry.entity';
import type { JoFotaraStatus } from '../invoices/entities/invoice.entity';

export interface PostEntryInput {
  entryType: LedgerEntryType;
  documentKind: LedgerDocumentKind;
  documentId: string;
  documentNumber: string;
  referenceDocumentNumber?: string | null;
  entryDate: string; // YYYY-MM-DD
  buyerName?: string | null;
  buyerTin?: string | null;
  taxableAmount: number; // fils, negative for returns
  taxAmount: number;
  grandTotal: number;
  jofotaraStatus: JoFotaraStatus;
  qrCode?: string | null;
}

export interface MonthlyTaxReport {
  periodFrom: string;
  periodTo: string;
  totalSalesFils: number;
  totalSalesTaxFils: number;
  totalReturnsFils: number; // negative
  totalReturnsTaxFils: number; // negative
  netOutputTaxFils: number; // payable to ISTD
  invoiceCount: number;
  creditNoteCount: number;
}

@Injectable()
export class TaxLedgerService {
  constructor(
    @InjectRepository(TaxLedgerEntry)
    private readonly ledger: Repository<TaxLedgerEntry>,
  ) {}

  /** Idempotent per (document_kind, document_id) thanks to the unique index. */
  async post(input: PostEntryInput): Promise<TaxLedgerEntry> {
    const existing = await this.ledger.findOne({
      where: { documentKind: input.documentKind, documentId: input.documentId },
    });
    if (existing) {
      Object.assign(existing, input);
      return this.ledger.save(existing);
    }
    return this.ledger.save(this.ledger.create(input));
  }

  async list(from?: string, to?: string, entryType?: LedgerEntryType): Promise<TaxLedgerEntry[]> {
    const qb = this.ledger.createQueryBuilder('e').orderBy('e.entry_date', 'DESC');
    if (from) qb.andWhere('e.entry_date >= :from', { from });
    if (to) qb.andWhere('e.entry_date <= :to', { to });
    if (entryType) qb.andWhere('e.entry_type = :t', { t: entryType });
    return qb.getMany();
  }

  /** Monthly net-output-tax report — VALIDATED entries only (port of spec §8). */
  async monthlyReport(year: number, month: number): Promise<MonthlyTaxReport> {
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const toDate = new Date(Date.UTC(year, month, 0)); // last day of month
    const to = toDate.toISOString().slice(0, 10);

    const entries = await this.ledger.find({
      where: { entryDate: Between(from, to), jofotaraStatus: 'VALIDATED' },
    });

    const sales = entries.filter((e) => e.entryType === 'SALE');
    const returns = entries.filter((e) => e.entryType === 'RETURN');
    const sum = (arr: TaxLedgerEntry[], f: (e: TaxLedgerEntry) => number) =>
      arr.reduce((a, e) => a + f(e), 0);

    const totalSalesTaxFils = sum(sales, (e) => e.taxAmount);
    const totalReturnsTaxFils = sum(returns, (e) => e.taxAmount); // negative

    return {
      periodFrom: from,
      periodTo: to,
      totalSalesFils: sum(sales, (e) => e.grandTotal),
      totalSalesTaxFils,
      totalReturnsFils: sum(returns, (e) => e.grandTotal),
      totalReturnsTaxFils,
      netOutputTaxFils: totalSalesTaxFils + totalReturnsTaxFils,
      invoiceCount: sales.length,
      creditNoteCount: returns.length,
    };
  }
}
