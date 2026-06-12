import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export type UserType = 'ADMIN' | 'MANAGER' | 'SALES' | 'DRIVER';
export type UserRole = 'admin' | 'manager' | 'supervisor' | 'viewer';

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

  @Column({ name: 'can_make_voucher', type: 'boolean', default: false })
  canMakeVoucher!: boolean;

  @Column({ name: 'can_edit_voucher', type: 'boolean', default: false })
  canEditVoucher!: boolean;

  @Column({ name: 'can_add_customer', type: 'boolean', default: false })
  canAddCustomer!: boolean;

  @Column({ name: 'can_edit_customer_credit', type: 'boolean', default: false })
  canEditCustomerCredit!: boolean;

  @Column({ name: 'can_add_items', type: 'boolean', default: false })
  canAddItems!: boolean;

  @Column({ name: 'can_edit_expiry', type: 'boolean', default: false })
  canEditExpiry!: boolean;

  /**
   * Granular dashboard permission keys (e.g. "vouchers.create", "items.edit").
   * The flexible, admin-managed permission set for dashboard users. Admin role
   * implicitly has everything regardless of this list.
   */
  @Column({ name: 'permissions', type: 'jsonb', default: () => "'[]'::jsonb" })
  permissions!: string[];
}
