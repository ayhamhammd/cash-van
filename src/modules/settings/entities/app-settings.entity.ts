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

  /**
   * When ON (default), posted vouchers + confirmed collections push to the ERP
   * automatically. When OFF, nothing auto-pushes — they wait in the "ERP Export"
   * page to be exported manually.
   */
  @Column({ name: 'erp_direct_export', type: 'boolean', default: true })
  erpDirectExport!: boolean;

  /** The cash-van store that the ERP's van warehouse maps to (for stock sync). */
  @Column({ name: 'erp_van_store', type: 'text', nullable: true })
  erpVanStore?: string | null;

  /** ERP category + tax-rate ids used when mirroring a new cash-van item to the ERP. */
  @Column({ name: 'erp_default_category_id', type: 'text', nullable: true })
  erpDefaultCategoryId?: string | null;

  @Column({ name: 'erp_default_tax_rate_id', type: 'text', nullable: true })
  erpDefaultTaxRateId?: string | null;

  // ── AI assistant (multi-provider: Anthropic / OpenAI / Gemini) ────────────
  /** Master switch: when off, the assistant falls back to the env-configured provider (if any). */
  @Column({ name: 'ai_enabled', type: 'boolean', default: false })
  aiEnabled!: boolean;

  /** Which LLM vendor drives the assistant: 'anthropic' | 'openai' | 'gemini'. */
  @Column({ name: 'ai_provider', type: 'text', default: 'anthropic' })
  aiProvider!: string;

  /** Model id (e.g. claude-sonnet-4-6, gpt-4o, gemini-2.5-flash). Null ⇒ provider default. */
  @Column({ name: 'ai_model', type: 'text', nullable: true })
  aiModel?: string | null;

  @Column({ name: 'ai_api_key_encrypted', type: 'text', nullable: true, select: false })
  aiApiKeyEncrypted?: string | null;

  @Column({ name: 'ai_api_key_last4', type: 'text', nullable: true })
  aiApiKeyLast4?: string | null;

  /** Gate: suggestions below this confidence (0–100) are hidden/de-emphasised. */
  @Column({ name: 'ai_confidence_threshold', type: 'integer', default: 75 })
  aiConfidenceThreshold!: number;

  /** Assistant language: 'auto' | 'ar' | 'en' | 'bilingual'. */
  @Column({ name: 'ai_language', type: 'text', default: 'auto' })
  aiLanguage!: string;

  /** Per-capability toggles (chatAssistant, forecast, churn, anomaly, ocr, …). */
  @Column({ name: 'ai_capabilities', type: 'jsonb', default: {} })
  aiCapabilities!: Record<string, boolean>;

  // ── Voucher (receipt) print template ──────────────────────────────────────
  /**
   * Company overrides for the printed voucher template, stored as the delta from
   * BASE_VOUCHER_TEMPLATE (only keys that differ). The resolved template is
   * `{ ...BASE_VOUCHER_TEMPLATE, ...overrides }`. Empty `{}` = pure base.
   */
  @Column({ name: 'voucher_template_overrides', type: 'jsonb', default: {} })
  voucherTemplateOverrides!: Record<string, unknown>;

  /**
   * Master toggle for the tobacco ("smoke") tax feature. OFF (default) ⇒ tobacco
   * items are taxed as normal GST — zero behavior change. ON ⇒ items flagged
   * `is_tobacco_product` use their tobacco tax profile (see docs/SPEC-tobacco-tax.md).
   */
  @Column({ name: 'tobacco_tax_enabled', type: 'boolean', default: false })
  tobaccoTaxEnabled!: boolean;

  /**
   * FastReport-style banded voucher layout (the "Voucher Designer" document).
   * Stored whole; null = use DEFAULT_VOUCHER_REPORT. See voucher-report.dto.ts.
   */
  @Column({ name: 'voucher_report', type: 'jsonb', nullable: true })
  voucherReport?: Record<string, unknown> | null;

  // ── Accounting: the three main settlement accounts (ERP GL refs) ───────────
  // Each is an ERP chart-of-accounts id + a code·name snapshot for display/memos.
  // See docs/SPEC-rep-erp-accounts-settlement.md. Set sales === cash-collection to post
  // cash as one combined line, or split them.

  /** Destination for the rep's cash-SALES cash on settle. */
  @Column({ name: 'erp_sales_account_id', type: 'text', nullable: true })
  erpSalesAccountId?: string | null;

  @Column({ name: 'erp_sales_account_code', type: 'text', nullable: true })
  erpSalesAccountCode?: string | null;

  /** Destination for the rep's cash-COLLECTIONS cash on settle. */
  @Column({ name: 'erp_cash_collection_account_id', type: 'text', nullable: true })
  erpCashCollectionAccountId?: string | null;

  @Column({ name: 'erp_cash_collection_account_code', type: 'text', nullable: true })
  erpCashCollectionAccountCode?: string | null;

  /** Destination for the rep's CHEQUE collections on settle (always in full). */
  @Column({ name: 'erp_cheque_collection_account_id', type: 'text', nullable: true })
  erpChequeCollectionAccountId?: string | null;

  @Column({ name: 'erp_cheque_collection_account_code', type: 'text', nullable: true })
  erpChequeCollectionAccountCode?: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy?: string | null;
}
