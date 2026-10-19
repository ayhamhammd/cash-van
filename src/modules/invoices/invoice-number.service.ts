import { Injectable } from '@nestjs/common';

import { TenantCounters } from '../../common/tenancy/tenant-counters.service';

/**
 * Generates sequential invoice numbers `INV-{YYYY}-{NNNNNN}`.
 *
 * Backed by a per-tenant counter rather than a global Postgres sequence: a
 * sequence is shared database-wide, so a second company's first invoice would
 * continue the first company's numbering. The year prefix is cosmetic; the
 * counter is monotonic across years, which keeps numbers strictly increasing
 * (an ISTD-friendly property).
 */
@Injectable()
export class InvoiceNumberService {
  constructor(private readonly counters: TenantCounters) {}

  async next(): Promise<string> {
    const seq = await this.counters.next('invoice');
    const year = new Date().getFullYear();
    return `INV-${year}-${String(seq).padStart(6, '0')}`;
  }
}
