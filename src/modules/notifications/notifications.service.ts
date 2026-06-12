import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { AppNotification } from './entities/notification.entity';
import { User } from '../users/entities/user.entity';

export interface NotifyInput {
  kind: string;
  titleAr: string;
  titleEn: string;
  bodyAr?: string;
  bodyEn?: string;
  refType?: string;
  refId?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(AppNotification)
    private readonly repo: Repository<AppNotification>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly events: EventEmitter2,
  ) {}

  /** Insert one inbox row for a specific user and announce it on the socket. */
  async notifyUser(userId: string, input: NotifyInput): Promise<AppNotification> {
    const row = await this.repo.save(this.repo.create({ userId, ...input }));
    this.events.emit('notification.created', {
      id: row.id,
      userId,
      kind: row.kind,
      titleAr: row.titleAr,
      titleEn: row.titleEn,
      refType: row.refType ?? null,
      refId: row.refId ?? null,
      createdAt: row.createdAt,
    });
    return row;
  }

  /**
   * Fan a notification out to every active manager/admin (one row each, so
   * read state is per-user). `excludeUserId` skips the actor themself.
   */
  async notifyManagers(input: NotifyInput, excludeUserId?: string): Promise<number> {
    const managers = await this.users.find({
      where: { role: In(['admin', 'manager']), isActive: true },
      select: { id: true },
    });
    const targets = managers.filter((m) => m.id !== excludeUserId);
    for (const m of targets) {
      await this.notifyUser(m.id, input);
    }
    this.logger.debug(`Notified ${targets.length} manager(s): ${input.kind}`);
    return targets.length;
  }

  async list(
    userId: string,
    unreadOnly: boolean,
    offset = 0,
    limit = 25,
  ): Promise<{ items: AppNotification[]; total: number; unread: number }> {
    const where = unreadOnly
      ? { userId, readAt: IsNull() }
      : { userId };
    const [items, total] = await this.repo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: offset,
      take: limit,
    });
    const unread = await this.repo.count({ where: { userId, readAt: IsNull() } });
    return { items, total, unread };
  }

  async markRead(userId: string, id: string): Promise<void> {
    await this.repo.update({ id, userId }, { readAt: new Date() });
  }

  async markAllRead(userId: string): Promise<void> {
    await this.repo.update({ userId, readAt: IsNull() }, { readAt: new Date() });
  }
}
