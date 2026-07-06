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

  /**
   * Local receivables from the dashboard's OWN data (not the ERP proxy) — the full
   * customer account (ذمم) ledger. Credit SALE vouchers are debits; collections (cash +
   * cheque) and credit RETURN notes are credits:
   *   outstanding(customer) = Σ credit SALE − (Σ collections + Σ credit RETURNs)
   * The credits pay down the credit vouchers oldest-first (FIFO), so every voucher that
   * is still (partly) unpaid is listed — a customer shows up whenever they hold an unpaid
   * credit voucher, even with no collection recorded. Optional date range (`from`/`to`,
   * YYYY-MM-DD, applied to sales, collections and returns) and `customerNumber` filter
   * (number or name). Only customers with a remaining balance are returned.
   */
  async receivables(q: {
    from?: string;
    to?: string;
    customerNumber?: string;
  }): Promise<ReceivablesResult> {
    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : null;
    const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : null;
    const cust = q.customerNumber?.trim() || null;
    const params = [from, to, cust];

    // Credit SALE vouchers, one row per voucher (the debits), oldest-first.
    const saleRows: Array<{
      customerNumber: string; customerName: string;
      voucherNumber: string; createdAt: Date; amount: string;
    }> = await this.ds.query(
      `SELECT h.customer_number AS "customerNumber",
              COALESCE(c.customer_name, h.customer_number) AS "customerName",
              h.voucher_number AS "voucherNumber",
              h.created_at AS "createdAt",
              SUM(p.amount)::text AS amount
         FROM payments p
         JOIN voucher_headers h ON h.voucher_number = p.voucher_number
         LEFT JOIN customers c ON c.customer_number = h.customer_number
        WHERE p.payment_type = 'CREDIT' AND h.trans_kind = 'SALE'
          AND ($1::date IS NULL OR h.created_at >= $1::date)
          AND ($2::date IS NULL OR h.created_at < ($2::date + 1))
          AND ($3::text IS NULL OR h.customer_number = $3 OR c.customer_name ILIKE '%' || $3 || '%')
        GROUP BY h.customer_number, c.customer_name, h.voucher_number, h.created_at
        ORDER BY h.customer_number, h.created_at ASC`,
      params,
    );

    // Collections (cash + cheque) per customer — pay down the debit. Fils → JOD major.
    const collRows: Array<{ customerNumber: string; paid: string }> = await this.ds.query(
      `SELECT c.customer_number AS "customerNumber",
              (COALESCE(SUM(co.amount), 0)::numeric / 1000)::text AS paid
         FROM collections co
         JOIN customers c ON c.id = co.customer_id
        WHERE co.method IN ('cash', 'cheque') AND co.status IN ('confirmed', 'deposited')
          AND ($1::date IS NULL OR co.collected_at >= $1::date)
          AND ($2::date IS NULL OR co.collected_at < ($2::date + 1))
          AND ($3::text IS NULL OR c.customer_number = $3 OR c.customer_name ILIKE '%' || $3 || '%')
        GROUP BY c.customer_number`,
      params,
    );

    // Credit RETURN notes per customer — also credit the account (reduce the debit).
    const retRows: Array<{ customerNumber: string; returns: string }> = await this.ds.query(
      `SELECT h.customer_number AS "customerNumber", COALESCE(SUM(p.amount), 0)::text AS returns
         FROM payments p
         JOIN voucher_headers h ON h.voucher_number = p.voucher_number
         LEFT JOIN customers c ON c.customer_number = h.customer_number
        WHERE p.payment_type = 'CREDIT' AND h.trans_kind = 'RETURN'
          AND ($1::date IS NULL OR h.created_at >= $1::date)
          AND ($2::date IS NULL OR h.created_at < ($2::date + 1))
          AND ($3::text IS NULL OR h.customer_number = $3 OR c.customer_name ILIKE '%' || $3 || '%')
        GROUP BY h.customer_number`,
      params,
    );

    const collectedByCustomer = new Map<string, number>();
    for (const r of collRows) collectedByCustomer.set(r.customerNumber, Number(r.paid));
    const returnsByCustomer = new Map<string, number>();
    for (const r of retRows) returnsByCustomer.set(r.customerNumber, Number(r.returns));

    const byCustomer = new Map<
      string,
      { customerName: string; vouchers: Array<{ voucherNumber: string; date: Date; amount: number }> }
    >();
    for (const r of saleRows) {
      let e = byCustomer.get(r.customerNumber);
      if (!e) { e = { customerName: r.customerName, vouchers: [] }; byCustomer.set(r.customerNumber, e); }
      e.vouchers.push({ voucherNumber: r.voucherNumber, date: r.createdAt, amount: Number(r.amount) });
    }

    const customers: ReceivablesCustomer[] = [];
    let totalOutstanding = 0;
    for (const [customerNumber, e] of byCustomer) {
      const debit = e.vouchers.reduce((s, v) => s + v.amount, 0);
      const collected = collectedByCustomer.get(customerNumber) ?? 0;
      const returns = returnsByCustomer.get(customerNumber) ?? 0;
      // FIFO: collections + credit returns pay off the oldest credit vouchers first.
      let rem = collected + returns;
      const unpaidVouchers: ReceivablesVoucher[] = [];
      for (const v of e.vouchers) {
        if (rem >= v.amount - 1e-9) { rem -= v.amount; continue; }
        const unpaid = v.amount - Math.max(0, rem);
        rem = 0;
        unpaidVouchers.push({
          voucherNumber: v.voucherNumber,
          date: v.date,
          amount: Number(v.amount.toFixed(2)),
          unpaid: Number(unpaid.toFixed(2)),
        });
      }
      const outstanding = unpaidVouchers.reduce((s, v) => s + v.unpaid, 0);
      if (outstanding <= 0.005) continue;
      totalOutstanding += outstanding;
      customers.push({
        customerNumber,
        customerName: e.customerName,
        debit: Number(debit.toFixed(2)),
        collected: Number(collected.toFixed(2)),
        returns: Number(returns.toFixed(2)),
        outstanding: Number(outstanding.toFixed(2)),
        unpaidVouchers,
      });
    }
    customers.sort((a, b) => b.outstanding - a.outstanding);

    return {
      from,
      to,
      customerNumber: cust,
      totalOutstanding: Number(totalOutstanding.toFixed(2)),
      customerCount: customers.length,
      customers,
    };
  }
}

export interface ReceivablesVoucher {
  voucherNumber: string;
  date: Date;
  amount: number;
  unpaid: number;
}

export interface ReceivablesCustomer {
  customerNumber: string;
  customerName: string;
  debit: number;       // Σ credit sale vouchers
  collected: number;   // Σ collections cash+cheque
  returns: number;     // Σ credit return notes
  outstanding: number; // debit − collected − returns (FIFO), ≥ 0
  unpaidVouchers: ReceivablesVoucher[];
}

export interface ReceivablesResult {
  from: string | null;
  to: string | null;
  customerNumber: string | null;
  totalOutstanding: number;
  customerCount: number;
  customers: ReceivablesCustomer[];
}
