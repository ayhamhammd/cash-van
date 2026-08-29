import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export type UserType = 'ADMIN' | 'MANAGER' | 'SALES' | 'DRIVER';
export type UserRole = 'admin' | 'manager' | 'supervisor' | 'viewer';

/**
 * Whether this user sees every salesman or only assigned ones.
 * 'all' is the default so existing users keep today's access — scoping only
 * applies when someone is deliberately switched. See docs/SPEC-rep-scoped-users.md.
 */
export type RepScopeMode = 'all' | 'assigned';

@Entity({ name: 'users' })
export class User extends BaseEntity {
  @Index('uq_users_user_number', { unique: true })
  @Column({ name: 'user_number', type: 'text' })
  userNumber!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ name: 'password_hash', type: 'text', select: false })
  passwordHash!: string;

  @Column({
    name: 'user_type',
    type: 'text',
    default: 'SALES',
  })
  userType!: UserType;

  @Column({ type: 'text', nullable: true })
  email?: string | null;

  @Column({ name: 'name_ar', type: 'text', nullable: true })
  nameAr?: string | null;

  @Column({ name: 'name_en', type: 'text', nullable: true })
  nameEn?: string | null;

  @Column({ type: 'text', default: 'viewer' })
  role!: UserRole;

  @Column({ name: 'region_id', type: 'uuid', nullable: true })
  regionId?: string | null;

  @Column({ name: 'avatar_url', type: 'text', nullable: true })
  avatarUrl?: string | null;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt?: Date | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  /** True for auto-provisioned salesman logins until they set their own password. */
  @Column({ name: 'must_change_password', type: 'boolean', default: false })
  mustChangePassword!: boolean;

  @Column({ name: 'can_make_voucher', type: 'boolean', default: false })
  canMakeVoucher!: boolean;

  /**
   * The three field actions split out of can_make_voucher so an admin can switch
   * each independently. SALE creation needs can_create_sale, RETURN creation needs
   * can_create_return, and recording a collection needs can_make_collection. The
   * salesman app hides the matching button on the customer screen when the flag is
   * off, and the API refuses regardless. ORDER (and any other kind) still rides
   * can_make_voucher. Migration backfills all three from can_make_voucher.
   */
  @Column({ name: 'can_create_sale', type: 'boolean', default: false })
  canCreateSale!: boolean;

  @Column({ name: 'can_create_return', type: 'boolean', default: false })
  canCreateReturn!: boolean;

  @Column({ name: 'can_make_collection', type: 'boolean', default: false })
  canMakeCollection!: boolean;

  @Column({ name: 'can_edit_voucher', type: 'boolean', default: false })
  canEditVoucher!: boolean;

  @Column({ name: 'can_add_customer', type: 'boolean', default: false })
  canAddCustomer!: boolean;

  /**
   * May this salesman create a customer that is REAL immediately?
   * False (the default) routes their creation through admin approval instead.
   * Meaningless without canAddCustomer, which decides whether they may create at all.
   */
  @Column({ name: 'rep_scope_mode', type: 'text', default: 'all' })
  repScopeMode!: RepScopeMode;

  /**
   * May this salesman's printed receipt show the discount on each row?
   * Off by default — a per-line discount on a slip left on a counter tells the
   * next customer what rate the last one got.
   */
  @Column({ name: 'can_print_line_discount', type: 'boolean', default: false })
  canPrintLineDiscount!: boolean;

  @Column({ name: 'can_create_customer_direct', type: 'boolean', default: false })
  canCreateCustomerDirect!: boolean;

  @Column({ name: 'can_edit_customer_credit', type: 'boolean', default: false })
  canEditCustomerCredit!: boolean;

  @Column({ name: 'can_add_items', type: 'boolean', default: false })
  canAddItems!: boolean;

  @Column({ name: 'can_edit_expiry', type: 'boolean', default: false })
  canEditExpiry!: boolean;

  /**
   * May this salesman ask for stock to be loaded onto their van?
   *
   * Off by default, like every other capability here. A rep who cannot request
   * simply has no such screen; the server refuses regardless, because the app
   * on a phone is not a place to enforce anything.
   */
  @Column({ name: 'can_request_stock', type: 'boolean', default: false })
  canRequestStock!: boolean;

  /**
   * May this user decide someone else's stock request?
   *
   * Separate from the admin/manager role on purpose: deciding what goes onto a
   * van is a warehouse job, and the person who does it is not always the person
   * who runs the office. Admins pass every gate regardless of this flag.
   */
  @Column({ name: 'can_approve_stock_request', type: 'boolean', default: false })
  canApproveStockRequest!: boolean;

  /**
   * Reveals the "find customers" screen on the salesman app — GPS prospecting
   * around the rep's own position.
   *
   * Enforced, not merely cosmetic: POST /prospecting/searches accepts
   * `canManageOffers` OR `canFindCustomers`, so a rep without either is refused
   * (403) even if they call the API directly. It also hides the app screen.
   */
  @Column({ name: 'can_find_customers', type: 'boolean', default: false })
  canFindCustomers!: boolean;

  /**
   * Route-only salesman: reaches customers ONLY through the day's route, so the
   * app hides the Customers list on the home screen. A workflow restriction, not
   * a security boundary — a rep still opens a customer from a route stop, so
   * there is nothing to fence server-side. Default false: nobody is restricted
   * on upgrade.
   */
  @Column({ name: 'routes_only', type: 'boolean', default: false })
  routesOnly!: boolean;

  /**
   * Granular dashboard permission keys (e.g. "vouchers.create", "items.edit").
   * The flexible, admin-managed permission set for dashboard users. Admin role
   * implicitly has everything regardless of this list.
   */
  @Column({ name: 'permissions', type: 'jsonb', default: () => "'[]'::jsonb" })
  permissions!: string[];
}
