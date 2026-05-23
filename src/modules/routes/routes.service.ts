import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { RoutePlan } from './entities/route-plan.entity';
import { RouteStop } from './entities/route-stop.entity';
import { Rep } from '../reps/entities/rep.entity';
import { Customer } from '../customers/entities/customer.entity';
import { CreateRoutePlanDto } from './dto/create-route-plan.dto';
import {
  GenerateRoutesDto,
  MarkSkippedDto,
  MarkVisitedDto,
  ReorderStopsDto,
} from './dto/route-actions.dto';
import { ListRoutesQuery } from './dto/list-routes.query';
import { haversineMeters } from '../../common/geo/geo.util';

const AVG_SPEED_KMH = 30; // assumed van speed for ETA / duration estimates

export interface ComplianceRow {
  repId: string;
  planId: string;
  totalStops: number;
  visited: number;
  skipped: number;
  pending: number;
  completionPct: number;
}

@Injectable()
export class RoutesService {
  constructor(
    @InjectRepository(RoutePlan)
    private readonly plans: Repository<RoutePlan>,
    @InjectRepository(RouteStop)
    private readonly stops: Repository<RouteStop>,
    @InjectRepository(Rep)
    private readonly reps: Repository<Rep>,
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
  ) {}

  async list(query: ListRoutesQuery): Promise<RoutePlan[]> {
    const qb = this.plans
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.stops', 's')
      .orderBy('p.plan_date', 'DESC')
      .addOrderBy('s.stop_order', 'ASC');
    if (query.date) qb.andWhere('p.plan_date = :d', { d: query.date });
    if (query.repId) qb.andWhere('p.rep_id = :r', { r: query.repId });
    return qb.getMany();
  }

  async findOne(id: string): Promise<RoutePlan> {
    const plan = await this.plans.findOne({
      where: { id },
      relations: { stops: true },
      order: { stops: { stopOrder: 'ASC' } },
    });
    if (!plan) throw new NotFoundException(`Route plan ${id} not found`);
    return plan;
  }

  async findByRepAndDate(repId: string, date: string): Promise<RoutePlan | null> {
    return this.plans.findOne({
      where: { repId, planDate: date },
      relations: { stops: true },
      order: { stops: { stopOrder: 'ASC' } },
    });
  }

  async createPlan(dto: CreateRoutePlanDto): Promise<RoutePlan> {
    await this.assertRep(dto.repId);
    const exists = await this.plans.exist({
      where: { repId: dto.repId, planDate: dto.planDate },
    });
    if (exists) {
      throw new ConflictException(
        `A route plan already exists for rep ${dto.repId} on ${dto.planDate}`,
      );
    }
    await this.assertCustomers(dto.stops.map((s) => s.customerId));

    const plan = this.plans.create({
      repId: dto.repId,
      planDate: dto.planDate,
      source: 'manual',
      stops: dto.stops.map((s, i) =>
        this.stops.create({
          customerId: s.customerId,
          stopOrder: s.stopOrder ?? i + 1,
          estDurationMin: s.estDurationMin ?? 20,
          status: 'pending',
        }),
      ),
    });
    return this.plans.save(plan);
  }

  async reorderStops(planId: string, dto: ReorderStopsDto): Promise<RoutePlan> {
    const plan = await this.findOne(planId);
    const validIds = new Set((plan.stops ?? []).map((s) => s.id));
    for (const o of dto.order) {
      if (!validIds.has(o.stopId)) {
        throw new BadRequestException(`Stop ${o.stopId} is not part of plan ${planId}`);
      }
    }
    await this.stops.manager.transaction(async (em) => {
      for (const o of dto.order) {
        await em.getRepository(RouteStop).update({ id: o.stopId }, { stopOrder: o.stopOrder });
      }
    });
    return this.findOne(planId);
  }

  async markVisited(stopId: string, dto: MarkVisitedDto): Promise<RouteStop> {
    const stop = await this.getStop(stopId);
    stop.status = 'visited';
    stop.actualArrival = dto.actualArrival ? new Date(dto.actualArrival) : new Date();
    stop.actualDeparture = dto.actualDeparture ? new Date(dto.actualDeparture) : null;
    stop.skipReason = null;
    return this.stops.save(stop);
  }

  async markSkipped(stopId: string, dto: MarkSkippedDto): Promise<RouteStop> {
    const stop = await this.getStop(stopId);
    stop.status = 'skipped';
    stop.skipReason = dto.reason;
    return this.stops.save(stop);
  }

