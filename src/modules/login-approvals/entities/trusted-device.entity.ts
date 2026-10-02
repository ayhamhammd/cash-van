import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * A browser an administrator trusts for one user.
 *
 * Only the SHA-256 of the browser's device cookie is stored: a copy of this
 * table is not enough to impersonate a trusted device, because the cookie value
 * itself never touches the database. Revoking keeps the row (who trusted what,
 * and when it stopped) and the next sign-in from that browser asks again.
 */
@Entity({ name: 'trusted_devices' })
@Index('uq_trusted_devices_user_device_live', ['userId', 'deviceHash'], {
  unique: true,
  where: 'revoked_at IS NULL',
})
export class TrustedDevice extends BaseEntity {
  @Index()
  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'device_hash', type: 'text' })
  deviceHash!: string;

  /** "Chrome on Windows" — from the user agent, editable by the admin. */
  @Column({ type: 'text', nullable: true })
  label?: string | null;

  @Column({ name: 'last_ip', type: 'text', nullable: true })
  lastIp?: string | null;

  @Column({ name: 'trusted_by', type: 'uuid', nullable: true })
  trustedBy?: string | null;

  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt?: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt?: Date | null;
}
