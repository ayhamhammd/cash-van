import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import dayjs from 'dayjs';

import { Rep } from '../reps/entities/rep.entity';
import { NotificationsService } from './notifications.service';

/**
 * Turns rep liveness domain events into manager-inbox notifications carrying the
 * rep's name + phone, so an admin can call the rep. Runs alongside (not instead
 * of) RuleEvaluator's log-dispatch path. Every handler is fail-safe: a listener
 * exception must never bubble into the emitter.
 */
@Injectable()
export class RepStatusAlertsListener {
  private readonly logger = new Logger(RepStatusAlertsListener.name);

  constructor(
    @InjectRepository(Rep) private readonly reps: Repository<Rep>,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent('rep.offline')
  async onOffline(p: { repId: string; lastSeen: Date | null }): Promise<void> {
    try {
      const rep = await this.reps.findOne({ where: { id: p.repId } });
      if (!rep) return;
      const nameAr = rep.nameAr;
      const nameEn = rep.nameEn ?? rep.nameAr;
      const phone = rep.phone ?? '—';
      const time = p.lastSeen ? dayjs(p.lastSeen).format('HH:mm') : '—';
      await this.notifications.notifyManagers({
        kind: 'rep.offline',
        titleAr: `انقطع اتصال المندوب: ${nameAr}`,
        titleEn: `Rep offline: ${nameEn}`,
        bodyAr: `لا توجد إشارة من المندوب ${nameAr} منذ الساعة ${time}. الرجاء الاتصال به: ${phone}`,
        bodyEn: `No signal from ${nameEn} since ${time} (internet lost or app closed). Call: ${phone}`,
        refType: 'rep',
        refId: p.repId,
      });
    } catch (err) {
      this.logger.error(`onOffline(${p.repId}) failed: ${(err as Error).message}`);
    }
  }

  @OnEvent('rep.gps_off')
  async onGpsOff(p: { repId: string; at: Date }): Promise<void> {
    try {
      const rep = await this.reps.findOne({ where: { id: p.repId } });
      if (!rep) return;
      const nameAr = rep.nameAr;
      const nameEn = rep.nameEn ?? rep.nameAr;
      const phone = rep.phone ?? '—';
      await this.notifications.notifyManagers({
        kind: 'rep.gps_off',
        titleAr: `تم إيقاف تحديد المواقع (GPS): ${nameAr}`,
        titleEn: `GPS turned off: ${nameEn}`,
        bodyAr: `قام المندوب ${nameAr} بإيقاف خدمة الموقع مع بقاء الجهاز متصلاً بالإنترنت. الرجاء الاتصال به: ${phone}`,
        bodyEn: `${nameEn} disabled location services while the device is still online. Call: ${phone}`,
        refType: 'rep',
        refId: p.repId,
      });
    } catch (err) {
      this.logger.error(`onGpsOff(${p.repId}) failed: ${(err as Error).message}`);
    }
  }

  @OnEvent('rep.online')
  async onOnline(p: { repId: string; at: Date }): Promise<void> {
    try {
      const rep = await this.reps.findOne({ where: { id: p.repId } });
      if (!rep) return;
      const nameAr = rep.nameAr;
      const nameEn = rep.nameEn ?? rep.nameAr;
      await this.notifications.notifyManagers({
        kind: 'rep.online',
        titleAr: `عاد المندوب للاتصال: ${nameAr}`,
        titleEn: `Rep back online: ${nameEn}`,
        bodyAr: `استؤنف الاتصال بالمندوب ${nameAr}.`,
        bodyEn: `Connection with ${nameEn} has resumed.`,
        refType: 'rep',
        refId: p.repId,
      });
    } catch (err) {
      this.logger.error(`onOnline(${p.repId}) failed: ${(err as Error).message}`);
    }
  }
}
