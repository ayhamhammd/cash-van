import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

import { RouteStop } from './entities/route-stop.entity';
import { Customer } from '../customers/entities/customer.entity';
import { haversineMeters } from '../../common/geo/geo.util';

/** A rep is "deviated" if their ping is farther than this from every pending stop. */
const DEVIATION_THRESHOLD_M = 500;

interface RepLocationEvent {
  repId: string;
  lat: number;
  lng: number;
  recordedAt: Date;
}

export interface RouteDeviation {
  repId: string;
  planId: string;
  lat: number;
  lng: number;
  nearestStopMeters: number;
  recordedAt: Date;
}

/**
 * Listens for `rep.location` (emitted by plan 02) and flags route deviations:
 * if the rep's current position is > threshold from ALL of today's still-pending
 * stops, emit `route.deviated` (plan 10 forwards over WebSocket).
 *
 * Stateful debounce: a deviation for a plan only re-fires after the rep returns
 * within range, so we don't spam one alert per ping.
 */
@Injectable()
export class RouteAdherenceService {
  private readonly logger = new Logger(RouteAdherenceService.name);
  private readonly deviatedPlans = new Set<string>();

  constructor(
    @InjectRepository(RouteStop)
    private readonly stops: Repository<RouteStop>,
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    private readonly bus: EventEmitter2,
  ) {}

  @OnEvent('rep.location')
  async onRepLocation(evt: RepLocationEvent): Promise<void> {
    try {
      await this.check(evt);
    } catch (err) {
      this.logger.warn(`adherence check failed for rep ${evt.repId}: ${(err as Error).message}`);
    }
  }

  /** Returns the deviation if one was detected (also emits the event). */
  async check(evt: RepLocationEvent): Promise<RouteDeviation | null> {
    const today = new Date(evt.recordedAt).toISOString().slice(0, 10);

    const pending = (await this.stops
      .createQueryBuilder('s')
      .innerJoin('route_plans', 'p', 'p.id = s.plan_id')
      .innerJoin(Customer, 'c', 'c.id = s.customer_id')
      .select(['p.id AS plan_id', 'c.latitude AS lat', 'c.longitude AS lng'])
      .where('p.rep_id = :repId', { repId: evt.repId })
      .andWhere('p.plan_date = :today', { today })
      .andWhere(`s.status = 'pending'`)
      .andWhere('c.latitude IS NOT NULL AND c.longitude IS NOT NULL')
      .getRawMany()) as Array<{ plan_id: string; lat: string; lng: string }>;

    if (pending.length === 0) return null;
    const planId = pending[0].plan_id;

    let nearest = Infinity;
    for (const stop of pending) {
      const d = haversineMeters(evt.lat, evt.lng, Number(stop.lat), Number(stop.lng));
      if (d < nearest) nearest = d;
    }

    if (nearest <= DEVIATION_THRESHOLD_M) {
      // Back on track — clear any prior deviation so it can fire again later.
      this.deviatedPlans.delete(planId);
      return null;
    }

    if (this.deviatedPlans.has(planId)) return null; // already alerted; debounce
    this.deviatedPlans.add(planId);

    const deviation: RouteDeviation = {
      repId: evt.repId,
      planId,
      lat: evt.lat,
      lng: evt.lng,
      nearestStopMeters: Math.round(nearest),
      recordedAt: evt.recordedAt,
    };
    this.bus.emit('route.deviated', deviation);
    this.logger.log(
      `route.deviated rep=${evt.repId} plan=${planId} nearest=${deviation.nearestStopMeters}m`,
    );
    return deviation;
  }
}
