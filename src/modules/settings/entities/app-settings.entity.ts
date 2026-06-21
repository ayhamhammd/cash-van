import {
  Column,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Whether unit prices already include tax (INCLUSIVE) or tax is added on top (EXCLUSIVE). */
export type TaxCalcMethod = 'INCLUSIVE' | 'EXCLUSIVE';

@Entity({ name: 'app_settings' })
export class AppSettings {
  /** Single-row table — id is always 1 (enforced by CHECK constraint at DB level). */
  @PrimaryColumn({ type: 'smallint', default: 1 })
  id!: number;

  /** Single-tenant company id echoed/validated by the mobile BFF (e.g. "C001"). */
  @Column({ name: 'company_number', type: 'text', default: 'C001' })
  companyNumber!: string;

  @Column({ name: 'logo_url', type: 'text', nullable: true })
  logoUrl?: string | null;

  @Column({ name: 'company_name_ar', type: 'text' })
  companyNameAr!: string;

  @Column({ name: 'company_name_en', type: 'text', nullable: true })
  companyNameEn?: string | null;

  @Column({ name: 'seller_tin', type: 'text', nullable: true })
  sellerTin?: string | null;

  @Column({ name: 'seller_address', type: 'text', nullable: true })
  sellerAddress?: string | null;

  @Column({ name: 'seller_phone', type: 'text', nullable: true })
  sellerPhone?: string | null;

  @Column({ name: 'seller_city_code', type: 'text', nullable: true })
  sellerCityCode?: string | null;

  /** How prices relate to tax for this company (price tax-inclusive vs exclusive). */
  @Column({ name: 'tax_calc_method', type: 'text', default: 'EXCLUSIVE' })
  taxCalcMethod!: TaxCalcMethod;

  @Column({ type: 'text', default: 'Asia/Amman' })
  timezone!: string;

  @Column({ type: 'text', default: 'ar' })
  locale!: string;

  @Column({ name: 'ai_chat_quota', type: 'integer', default: 200 })
  aiChatQuota!: number;

  @Column({ name: 'ai_infer_quota', type: 'integer', default: 1000 })
  aiInferQuota!: number;

  @Column({ name: 'jofotara_client_id', type: 'text', nullable: true })
  jofotaraClientId?: string | null;

  @Column({ name: 'jofotara_secret_key_encrypted', type: 'text', nullable: true, select: false })
  jofotaraSecretKeyEncrypted?: string | null;

  @Column({ name: 'jofotara_secret_last4', type: 'text', nullable: true })
  jofotaraSecretLast4?: string | null;

  @Column({ name: 'jofotara_sandbox', type: 'boolean', default: true })
  jofotaraSandbox!: boolean;

  // ── ERP (erp-saas) integration ────────────────────────────────────────────
  /** The toggle: work WITH the ERP (sync items/units/stores/stock) or standalone. */
  @Column({ name: 'erp_sync_enabled', type: 'boolean', default: false })
  erpSyncEnabled!: boolean;

  /** ERP origin (e.g. https://erp.example.com); the API base "/api/v1" is appended. */
  @Column({ name: 'erp_base_url', type: 'text', nullable: true })
  erpBaseUrl?: string | null;

  @Column({ name: 'erp_api_key_encrypted', type: 'text', nullable: true, select: false })
  erpApiKeyEncrypted?: string | null;

  @Column({ name: 'erp_api_key_last4', type: 'text', nullable: true })
  erpApiKeyLast4?: string | null;

  @Column({ name: 'erp_last_sync_at', type: 'timestamptz', nullable: true })
  erpLastSyncAt?: Date | null;

  /** The cash-van store that the ERP's van warehouse maps to (for stock sync). */
  @Column({ name: 'erp_van_store', type: 'text', nullable: true })
  erpVanStore?: string | null;

  /** ERP category + tax-rate ids used when mirroring a new cash-van item to the ERP. */
  @Column({ name: 'erp_default_category_id', type: 'text', nullable: true })
  erpDefaultCategoryId?: string | null;

  @Column({ name: 'erp_default_tax_rate_id', type: 'text', nullable: true })
  erpDefaultTaxRateId?: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy?: string | null;
}
