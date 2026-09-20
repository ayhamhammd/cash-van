import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A rep's working day: when they opened, when they closed, and where.
 *
 * The handset has always tracked this and never been able to tell anyone — the
 * office inferred a working day from heartbeats, which says a device was awake,
 * not that a person started work.
 *
 * Open and close each carry their own coordinates and their own timestamp. The
 * timestamp is the moment on the handset, never the moment the row arrived: a
 * shift that syncs after an outage must not be recorded as having started when
 * coverage came back.
 */
@Entity({ name: 'shifts' })
export class Shift {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_shifts_rep_opened')
  @Column({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  /**
   * The handset's own id for this shift. Unique where present, so a retried
   * open cannot become a second working day.
   */
  @Index('uq_shifts_client_ref', { unique: true, where: '"client_ref" IS NOT NULL' })
  @Column({ name: 'client_ref', type: 'text', nullable: true })
  clientRef?: string | null;

  @Column({ name: 'opened_at', type: 'timestamptz' })
  openedAt!: Date;

  /** Null while the shift is still open — and only one such row per rep. */
  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt?: Date | null;

  @Column({ name: 'open_lat', type: 'double precision', nullable: true })
  openLat?: number | null;

  @Column({ name: 'open_lng', type: 'double precision', nullable: true })
  openLng?: number | null;

  @Column({ name: 'close_lat', type: 'double precision', nullable: true })
  closeLat?: number | null;

  @Column({ name: 'close_lng', type: 'double precision', nullable: true })
  closeLng?: number | null;

  @Column({ type: 'text', nullable: true })
  note?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
