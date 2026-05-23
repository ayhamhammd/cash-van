import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * GPS ping from a rep's mobile.
 *
 * Range-partitioned monthly by `recorded_at` (see migration). TypeORM doesn't
 * model the partition strategy, but it doesn't need to — partitioned tables
 * behave like normal tables at the SQL layer.
 *
 * PK is composite `(id, recorded_at)`; we expose `id` as the entity's
 * primary in TypeORM but write code never relies on `id` alone — always
 * filter by `rep_id` and `recorded_at` ranges.
 */
@Entity({ name: 'rep_location_events' })
export class RepLocationEvent {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_rle_rep_recorded_desc_logical')
  @Column({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  @Column({ type: 'double precision' })
  lat!: number;

  @Column({ type: 'double precision' })
  lng!: number;

  @Column({ name: 'accuracy_m', type: 'real', nullable: true })
  accuracyM?: number | null;

  @CreateDateColumn({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt!: Date;
}
