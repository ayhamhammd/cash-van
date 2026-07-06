import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { ErpHttpClient } from '../erp-sync/erp-http.client';
import { ErpIdMap } from '../erp-sync/entities/erp-id-map.entity';
import { Customer } from '../customers/entities/customer.entity';
import { Rep } from '../reps/entities/rep.entity';

export type AgingBasis = 'due' | 'invoice';

export interface AgingBuckets {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
}

export interface OrgAgingRow {
  customerId: string;
  customerCode: string | null;
  customerName: string;
  totalOpen: number;
  overdue: number;
  buckets: AgingBuckets;
}

export interface OrgAgingResponse {
  data?: OrgAgingRow[];
  pagination?: { page: number; pageSize: number; total: number; totalPages?: number; hasMore?: boolean };
  summary?: {
    asOf: string;
    basis: AgingBasis;
    totalOpen: number;
    totalOverdue: number;
    buckets: AgingBuckets;
    customerCount: number;
  };
}

/**
 * Accounts receivable (debt / ذمم) read model. The ERP is the source of truth for the
 * balance + aging (docs/SPEC-accounts-receivable.md); this service proxies the ERP AR
 * endpoints (so the van + dashboard use one base URL) and computes the local
 * arrears / monthly-collection widget from mirrored data. All money in JOD major units.
 */
@Injectable()
export class ArService {
  private readonly logger = new Logger('AR');

