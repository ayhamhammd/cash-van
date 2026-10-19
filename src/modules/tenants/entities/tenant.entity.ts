import { Column, Entity, Index, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

/** Lifecycle of a tenant. `suspended` blocks login but keeps the data intact. */
export type TenantStatus = 'active' | 'suspended';

/**
 * One customer company. Every other table in this database carries a
 * `tenant_id` pointing here, and Postgres row-level security filters on it —
 * see `1723700000000-TenancyAndRls`.
 *
 * Rows are created by the CRM control plane via the internal provisioning
 * endpoint, or by the seed in `AUTH_MODE=local` (on-prem, one tenant per box).
 */
@Entity({ name: 'tenants' })
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Short human slug used in logs and support, e.g. "ACME". Globally unique. */
  @Index('uq_tenants_code', { unique: true })
  @Column({ type: 'text' })
  code!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', default: 'active' })
  status!: TenantStatus;

  /** The CRM's `tenants.id`. Null on an on-prem box that has no CRM. */
  @Column({ name: 'crm_tenant_id', type: 'uuid', nullable: true })
  crmTenantId?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
