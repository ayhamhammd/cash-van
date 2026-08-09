import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { UserDevice } from './entities/user-device.entity';
import { User } from '../users/entities/user.entity';

/** Machine-readable reasons a sign-in was refused, matched by the mobile app. */
export const DEVICE_BOUND_TO_OTHER_USER = 'device_bound_to_other_user';
export const USER_ACTIVE_ON_OTHER_DEVICE = 'user_active_on_other_device';

export interface DeviceIdentity {
  deviceId: string;
  platform?: string | null;
  model?: string | null;
}

@Injectable()
export class DevicesService {
  constructor(
    @InjectRepository(UserDevice)
    private readonly devices: Repository<UserDevice>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  private live(where: Record<string, unknown>) {
    return this.devices.findOne({ where: { ...where, releasedAt: IsNull() } });
  }

  /**
   * Enforce the pairing and claim the handset for this user.
   *
   * Both refusals carry a `code` so the app can show the right dialog, and a
   * message naming the other party — a rep staring at "sign-in refused" cannot
   * act, whereas "this phone belongs to Ahmad" sends them to the right desk.
   * Naming is safe here: the caller has already proved a valid password, so
   * this tells an employee something about their own company's kit.
   */
  async claim(
    userId: string,
    identity: DeviceIdentity,
    sessionJti: string,
    trackingJti: string,
  ): Promise<UserDevice> {
    const byDevice = await this.live({ deviceId: identity.deviceId });
    if (byDevice && byDevice.userId !== userId) {
      const owner = await this.users.findOne({
        where: { id: byDevice.userId },
        select: { id: true, name: true, userNumber: true },
      });
      throw new ConflictException({
        code: DEVICE_BOUND_TO_OTHER_USER,
        message:
          `This device is registered to ${owner?.name ?? 'another user'}` +
          `${owner?.userNumber ? ` (${owner.userNumber})` : ''}. ` +
          'Ask the office to release it before signing in here.',
        boundToName: owner?.name ?? null,
        boundToUserNumber: owner?.userNumber ?? null,
      });
    }

    const byUser = await this.live({ userId });
    if (byUser && byUser.deviceId !== identity.deviceId) {
      throw new ConflictException({
        code: USER_ACTIVE_ON_OTHER_DEVICE,
        message:
          `This account is already registered on another device` +
          `${byUser.model ? ` (${byUser.model})` : ''}. ` +
          'Ask the office to release it before signing in here.',
        boundDeviceModel: byUser.model ?? null,
      });
    }

    // Same user, same handset — a re-login. Refresh the session and rotate the
    // tracking token so the previous one stops working.
    const row =
      byDevice ??
      this.devices.create({
        userId,
        deviceId: identity.deviceId,
        boundAt: new Date(),
      });
    row.platform = identity.platform ?? row.platform ?? null;
    row.model = identity.model ?? row.model ?? null;
    row.lastSeenAt = new Date();
    row.sessionJti = sessionJti;
    row.trackingJti = trackingJti;
    return this.devices.save(row);
  }

  /** Sign-out: drop the interactive session, keep the binding and tracking. */
  async closeSessionByDevice(deviceId: string): Promise<void> {
    await this.devices.update(
      { deviceId, releasedAt: IsNull() },
      { sessionJti: null, lastSeenAt: new Date() },
    );
  }

  /**
   * Is this tracking token still honoured? Called on every location upload, so
   * it is one indexed lookup and nothing more. Release is the only thing that
   * makes it false — which is what "tracking survives sign-out" means.
   */
  async isTrackingTokenLive(trackingJti: string): Promise<boolean> {
    const row = await this.live({ trackingJti });
    return !!row;
  }

  async touch(trackingJti: string): Promise<void> {
    await this.devices.update(
      { trackingJti, releasedAt: IsNull() },
      { lastSeenAt: new Date() },
    );
  }

  listForUser(userId: string): Promise<UserDevice[]> {
    return this.devices.find({
      where: { userId },
      order: { releasedAt: 'ASC', boundAt: 'DESC' },
    });
  }

  listLive(): Promise<UserDevice[]> {
    return this.devices.find({
      where: { releasedAt: IsNull() },
      order: { lastSeenAt: 'DESC' },
    });
  }

  /**
   * The office cutting a handset loose — the only way out of a binding.
   * Clearing `trackingJti` is what actually stops the phone reporting; without
   * it a released device would keep uploading until its token expired, which
   * for a token this long-lived is never.
   */
  async release(id: string, releasedBy: string): Promise<UserDevice> {
    const row = await this.devices.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Device not found');
    if (row.releasedAt) return row;
    row.releasedAt = new Date();
    row.releasedBy = releasedBy;
    row.sessionJti = null;
    row.trackingJti = null;
    return this.devices.save(row);
  }

  /** Every live binding whose handset has gone quiet — the office's watchlist. */
  async staleSince(cutoff: Date): Promise<UserDevice[]> {
    return this.devices.find({
      where: { releasedAt: IsNull(), lastSeenAt: Not(IsNull()) },
      order: { lastSeenAt: 'ASC' },
    }).then((rows) => rows.filter((r) => (r.lastSeenAt as Date) < cutoff));
  }
}
