import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/** STATIC = a hand-picked list; DYNAMIC = a rule-driven set (materialised later). */
export type SegmentKind = 'STATIC' | 'DYNAMIC';

/**
 * A named, reusable set of customers — the primitive other features point at
 * instead of carrying their own private customer lists. Membership itself lives
 * in `segment_customers`; this row is the group's identity and (for DYNAMIC
 * segments) the rule that fills it.
 */
@Entity({ name: 'customer_segments' })
export class CustomerSegment extends BaseEntity {
  @Column({ name: 'name_ar', type: 'text' })
  nameAr!: string;

  @Column({ name: 'name_en', type: 'text', nullable: true })
  nameEn?: string | null;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  /** Chip colour in the dashboard (a hex string), purely presentational. */
  @Column({ type: 'text', nullable: true })
  color?: string | null;

  @Index('idx_customer_segments_kind')
  @Column({ type: 'text', default: 'STATIC' })
  kind!: SegmentKind;

  /** DYNAMIC only — the criteria that fill the segment. Stored now; the engine
   *  that materialises it into members lands in a later phase. */
  @Column({ type: 'jsonb', nullable: true })
  rules?: Record<string, unknown> | null;

  @Index('idx_customer_segments_active')
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  /** A segment created by a backfill/derivation the UI protects from casual edits. */
  @Column({ name: 'is_system', type: 'boolean', default: false })
  isSystem!: boolean;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy?: string | null;
}