  constructor(
    private readonly erp: ErpHttpClient,
    @InjectRepository(ErpIdMap) private readonly idmap: Repository<ErpIdMap>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    @InjectRepository(Rep) private readonly reps: Repository<Rep>,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  /** Resolve a local customerNumber → the ERP customer id (via the id-map). */
  private async erpCustomerId(customerNumber: string): Promise<string | null> {
    const m = await this.idmap.findOne({
      where: { entity: 'customer', localId: customerNumber },
    });
    return m?.erpId ?? null;
  }

  /** Org-wide aging (proxied from ERP), enriched with the local assigned rep. */
  async orgAging(q: {
    basis: AgingBasis;
    asOf?: string;
    warehouseCode?: string;
    page: number;
    pageSize: number;
  }): Promise<OrgAgingResponse & { stale?: boolean }> {
    let body: OrgAgingResponse;
    try {
      body = await this.erp.getJson<OrgAgingResponse>('ar/aging', {
        basis: q.basis,
        asOf: q.asOf,
        warehouseCode: q.warehouseCode,
        page: q.page,
        pageSize: q.pageSize,
      });
    } catch (err) {
      this.logger.warn(`orgAging ERP fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return { data: [], pagination: { page: q.page, pageSize: q.pageSize, total: 0 }, stale: true };
    }

    // Enrich with the local rep assignment (name) by customerNumber = ERP code.
    const rows = body.data ?? [];
    const codes = rows.map((r) => r.customerCode).filter((c): c is string => !!c);
    const repByCustomer = new Map<string, { repId: string | null; repName: string | null }>();
    if (codes.length) {
      const custs = await this.customers.find({
        where: codes.map((code) => ({ customerNumber: code })),
        select: ['customerNumber', 'repId'],
      });
      const repIds = [...new Set(custs.map((c) => c.repId).filter((r): r is string => !!r))];
      const reps = repIds.length ? await this.reps.find({ where: { id: In(repIds) } }) : [];
      const repName = new Map(reps.map((r) => [r.id, (r as unknown as { name?: string }).name ?? null]));
      for (const c of custs) {
        repByCustomer.set(c.customerNumber, {
          repId: c.repId ?? null,
          repName: c.repId ? (repName.get(c.repId) ?? null) : null,
        });
      }
    }

    return {
      ...body,
      data: rows.map((r) => ({
        ...r,
        ...(r.customerCode ? repByCustomer.get(r.customerCode) ?? { repId: null, repName: null } : { repId: null, repName: null }),
      })),
    };
  }

  /** Single-customer aging, proxied from ERP with a local balance fallback. */
  async customerAging(customerNumber: string, basis: AgingBasis, asOf?: string) {
    const erpId = await this.erpCustomerId(customerNumber);
    const qs = `basis=${basis}${asOf ? `&asOf=${asOf}` : ''}`;
    const path = erpId
      ? `customers/${erpId}/aging?${qs}`
      : `customers/by-code/${encodeURIComponent(customerNumber)}/aging?${qs}`;
    try {
      const data = await this.erp.getOne<Record<string, unknown>>(path);
      if (data) return data;
    } catch (err) {
      this.logger.warn(`customerAging ERP fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.localBalanceFallback(customerNumber, basis, asOf);
  }

  /** Live balance + available credit, proxied from ERP with a local fallback. */
  async customerBalance(customerNumber: string) {
    const erpId = await this.erpCustomerId(customerNumber);
    const path = erpId
      ? `customers/${erpId}/balance`
      : `customers/by-code/${encodeURIComponent(customerNumber)}/balance`;
    try {
      const data = await this.erp.getOne<{ balance: number; creditLimit: number }>(path);
      if (data) {
        return {
          ...data,
          available: (data.creditLimit ?? 0) - (data.balance ?? 0),
          stale: false,
        };
      }
    } catch (err) {
      this.logger.warn(`customerBalance ERP fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const cust = await this.customers.findOne({ where: { customerNumber } });
    const balance = Number(cust?.totalDebt ?? 0);
    const creditLimit = Number(cust?.creditLimit ?? 0);
    return {
      customerCode: customerNumber,
      balance,
      creditLimit,
      available: creditLimit - balance,
      creditHold: cust?.creditHold ?? false,
      stale: true,
    };
  }

  private async localBalanceFallback(customerNumber: string, basis: AgingBasis, asOf?: string) {
    const cust = await this.customers.findOne({ where: { customerNumber } });
    const balance = Number(cust?.totalDebt ?? 0);
    const creditLimit = Number(cust?.creditLimit ?? 0);
    return {
      customerCode: customerNumber,
      customerName: cust?.customerName ?? customerNumber,
      basis,
      asOf: asOf ?? new Date().toISOString().slice(0, 10),
      creditLimit,
      creditHold: cust?.creditHold ?? false,
      balance,
      available: creditLimit - balance,
      buckets: null, // no per-invoice detail offline — the ERP owns aging
      invoices: [],
      stale: true,
    };
  }

  /**
   * Dashboard arrears / monthly-collection widget. Monthly credit-sold + collected come
   * from local vouchers + collections; the arrears list (past-due customers) comes from
   * the ERP org aging (capped) with a local total-debt fallback. `month` = YYYY-MM.
   */
  async arrearsSummary(month?: string) {
    const now = new Date();
    const ym = month && /^\d{4}-\d{2}$/.test(month)
      ? month
      : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const start = `${ym}-01`;
    const [y, m] = ym.split('-').map(Number);
    const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;

    // Local monthly figures (JOD major).
    const soldRows: Array<{ credit_sold: string }> = await this.ds.query(
      `SELECT COALESCE(SUM(p.amount),0)::text AS credit_sold
         FROM payments p
         JOIN voucher_headers h ON h.voucher_number = p.voucher_number
        WHERE p.payment_type = 'CREDIT' AND h.trans_kind = 'SALE'
          AND h.created_at >= $1::date AND h.created_at < $2::date`,
      [start, nextMonth],
    );
    const collectedRows: Array<{ collected_fils: string }> = await this.ds.query(
      `SELECT COALESCE(SUM(amount),0)::text AS collected_fils
         FROM collections
        WHERE status IN ('confirmed','deposited')
          AND collected_at >= $1::date AND collected_at < $2::date`,
      [start, nextMonth],
    );
    const creditSold = Number(soldRows[0]?.credit_sold ?? 0);
    const collected = Number(collectedRows[0]?.collected_fils ?? 0) / 1000; // fils → JOD

    // Total receivable (local mirror of ERP balance).
    const totalRows: Array<{ total_debt: string }> = await this.ds.query(
      `SELECT COALESCE(SUM(total_debt),0)::text AS total_debt FROM customers WHERE total_debt > 0`,
    );
    const totalReceivable = Number(totalRows[0]?.total_debt ?? 0);

    // Arrears list — prefer ERP overdue (past-due), fall back to local total-debt.
    let arrears: Array<{
      customerNumber: string; customerName: string; balance: number;
      overdue: number | null; repId: string | null;
    }> = [];
    let stale = false;
    try {
      const aging = await this.erp.getJson<OrgAgingResponse>('ar/aging', {
        basis: 'due', page: 1, pageSize: 200,
      });
      const overdueRows = (aging.data ?? []).filter((r) => (r.overdue ?? 0) > 0);
      arrears = await this.attachLocal(overdueRows.map((r) => ({
        customerCode: r.customerCode, customerName: r.customerName,
        balance: r.totalOpen, overdue: r.overdue,
      })));
    } catch {
      stale = true;
      const owing = await this.customers.find({
        where: {},
        order: { totalDebt: 'DESC' },
        take: 50,
      });
      arrears = owing
        .filter((c) => Number(c.totalDebt) > 0)
        .map((c) => ({
          customerNumber: c.customerNumber,
          customerName: c.customerName,
          balance: Number(c.totalDebt),
          overdue: null,
          repId: c.repId ?? null,
        }));
    }

    return {
      month: ym,
      creditSold,
      collected,
      collectionRatio: creditSold > 0 ? Number((collected / creditSold).toFixed(3)) : null,
      totalReceivable,
      arrearsCount: arrears.length,
      arrears,
      stale,
    };
  }

  private async attachLocal(
    rows: Array<{ customerCode: string | null; customerName: string; balance: number; overdue: number | null }>,
  ) {
    const codes = rows.map((r) => r.customerCode).filter((c): c is string => !!c);
    const custs = codes.length
      ? await this.customers.find({ where: codes.map((code) => ({ customerNumber: code })), select: ['customerNumber', 'repId'] })
      : [];
    const repByNumber = new Map(custs.map((c) => [c.customerNumber, c.repId ?? null]));
    return rows.map((r) => ({
      customerNumber: r.customerCode ?? '',
      customerName: r.customerName,
      balance: r.balance,
      overdue: r.overdue,
      repId: r.customerCode ? repByNumber.get(r.customerCode) ?? null : null,
    }));
  }
}
