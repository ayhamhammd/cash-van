import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import type {
  SpecialTaxBase,
  SpecialTaxCalcType,
  TaxBase,
  WithheldTaxBase,
  WithheldTaxCalcType,
} from '../../vouchers/tobacco-tax-calc';

/**
 * Per-company tobacco tax profile — mirror of the ERP `tobacco_tax_profiles`
 * (minus the accounting-account mappings; the ERP posts the accounting). When
 * FlowVan works WITH the ERP these rows are synced in and read-only; standalone
 * they're admin-managed. Money fields are integer **fils**. See
 * docs/SPEC-tobacco-tax.md and [[tobacco-tax-plan]].
 */
@Entity({ name: 'tobacco_tax_profiles' })
export class TobaccoTaxProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The ERP profile id when synced (unique). Null for locally-created rows. */
  @Index('uq_tobacco_profile_erp_id', { unique: true })
  @Column({ name: 'erp_id', type: 'text', nullable: true })
  erpId?: string | null;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  /** SALE_PRICE | CONSUMER_PRICE */
  @Column({ name: 'tax_base', type: 'text', default: 'CONSUMER_PRICE' })
  taxBase!: TaxBase;

  // ── Sales tax ────────────────────────────────────────────────────────────
  @Column({ name: 'sales_tax_enabled', type: 'boolean', default: true })
  salesTaxEnabled!: boolean;

  @Column({ name: 'sales_tax_rate', type: 'integer', default: 0 })
  salesTaxRate!: number;

  // ── Special / excise tax ───────────────────────────────────────────────────
  @Column({ name: 'special_tax_enabled', type: 'boolean', default: false })
  specialTaxEnabled!: boolean;

  /** NONE | FIXED_PER_UNIT | RATE | FIXED_PLUS_RATE */
  @Column({ name: 'special_tax_calculation_type', type: 'text', default: 'NONE' })
  specialTaxCalculationType!: SpecialTaxCalcType;

  /** SALE_PRICE | CONSUMER_PRICE | QUANTITY */
  @Column({ name: 'special_tax_base', type: 'text', default: 'QUANTITY' })
  specialTaxBase!: SpecialTaxBase;

  @Column({ name: 'special_tax_rate', type: 'integer', nullable: true })
  specialTaxRate?: number | null;

  /** Integer fils per unit. */
  @Column({ name: 'special_tax_fixed_amount', type: 'integer', nullable: true })
  specialTaxFixedAmount?: number | null;

  // ── Withheld / prepaid tax ─────────────────────────────────────────────────
  @Column({ name: 'withheld_tax_enabled', type: 'boolean', default: false })
  withheldTaxEnabled!: boolean;

  /** NONE | FIXED_PER_UNIT | RATE */
  @Column({ name: 'withheld_tax_calculation_type', type: 'text', default: 'NONE' })
  withheldTaxCalculationType!: WithheldTaxCalcType;

  /** SALE_PRICE | CONSUMER_PRICE | GROSS_TAX */
  @Column({ name: 'withheld_tax_base', type: 'text', default: 'GROSS_TAX' })
  withheldTaxBase!: WithheldTaxBase;

  /** Integer fils per unit. */
  @Column({ name: 'withheld_tax_amount', type: 'integer', nullable: true })
  withheldTaxAmount?: number | null;

  @Column({ name: 'withheld_tax_rate', type: 'integer', nullable: true })
  withheldTaxRate?: number | null;

  @Column({ name: 'tax_included_in_consumer_price', type: 'boolean', default: false })
  taxIncludedInConsumerPrice!: boolean;

  @Column({ name: 'effective_from', type: 'date', nullable: true })
  effectiveFrom?: string | null;

  @Column({ name: 'effective_to', type: 'date', nullable: true })
  effectiveTo?: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
