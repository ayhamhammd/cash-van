import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Generates sequential invoice numbers `INV-{YYYY}-{NNNNNN}`.
 *
 * Backed by a global Postgres sequence (`invoice_number_seq`), so numbering is
 * gap-free-ish and concurrency-safe without app-side locking. The year prefix
 * is cosmetic; the sequence itself is monotonic across years, which keeps
 * numbers strictly increasing (an ISTD-friendly property).
 */
@Injectable()
export class InvoiceNumberService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async next(): Promise<string> {
    const rows = (await this.ds.query(
      `SELECT nextval('invoice_number_seq') AS seq`,
    )) as Array<{ seq: string }>;
    const seq = Number(rows[0].seq);
    const year = new Date().getFullYear();
    return `INV-${year}-${String(seq).padStart(6, '0')}`;
  }
}
