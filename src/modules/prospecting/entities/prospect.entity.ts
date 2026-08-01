import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * Outreach pipeline. A prospect that matched an existing customer keeps
 * `matchedCustomerId` set and stays out of outreach by default.
 */
export type ProspectStatus =
  | 'NEW'
  | 'QUOTED'
  | 'CONTACTED'
  | 'CONVERTED'
  | 'REJECTED';

/** Why the de-dup flagged this prospect as an existing customer. */
export type ProspectMatchReason = 'PHONE' | 'DISTANCE' | 'NAME';

/** A candidate business found near a search point. */
@Entity({ name: 'prospects' })
export class Prospect extends BaseEntity {
  @Index('idx_prospects_search_id')
  @Column({ name: 'search_id', type: 'uuid', nullable: true })
  searchId?: string | null;

  /**
   * Google's stable place id — UNIQUE, so re-searching the same area updates
   * the lead rather than duplicating it (and preserves status/notes/history).
   * This is also the only Places field Google permits storing indefinitely.
   */
  @Column({ name: 'google_place_id', type: 'text' })
  googlePlaceId!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'numeric', precision: 9, scale: 6, nullable: true })
  lat?: string | null;

  @Column({ type: 'numeric', precision: 9, scale: 6, nullable: true })
  lng?: string | null;

  @Column({ type: 'text', nullable: true })
  address?: string | null;

  /** Often null — small shops frequently have no phone on Google. */
  @Column({ type: 'text', nullable: true })
  phone?: string | null;

  @Column({ type: 'text', nullable: true })
  category?: string | null;

  @Column({ type: 'numeric', precision: 2, scale: 1, nullable: true })
  rating?: string | null;

  @Index('idx_prospects_status')
  @Column({ type: 'text', default: 'NEW' })
  status!: ProspectStatus;

  /** Set when de-dup decided this is already a customer. */
  @Column({ name: 'matched_customer_id', type: 'uuid', nullable: true })
  matchedCustomerId?: string | null;

  @Column({ name: 'match_reason', type: 'text', nullable: true })
  matchReason?: ProspectMatchReason | null;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  /** Stamped when the rep opens the WhatsApp chat for this prospect. */
  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt?: Date | null;

  /** Stamped the first time the prospect opens the public quote link. */
  @Column({ name: 'link_opened_at', type: 'timestamptz', nullable: true })
  linkOpenedAt?: Date | null;
}
