import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** One customer's outstanding count of one kind of container. */
export interface ContainerBalanceRow {
  customerNumber: string;
  customerName: string | null;
  containerItemNumber: string;
  containerName: string | null;
  /** Positive = the customer is holding this many. */
  outstanding: number;
  /** When the oldest still-unreturned container went out — what the office chases. */
  oldestOutAt: string | null;
  lastMovementAt: string | null;
  /** The rep who last moved this customer's packaging: who to ask. */
  lastUserCode: string | null;
  /** Whole days since `oldestOutAt`. Null when nothing is out. */
  daysOutstanding: number | null;
}

/** Totals for one kind of container across every customer. */
export interface ContainerTotalRow {
  containerItemNumber: string;
  containerName: string | null;
  outstanding: number;
  customers: number;
}

export interface ContainerBalanceQuery {
  customerNumber?: string;
  containerItemNumber?: string;
  /** Restrict to the containers this rep's customers hold. */
  userCode?: string;
  /** Only rows older than this many days — the chase list. */
  minDaysOutstanding?: number;
  limit?: number;
  offset?: number;
}

/**
 * What customers are still holding, read from the `container_balances` view.
 *
 * The view is the single definition of the figure (see migration
 * ReturnableContainers): what a sale implied, plus what was lent, minus what
 * came back. Nothing here recomputes it — a second implementation of the same
 * arithmetic is exactly how the dashboard and the handset would start
 * disagreeing about how many buckets a customer has.
 *
 * Read-only by design. Containers move by posting a CONTAINER_IN or
 * CONTAINER_OUT voucher through VouchersService, which is where the permission
 * and the container-only line check live.
 */
@Injectable()
export class ContainersService {
  constructor(private readonly dataSource: DataSource) {}

  async balances(q: ContainerBalanceQuery = {}): Promise<ContainerBalanceRow[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    const bind = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };

    if (q.customerNumber) where.push(`cb.customer_number = ${bind(q.customerNumber)}`);
    if (q.containerItemNumber) {
      where.push(`cb.container_item_number = ${bind(q.containerItemNumber)}`);
    }
    if (q.userCode) where.push(`cb.last_user_code = ${bind(q.userCode)}`);
    // A customer who has returned everything is not interesting, and the view
    // already drops a net zero. Only a POSITIVE balance is something owed; a
    // negative one means more came back than went out, which is a data question
    // for the office rather than a chase, so it is shown but never aged.
    if (q.minDaysOutstanding != null) {
      where.push(
        `cb.oldest_out_at IS NOT NULL AND cb.oldest_out_at <= now() - make_interval(days => ${bind(
          q.minDaysOutstanding,
        )})`,
      );
    }

    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT cb.customer_number,
              c.customer_name,
              cb.container_item_number,
              COALESCE(i.name_ar, i.item_name) AS container_name,
              cb.outstanding,
              cb.oldest_out_at,
              cb.last_movement_at,
              cb.last_user_code,
              CASE WHEN cb.oldest_out_at IS NULL THEN NULL
                   ELSE FLOOR(EXTRACT(EPOCH FROM (now() - cb.oldest_out_at)) / 86400)::int
              END AS days_outstanding
         FROM container_balances cb
         LEFT JOIN customers c ON c.customer_number = cb.customer_number
         LEFT JOIN item_cart i ON i.item_number     = cb.container_item_number
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY cb.outstanding DESC, cb.customer_number
        LIMIT ${bind(Math.min(q.limit ?? 200, 1000))}
       OFFSET ${bind(q.offset ?? 0)}`,
      params,
    );
    return rows.map((r) => ({
      customerNumber: String(r.customer_number),
      customerName: (r.customer_name as string) ?? null,
      containerItemNumber: String(r.container_item_number),
      containerName: (r.container_name as string) ?? null,
      outstanding: Number(r.outstanding),
      oldestOutAt: r.oldest_out_at ? new Date(r.oldest_out_at as string).toISOString() : null,
      lastMovementAt: r.last_movement_at
        ? new Date(r.last_movement_at as string).toISOString()
        : null,
      lastUserCode: (r.last_user_code as string) ?? null,
      daysOutstanding: r.days_outstanding == null ? null : Number(r.days_outstanding),
    }));
  }

  /** One line per kind of container: how many are out, and with how many customers. */
  async totals(userCode?: string): Promise<ContainerTotalRow[]> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT cb.container_item_number,
              COALESCE(i.name_ar, i.item_name)     AS container_name,
              SUM(cb.outstanding)::numeric(14,3)   AS outstanding,
              COUNT(DISTINCT cb.customer_number)::int AS customers
         FROM container_balances cb
         LEFT JOIN item_cart i ON i.item_number = cb.container_item_number
        ${userCode ? 'WHERE cb.last_user_code = $1' : ''}
        GROUP BY cb.container_item_number, COALESCE(i.name_ar, i.item_name)
        ORDER BY 3 DESC`,
      userCode ? [userCode] : [],
    );
    return rows.map((r) => ({
      containerItemNumber: String(r.container_item_number),
      containerName: (r.container_name as string) ?? null,
      outstanding: Number(r.outstanding),
      customers: Number(r.customers),
    }));
  }

  /**
   * What one customer is holding — the figure the rep needs BEFORE knocking.
   *
   * Returns a row per container kind, and an empty array when they hold
   * nothing. Deliberately the same shape as [balances] so the app has one
   * parser.
   */
  async forCustomer(customerNumber: string): Promise<ContainerBalanceRow[]> {
    return this.balances({ customerNumber, limit: 100 });
  }
}
