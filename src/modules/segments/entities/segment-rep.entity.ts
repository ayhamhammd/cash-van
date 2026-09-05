import { Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * A salesman assigned to serve a segment. Ownership metadata — it records which
 * reps a segment "belongs to" for targeting and reporting, and is independent of
 * customer.rep_id (which the bulk assign action changes).
 */
@Entity({ name: 'segment_reps' })
@Unique('uq_segment_reps_pair', ['segmentId', 'repId'])
export class SegmentRep extends BaseEntity {
  @Index('idx_segment_reps_segment')
  @Column({ name: 'segment_id', type: 'uuid' })
  segmentId!: string;

  @Column({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  @Column({ name: 'added_by', type: 'uuid', nullable: true })
  addedBy?: string | null;

  @Column({ name: 'added_at', type: 'timestamptz', default: () => 'now()' })
  addedAt!: Date;
}
