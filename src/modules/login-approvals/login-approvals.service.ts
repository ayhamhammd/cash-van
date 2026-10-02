import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomBytes } from 'crypto';

import { TrustedDevice } from './entities/trusted-device.entity';
import { LoginRequest, LoginRequestStatus } from './entities/login-request.entity';
import { deviceLabel } from './device-label';
import { User } from '../users/entities/user.entity';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';

/** How long a sign-in waits for an administrator before it has to be asked again. */
export const LOGIN_REQUEST_TTL_MS = 30 * 60 * 1000;

/** The browser's device cookie. Random, httpOnly, long-lived; only its hash is stored. */
export const DEVICE_COOKIE = 'vf_device';

export interface WebDevice {
  /** The raw cookie value, never stored. */
  raw: string;
  userAgent?: string | null;
  ip?: string | null;
}

export type GateResult =
  | { allowed: true }
  | { allowed: false; requestId: string; expiresAt: Date };

export type CompleteResult =
  | { status: 'approved'; userId: string }
  | { status: Exclude<LoginRequestStatus, 'approved'> };

export const hashDevice = (raw: string): string => createHash('sha256').update(raw).digest('hex');
export const newDeviceId = (): string => randomBytes(32).toString('base64url');

/**
 * Administrators approve sign-ins, so they are never held waiting for one.
 * The ROLE decides, not the user type: office staff are commonly typed ADMIN
 * while holding a manager or viewer role, and must not slip past the rule.
 */
export const isExempt = (u: Pick<User, 'role'>): boolean => u.role === 'admin';

/**
 * Sign-ins from untrusted browsers wait for an administrator.
 *
 * Optional and off by default (app_settings.require_device_approval). Applies to
 * web sign-ins only: the mobile app already binds each salesman to one phone
 * that only the office can release. Administrators are exempt — they are the
 * ones approving, and an only admin on a new laptop must not be locked out.
 */
