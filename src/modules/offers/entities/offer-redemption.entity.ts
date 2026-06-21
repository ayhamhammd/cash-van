import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { FreeItemSpec } from '../offers.types';

/**
 * One row per (offer × sale) the offer was applied to. Written best-effort from
 * the voucher-creation hook (a failure here never blocks a sale). Powers the
 * per-offer redemptions report and the per-customer limit check.
 */
@Entity({ name: 'offer_redemptions' })
@Index('idx_offer_redemptions_offer', ['offerId', 'createdAt'])
@Index('idx_offer_redemptions_customer', ['offerId', 'customerNumber'])
export class OfferRedemption {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'offer_id', type: 'uuid' })
  offerId!: string;

  @Column({ name: 'voucher_number', type: 'text', nullable: true })
  voucherNumber?: string | null;

  @Column({ name: 'customer_number', type: 'text', nullable: true })
  customerNumber?: string | null;

  /** Discount granted by this offer on this sale (fils). */
  @Column({ name: 'discount_fils', type: 'integer', default: 0 })
  discountFils!: number;

  @Column({ name: 'free_items', type: 'jsonb', default: () => "'[]'::jsonb" })
  freeItems!: FreeItemSpec[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
