import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import type {
  OfferEligibility,
  OfferRewardConfig,
  OfferTriggerConfig,
  OfferType,
} from '../offers.types';

/**
 * An offer definition. The dashboard creates/edits these; the engine reads them
 * to compute discounts. Type-specific shapes live in the `trigger`/`reward`
 * jsonb columns — their legality per `type` is enforced in OffersService.
 */
@Entity({ name: 'offers' })
@Index('idx_offers_active', ['isActive'])
@Index('idx_offers_type', ['type'])
export class Offer extends BaseEntity {
  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ type: 'text' })
  type!: OfferType;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  trigger!: OfferTriggerConfig;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  reward!: OfferRewardConfig;

  @Column({
    type: 'jsonb',
    default: () => `'{"customerScope":"ALL"}'::jsonb`,
  })
  eligibility!: OfferEligibility;

  // ---- schedule ----
  @Column({ name: 'valid_from', type: 'timestamptz', nullable: true })
  validFrom?: Date | null;

  @Column({ name: 'valid_to', type: 'timestamptz', nullable: true })
  validTo?: Date | null;

  /** Weekday numbers the offer runs on (0=Sun … 6=Sat). Null = every day. */
  @Column({ name: 'days_of_week', type: 'jsonb', nullable: true })
  daysOfWeek?: number[] | null;

  /** 'HH:mm' inclusive window within the day. Null = all day. */
  @Column({ name: 'time_from', type: 'text', nullable: true })
  timeFrom?: string | null;

  @Column({ name: 'time_to', type: 'text', nullable: true })
  timeTo?: string | null;

  // ---- limits ----
  @Column({ name: 'total_redemption_limit', type: 'integer', nullable: true })
  totalRedemptionLimit?: number | null;

  @Column({ name: 'per_customer_limit', type: 'integer', nullable: true })
  perCustomerLimit?: number | null;

  // ---- ranking / stacking ----
  @Column({ type: 'integer', default: 0 })
  priority!: number;

  @Column({ type: 'boolean', default: false })
  stackable!: boolean;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  /** Denormalised running total of redemptions (for limits + stats). */
  @Column({ name: 'redemption_count', type: 'integer', default: 0 })
  redemptionCount!: number;
}
