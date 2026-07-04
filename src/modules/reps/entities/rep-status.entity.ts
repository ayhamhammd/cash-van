import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Liveness state for one rep (rep_id is both PK and FK → reps.id). Written on
 * every heartbeat and touched by location uploads; read by the offline
 * watchdog. Deliberately NOT a BaseEntity — no soft-delete/version churn on a
 * hot row that updates ~every 60s.
 */
@Entity({ name: 'rep_statuses' })
export class RepStatus {
  @PrimaryColumn({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  @Index('idx_rep_statuses_last_seen')
  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt?: Date | null;

  @Column({ name: 'gps_enabled', type: 'boolean', nullable: true })
  gpsEnabled?: boolean | null;

  /** 'active' while working; 'signed_out' after day-close/logout (suppresses offline alerts). */
  @Column({ name: 'last_app_state', type: 'text', default: 'active' })
  lastAppState!: string;

  @Column({ name: 'battery_pct', type: 'integer', nullable: true })
  batteryPct?: number | null;

  /** Set when a rep.offline alert has fired; cleared on recovery. Persisted dedup. */
  @Column({ name: 'offline_alerted_at', type: 'timestamptz', nullable: true })
  offlineAlertedAt?: Date | null;

  /** Set when a rep.gps_off alert has fired; cleared on gps-on. Cooldown dedup. */
  @Column({ name: 'gps_alerted_at', type: 'timestamptz', nullable: true })
  gpsAlertedAt?: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
