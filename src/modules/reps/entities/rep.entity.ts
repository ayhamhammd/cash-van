import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';

@Entity({ name: 'reps' })
export class Rep extends BaseEntity {
  // Unique partial index → at most one rep per user (NULLs unconstrained).
  // Index name matches the migration-managed index in the live DB.
  @Index('idx_reps_user_id', { unique: true, where: '"user_id" IS NOT NULL' })
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId?: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: User | null;

  /** Human salesman code (e.g. "S012") used by the mobile contract. Unique when set. */
  @Index('uq_reps_code', { unique: true, where: '"code" IS NOT NULL' })
  @Column({ type: 'text', nullable: true })
  code?: string | null;

  @Column({ name: 'name_ar', type: 'text' })
  nameAr!: string;

  @Column({ name: 'name_en', type: 'text', nullable: true })
  nameEn?: string | null;

  @Column({ type: 'text', nullable: true })
  phone?: string | null;

  @Index('idx_reps_region_id')
  @Column({ name: 'region_id', type: 'uuid', nullable: true })
  regionId?: string | null;

  @Column({ name: 'van_id', type: 'uuid', nullable: true })
  vanId?: string | null;

  @Index('idx_reps_is_active')
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'hire_date', type: 'date', nullable: true })
  hireDate?: string | null;

  @Column({ name: 'daily_quota_fils', type: 'integer', nullable: true })
  dailyQuotaFils?: number | null;

  /**
   * Commission rate as a percentage (0–100), applied to the rep's net-of-returns
   * sales in the commission report. Stored as a numeric; TypeORM hands numerics
   * back as strings, so read it through Number() at the call site.
   */
  @Column({ name: 'commission_pct', type: 'numeric', precision: 5, scale: 2, default: 0 })
  commissionPct!: string;

  /**
   * The rep's ERP GL account (chart-of-accounts id) — the "cash with salesman" account
   * that settlements post against. FlowVan-side link; a rep re-sync must not clobber it.
   * NULL ⇒ not linked (settle records but skips the ERP journal).
   * See docs/SPEC-rep-erp-accounts-settlement.md.
   */
  @Column({ name: 'erp_account_id', type: 'text', nullable: true })
  erpAccountId?: string | null;

  /** Snapshot of the ERP account code · name for display and journal memos. */
  @Column({ name: 'erp_account_code', type: 'text', nullable: true })
  erpAccountCode?: string | null;

  /**
   * Seat licensing: a frozen salesman exists but cannot sign in until an
   * activation key is entered for them.
   *
   * Defaults FALSE so every salesman that predates the feature — and every
   * salesman at a client who never turns it on — is unaffected. Only newly
   * provisioned reps are frozen, and only while
   * `app_settings.salesmanActivationEnabled` is on.
   */
  @Column({ name: 'is_frozen', type: 'boolean', default: false })
  isFrozen!: boolean;

  /**
   * How many days the rep's route cycle runs before repeating. 7 is the classic
   * week; 14 means an outlet scheduled on day 3 is visited once a fortnight.
   */
  @Column({ name: 'route_cycle_days', type: 'smallint', default: 7 })
  routeCycleDays!: number;

  /**
   * The calendar date that counts as day 0 of the cycle. Required for any
   * length other than 7: "day 3 of a fortnight" is meaningless without a
   * starting point, where "Wednesday" reads straight off the calendar.
   *
   * Defaults to a Sunday, which makes a 7-day cycle behave exactly like the
   * weekday scheme it replaced.
   */
  @Column({ name: 'route_cycle_anchor', type: 'date', default: () => `DATE '2024-01-07'` })
  routeCycleAnchor!: string;

  /** What the client calls this cycle. NULL ⇒ display falls back to "N days". */
  @Column({ name: 'route_cycle_name', type: 'text', nullable: true })
  routeCycleName?: string | null;

  @Column({ name: 'activated_at', type: 'timestamptz', nullable: true })
  activatedAt?: Date | null;

  /** Dashboard user who entered the key. */
  @Column({ name: 'activated_by', type: 'uuid', nullable: true })
  activatedBy?: string | null;
}
