import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/** One product line on a quote — a SNAPSHOT with its own outreach price, not a
 *  live catalog reference: editing the catalog later must not silently change
 *  quotes already sent to prospects. */
export interface QuoteTemplateItem {
  itemNumber: string;
  nameAr: string;
  /** Outreach price per unit, in fils. */
  priceFils: number;
}

/**
 * A reusable price-quote template (Prospecting P1). Rendered as the public
 * quote page at /q/<publicToken> — the link sent to prospects on WhatsApp.
 */
@Entity({ name: 'quote_templates' })
export class QuoteTemplate extends BaseEntity {
  @Column({ type: 'text' })
  name!: string;

  /** Company logo as a data: URL (same convention as company-info). */
  @Column({ name: 'logo_url', type: 'text', nullable: true })
  logoUrl?: string | null;

  @Column({ name: 'description_ar', type: 'text', nullable: true })
  descriptionAr?: string | null;

  /** Contact phone numbers shown on the quote footer. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  phones!: string[];

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  items!: QuoteTemplateItem[];

  /** Message prefilled into the WhatsApp click-to-chat link (P3). */
  @Column({ name: 'whatsapp_message_ar', type: 'text', nullable: true })
  whatsappMessageAr?: string | null;

  /** Unguessable token for the PUBLIC quote URL (/q/<token>). */
  @Column({ name: 'public_token', type: 'text' })
  publicToken!: string;

  /** Inactive templates keep their data but the public URL stops resolving. */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;
}
