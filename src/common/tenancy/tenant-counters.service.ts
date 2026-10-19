import { Injectable } from '@nestjs/common';

import { TenantDataSource } from './tenant-data-source.service';

/** Counter names. Adding one here is all a new document series needs. */
export type CounterName = 'invoice' | 'credit_note' | 'customer' | 'vendor';

/**
 * Per-tenant document numbering.
 *
 * Replaces the global Postgres sequences these numbers used to come from. A
 * sequence is shared by the whole database, so tenant B's first invoice would
 * pick up wherever tenant A had left off — visible, unexplainable gaps in a
 * document series an accountant has to reconcile.
 *
 * The increment is a single statement, so it is atomic. The row lock it takes
 * is held to the end of the request transaction, which serialises concurrent
 * numbering within a tenant — exactly what gap-free numbering requires, and no
 * contention at all between different tenants.
 */
@Injectable()
export class TenantCounters {
  constructor(private readonly ds: TenantDataSource) {}

  /** Next value in this tenant's series, starting at 1. */
  async next(name: CounterName): Promise<number> {
    // tenant_id is omitted deliberately: its column default resolves to the
    // caller's tenant, and the row-level security policy rejects anything else.
    const rows: { value: string }[] = await this.ds.query(
      `
      INSERT INTO "tenant_counters" ("name", "value")
      VALUES ($1, 1)
      ON CONFLICT ("tenant_id", "name")
      DO UPDATE SET "value" = "tenant_counters"."value" + 1
      RETURNING "value"
      `,
      [name],
    );
    return Number(rows[0].value);
  }
}