@Injectable()
export class LoginApprovalsService {
  constructor(
    @InjectRepository(TrustedDevice) private readonly trusted: Repository<TrustedDevice>,
    @InjectRepository(LoginRequest) private readonly requests: Repository<LoginRequest>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Called after the password has been accepted. A trusted browser (or an
   * exempt user, or the feature switched off) goes straight in; anything else
   * files — or re-uses — a pending request and tells administrators.
   */
  async gate(user: User, device: WebDevice): Promise<GateResult> {
    if (!(await this.settings.requireDeviceApproval())) return { allowed: true };
    if (isExempt(user)) return { allowed: true };

    const deviceHash = hashDevice(device.raw);
    const trusted = await this.trusted.findOne({
      where: { userId: user.id, deviceHash, revokedAt: IsNull() },
    });
    if (trusted) {
      trusted.lastSeenAt = new Date();
      trusted.lastIp = device.ip ?? trusted.lastIp ?? null;
      await this.trusted.save(trusted);
      return { allowed: true };
    }

    // Pressing "sign in" twice is one request, not two for the admin to clear.
    const existing = await this.requests.findOne({
      where: { userId: user.id, deviceHash, status: 'pending' },
      order: { createdAt: 'DESC' },
    });
    if (existing && existing.expiresAt.getTime() > Date.now()) {
      return { allowed: false, requestId: existing.id, expiresAt: existing.expiresAt };
    }

    const row = await this.requests.save(
      this.requests.create({
        userId: user.id,
        deviceHash,
        label: deviceLabel(device.userAgent),
        userAgent: device.userAgent?.slice(0, 500) ?? null,
        ip: device.ip ?? null,
        status: 'pending',
        expiresAt: new Date(Date.now() + LOGIN_REQUEST_TTL_MS),
      }),
    );
    await this.announce(row, user);
    return { allowed: false, requestId: row.id, expiresAt: row.expiresAt };
  }

  /**
   * The waiting browser asks how it went. Only the browser that filed the
   * request can finish it — the device cookie is the proof — and an approval is
   * good for one sign-in.
   */
  async complete(id: string, rawDevice: string | undefined): Promise<CompleteResult> {
    const row = await this.requests.findOne({ where: { id } });
    if (!row || !rawDevice || row.deviceHash !== hashDevice(rawDevice)) {
      throw new NotFoundException('Sign-in request not found');
    }
    if (row.status === 'pending' && row.expiresAt.getTime() <= Date.now()) {
      row.status = 'expired';
      await this.requests.save(row);
    }
    if (row.status !== 'approved') return { status: row.status as Exclude<LoginRequestStatus, 'approved'> };

    // Claim it atomically: two tabs polling at once must not both sign in.
    const claimed = await this.requests.update(
      { id: row.id, status: 'approved' },
      { status: 'used', usedAt: new Date() },
    );
    if (!claimed.affected) return { status: 'used' };
    return { status: 'approved', userId: row.userId };
  }

  // ── Administrator side ─────────────────────────────────────────────────────

  async listRequests(status?: LoginRequestStatus) {
    await this.expireStale();
    const rows = await this.requests.find({
      where: status ? { status } : {},
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return this.withUsers(rows);
  }

  async approve(id: string, adminId: string, trust: boolean): Promise<LoginRequest> {
    const row = await this.pendingOrThrow(id);
    row.status = 'approved';
    row.trust = trust;
    row.decidedBy = adminId;
    row.decidedAt = new Date();
    await this.requests.save(row);
    if (trust) await this.trustDevice(row.userId, row.deviceHash, row.label ?? null, row.ip ?? null, adminId);
    this.events.emit('login-request.decided', { id: row.id, status: row.status });
    return row;
  }

  async reject(id: string, adminId: string): Promise<LoginRequest> {
    const row = await this.pendingOrThrow(id);
    row.status = 'rejected';
    row.decidedBy = adminId;
    row.decidedAt = new Date();
    await this.requests.save(row);
    this.events.emit('login-request.decided', { id: row.id, status: row.status });
    return row;
  }

  async listTrusted() {
    const rows = await this.trusted.find({
      where: { revokedAt: IsNull() },
      order: { lastSeenAt: 'DESC', createdAt: 'DESC' },
    });
    return this.withUsers(rows);
  }

  async revoke(id: string): Promise<void> {
    const row = await this.trusted.findOne({ where: { id, revokedAt: IsNull() } });
    if (!row) throw new NotFoundException('Trusted device not found');
    row.revokedAt = new Date();
    await this.trusted.save(row);
  }

  async rename(id: string, label: string): Promise<TrustedDevice> {
    const row = await this.trusted.findOne({ where: { id, revokedAt: IsNull() } });
    if (!row) throw new NotFoundException('Trusted device not found');
    row.label = label.trim().slice(0, 120) || row.label;
    return this.trusted.save(row);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async trustDevice(
    userId: string, deviceHash: string, label: string | null, ip: string | null, adminId: string,
  ): Promise<void> {
    const live = await this.trusted.findOne({ where: { userId, deviceHash, revokedAt: IsNull() } });
    if (live) return;
    await this.trusted.save(
      this.trusted.create({ userId, deviceHash, label, lastIp: ip, trustedBy: adminId, lastSeenAt: new Date() }),
    );
  }

  private async pendingOrThrow(id: string): Promise<LoginRequest> {
    await this.expireStale();
    const row = await this.requests.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Sign-in request not found');
    if (row.status !== 'pending') throw new ConflictException(`This sign-in is already ${row.status}`);
    return row;
  }

  private async expireStale(): Promise<void> {
    await this.requests.update(
      { status: 'pending', expiresAt: LessThan(new Date()) },
      { status: 'expired' },
    );
  }

  private async withUsers<T extends { userId: string }>(rows: T[]) {
    const ids = [...new Set(rows.map((r) => r.userId))];
    const users = ids.length
      ? await this.users.find({ where: { id: In(ids) }, select: { id: true, name: true, userNumber: true, role: true } })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({
      ...r,
      userName: byId.get(r.userId)?.name ?? null,
      userNumber: byId.get(r.userId)?.userNumber ?? null,
      userRole: byId.get(r.userId)?.role ?? null,
    }));
  }

  /** Every active administrator hears about it — they are the ones who decide. */
  private async announce(row: LoginRequest, user: User): Promise<void> {
    const admins = await this.users.find({ where: { role: 'admin', isActive: true }, select: { id: true } });
    const who = user.name || user.userNumber;
    for (const a of admins) {
      await this.notifications.notifyUser(a.id, {
        kind: 'login-request.created',
        titleAr: `${who} يحاول الدخول من جهاز غير موثوق`,
        titleEn: `${who} is signing in from an untrusted device`,
        bodyAr: [row.label, row.ip].filter(Boolean).join(' — '),
        bodyEn: [row.label, row.ip].filter(Boolean).join(' — '),
        refType: 'login-request',
        refId: row.id,
      });
    }
    this.events.emit('login-request.created', { id: row.id, userId: user.id, label: row.label });
  }
}