  async compliance(date: string): Promise<ComplianceRow[]> {
    const rows = (await this.plans
      .createQueryBuilder('p')
      .leftJoin('p.stops', 's')
      .select('p.id', 'plan_id')
      .addSelect('p.rep_id', 'rep_id')
      .addSelect('COUNT(s.id)', 'total')
      .addSelect(`COUNT(s.id) FILTER (WHERE s.status = 'visited')`, 'visited')
      .addSelect(`COUNT(s.id) FILTER (WHERE s.status = 'skipped')`, 'skipped')
      .addSelect(`COUNT(s.id) FILTER (WHERE s.status = 'pending')`, 'pending')
      .where('p.plan_date = :d', { d: date })
      .groupBy('p.id')
      .addGroupBy('p.rep_id')
      .getRawMany()) as Array<{
      plan_id: string;
      rep_id: string;
      total: string;
      visited: string;
      skipped: string;
      pending: string;
    }>;

    return rows.map((r) => {
      const total = Number(r.total);
      const visited = Number(r.visited);
      return {
        repId: r.rep_id,
        planId: r.plan_id,
        totalStops: total,
        visited,
        skipped: Number(r.skipped),
        pending: Number(r.pending),
        completionPct: total > 0 ? Math.round((visited / total) * 1000) / 10 : 0,
      };
    });
  }

  async accept(planId: string): Promise<RoutePlan> {
    const plan = await this.findOne(planId);
    plan.acceptedAt = new Date();
    await this.plans.save(plan);
    return this.findOne(planId);
  }

  /**
   * Build optimized plans for the given reps using a nearest-neighbor heuristic
   * over each rep's assigned customers (those with coordinates). Replaceable by
   * the plan-08 AI optimizer behind the same endpoint.
   */
  async generate(dto: GenerateRoutesDto): Promise<RoutePlan[]> {
    const results: RoutePlan[] = [];
    for (const repId of dto.repIds) {
      await this.assertRep(repId);
      const custs = await this.customers.find({
        where: { repId, isActive: true },
      });
      const located = custs.filter((c) => c.latitude != null && c.longitude != null);
      if (located.length === 0) continue;

      const naiveOrder = [...located];
      const optimized = nearestNeighbor(located);

      const naiveDist = pathDistanceMeters(naiveOrder);
      const optDist = pathDistanceMeters(optimized);
      const optDurationMin = Math.round((optDist / 1000 / AVG_SPEED_KMH) * 60) + optimized.length * 20;
      const naiveDurationMin = Math.round((naiveDist / 1000 / AVG_SPEED_KMH) * 60) + naiveOrder.length * 20;

      // Replace any existing plan for that rep+date.
      await this.plans.delete({ repId, planDate: dto.planDate });

      const plan = this.plans.create({
        repId,
        planDate: dto.planDate,
        source: 'ai_optimized',
        aiEstDistance: Math.round((optDist / 1000) * 100) / 100,
        aiEstDuration: optDurationMin,
        aiSavingsMin: Math.max(0, naiveDurationMin - optDurationMin),
        stops: optimized.map((c, i) =>
          this.stops.create({
            customerId: c.id,
            stopOrder: i + 1,
            estDurationMin: 20,
            status: 'pending',
          }),
        ),
      });
      results.push(await this.plans.save(plan));
    }
    return results;
  }

  private async getStop(stopId: string): Promise<RouteStop> {
    const stop = await this.stops.findOne({ where: { id: stopId } });
    if (!stop) throw new NotFoundException(`Route stop ${stopId} not found`);
    return stop;
  }

  private async assertRep(repId: string): Promise<void> {
    if (!(await this.reps.exist({ where: { id: repId } }))) {
      throw new NotFoundException(`Rep ${repId} not found`);
    }
  }

  private async assertCustomers(ids: string[]): Promise<void> {
    const found = await this.customers.count({ where: { id: In(ids) } });
    if (found !== new Set(ids).size) {
      throw new BadRequestException('One or more customers do not exist');
    }
  }
}

// ---- helpers ----

type Located = Customer;

function coord(c: Located): [number, number] {
  return [Number(c.latitude), Number(c.longitude)];
}

function nearestNeighbor(points: Located[]): Located[] {
  if (points.length <= 2) return points;
  const remaining = [...points];
  const ordered: Located[] = [remaining.shift()!];
  while (remaining.length > 0) {
    const [lastLat, lastLng] = coord(ordered[ordered.length - 1]);
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const [lat, lng] = coord(remaining[i]);
      const d = haversineMeters(lastLat, lastLng, lat, lng);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }
  return ordered;
}

function pathDistanceMeters(points: Located[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const [aLat, aLng] = coord(points[i - 1]);
    const [bLat, bLng] = coord(points[i]);
    total += haversineMeters(aLat, aLng, bLat, bLng);
  }
  return total;
}
