import {
  Column,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'app_settings' })
export class AppSettings {
  /** Single-row table — id is always 1 (enforced by CHECK constraint at DB level). */
  @PrimaryColumn({ type: 'smallint', default: 1 })
  id!: number;

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

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy?: string | null;
}
