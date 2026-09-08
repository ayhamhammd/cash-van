import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * One invoice raised in the ERP, mirrored here so the rep is credited for it.
 *
 * Money is fils throughout, like every other amount in this database — the ERP
 * serves major units and the sync scales them once, on the way in.
 */
@Entity({ name: 'erp_invoices' })
@Index('uq_erp_invoices_erp_id', ['erpId'], { unique: true })
@Index('idx_erp_invoices_rep_date', ['repId', 'issuedAt'])
@Index('idx_erp_invoices_customer', ['customerId'])
export class ErpInvoice extends BaseEntity {
  /** The ERP's invoice id — the identity a re-sync recognises. */
  @Column({ name: 'erp_id', type: 'text' })
  erpId!: string;

  @Column({ name: 'invoice_number', type: 'text', nullable: true })
  invoiceNumber?: string | null;

  @Column({ name: 'issued_at', type: 'timestamptz' })
  issuedAt!: Date;

  @Column({ name: 'erp_customer_id', type: 'text', nullable: true })
  erpCustomerId?: string | null;

  /** The local customer, when this ERP customer is mirrored here. */
  @Column({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId?: string | null;

  /**
   * The rep credited with this sale, resolved from the customer's assignment
   * AT SYNC TIME and stored.
   *
   * Deliberately not a join at read time: reassigning a customer tomorrow must
   * not rewrite last month's achieved figure for the rep who actually did the
   * work, and a target that changes retrospectively is one nobody can be paid
   * against.
   */
  @Column({ name: 'rep_id', type: 'uuid', nullable: true })
  repId?: string | null;

  /** Who the ERP says sold it, snapshotted on the document. Display only. */
  @Column({ name: 'salesman_name', type: 'text', nullable: true })
  salesmanName?: string | null;

  /**
   * CASH or CREDIT, as the ERP recorded it.
   *
   * Commission is paid at different rates for the two, so this decides which
   * rate a mirrored invoice earns. Null when an older ERP did not report it —
   * treated as CREDIT (the lower rate), because guessing in the salesman's
   * favour is how commission gets overpaid without anyone noticing.
   */
  @Column({ name: 'payment_type', type: 'text', nullable: true })
  paymentType?: string | null;

  /** issued | partially_paid | paid | voided — the ERP's own vocabulary. */
  @Column({ type: 'text', nullable: true })
  status?: string | null;

  /**
   * ERP = raised in the ERP. VAN_SALES = pushed here by cash-van.
   *
   * A VAN_SALES row is never stored (the voucher it came from is already in this
   * database and already counts), but the column exists so that decision is
   * auditable rather than an invisible filter in the sync.
   */
  @Column({ type: 'text', default: 'ERP' })
  origin!: string;

  @Column({ name: 'total_fils', type: 'bigint', default: 0 })
  totalFils!: string;

  @Column({ name: 'tax_fils', type: 'bigint', default: 0 })
  taxFils!: string;

  @Column({ name: 'paid_fils', type: 'bigint', default: 0 })
  paidFils!: string;

  @Column({ name: 'synced_at', type: 'timestamptz', nullable: true })
  syncedAt?: Date | null;
}
