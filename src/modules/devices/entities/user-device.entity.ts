import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * One phone, bound to one salesman.
 *
 * The binding is what enforces "this handset belongs to this user, and this
 * user works from this handset" — a live row exists per device AND per user, so
 * a second person cannot sign in here and this person cannot sign in elsewhere.
 *
 * Signing out does NOT end the binding. That is the point: the handset keeps
 * reporting its position after the salesman closes the app, and only the office
 * can cut that by releasing the row (`released_at`). Release is a soft close —
 * the history of who carried which phone is worth keeping.
 */
@Entity({ name: 'user_devices' })
@Index('idx_user_devices_user_live', ['userId'], { where: 'released_at IS NULL' })
export class UserDevice extends BaseEntity {
  @Index()
  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /** Stable per-handset id from the app (ANDROID_ID / identifierForVendor). */
  @Column({ name: 'device_id', type: 'text' })
  deviceId!: string;

  @Column({ type: 'text', nullable: true })
  platform?: string | null;

  /** Human label for the office's release screen, e.g. "Samsung SM-A155F". */
  @Column({ type: 'text', nullable: true })
  model?: string | null;

  @Column({ name: 'bound_at', type: 'timestamptz', default: () => 'now()' })
  boundAt!: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt?: Date | null;

  /**
   * Released by the office → the binding is dead and its tracking token stops
   * being honoured. Null means live.
   */
  @Column({ name: 'released_at', type: 'timestamptz', nullable: true })
  releasedAt?: Date | null;

  @Column({ name: 'released_by', type: 'uuid', nullable: true })
  releasedBy?: string | null;

  /**
   * `jti` of the current interactive session. Cleared on sign-out — which is
   * how "signed out but still tracking" is represented.
   */
  @Column({ name: 'session_jti', type: 'text', nullable: true })
  sessionJti?: string | null;

  /**
   * `jti` of the long-lived tracking token. Survives sign-out; cleared only on
   * release, which is what makes release the single revocation point.
   */
  @Column({ name: 'tracking_jti', type: 'text', nullable: true })
  trackingJti?: string | null;
}
