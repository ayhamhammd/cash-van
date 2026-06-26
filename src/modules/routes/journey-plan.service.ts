import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { JourneyPlanEntry } from './entities/journey-plan-entry.entity';
import { Rep } from '../reps/entities/rep.entity';
import { Customer } from '../customers/entities/customer.entity';
import {
  BulkSetJourneyPlanDto,
  UpsertJourneyPlanDto,
} from './dto/journey-plan.dto';

/** A journey-plan row enriched with the outlet's display + map fields. */
export interface JourneyPlanRow {
  id: string;
  customerId: string;
  customerNumber: string;
  customerName: string;
  nameAr: string | null;
  nameEn: string | null;
  city: string | null;
  addressAr: string | null;
  phone: string | null;
  lat: number | null;
  lng: number | null;
  weekdays: number[];
  note: string | null;
  todo: string | null;
  sortOrder: number;
  isActive: boolean;
  /** True when the salesman already marked the to-do done today. */
  todoDoneToday: boolean;
}

@Injectable()
export class JourneyPlanService {
  constructor(
    @InjectRepository(JourneyPlanEntry)
    private readonly entries: Repository<JourneyPlanEntry>,
    @InjectRepository(Rep)
    private readonly reps: Repository<Rep>,
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
  ) {}

  /** All schedule rows for a rep, enriched with outlet info (ordered for display). */
  async list(repId: string): Promise<JourneyPlanRow[]> {
    await this.assertRep(repId);
    return this.rows((qb) =>
      qb.where('e.rep_id = :repId', { repId }).orderBy('e.sort_order', 'ASC'),
    );
  }

  /**
   * Outlets a rep visits on `weekday` (0=Sun..6=Sat) — active entries only,
   * ordered by manual sort then name. Used for the day map view + mobile.
   */
  async day(repId: string, weekday: number): Promise<JourneyPlanRow[]> {
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new BadRequestException('weekday must be an integer 0..6');
    }
    await this.assertRep(repId);
    return this.rows((qb) =>
      qb
        .where('e.rep_id = :repId', { repId })
        .andWhere('e.is_active = true')
        .andWhere(':weekday = ANY(e.weekdays)', { weekday })
        .orderBy('e.sort_order', 'ASC')
        .addOrderBy('c.customer_name', 'ASC'),
    );
  }

  /** Create or update the schedule for one outlet under a rep. */
  async upsert(
    repId: string,
    customerId: string,
    dto: UpsertJourneyPlanDto,
  ): Promise<JourneyPlanRow> {
    await this.assertRep(repId);
    await this.assertCustomerServable(repId, customerId);

    let entry = await this.entries.findOne({ where: { repId, customerId } });
    if (entry) {
      entry.weekdays = normalizeWeekdays(dto.weekdays);
      if (dto.isActive !== undefined) entry.isActive = dto.isActive;
      if (dto.note !== undefined) entry.note = dto.note;
      if (dto.todo !== undefined) entry.todo = dto.todo;
      if (dto.sortOrder !== undefined) entry.sortOrder = dto.sortOrder;
    } else {
      entry = this.entries.create({
        repId,
        customerId,
        weekdays: normalizeWeekdays(dto.weekdays),
        isActive: dto.isActive ?? true,
        note: dto.note ?? null,
        todo: dto.todo ?? null,
        sortOrder: dto.sortOrder ?? 0,
      });
    }
    const saved = await this.entries.save(entry);
    return this.rowById(saved.id);
  }

  async remove(repId: string, customerId: string): Promise<void> {
    const res = await this.entries.delete({ repId, customerId });
    if (!res.affected) {
      throw new NotFoundException(
        `No journey-plan entry for customer ${customerId} under rep ${repId}`,
      );
    }
  }

  /** Replace a rep's whole journey plan with the provided set. */
  async bulkSet(
    repId: string,
    dto: BulkSetJourneyPlanDto,
  ): Promise<JourneyPlanRow[]> {
    await this.assertRep(repId);
    const ids = dto.entries.map((e) => e.customerId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Duplicate customerId in entries');
    }
    for (const id of ids) await this.assertCustomerServable(repId, id);

    await this.entries.manager.transaction(async (em) => {
      const repo = em.getRepository(JourneyPlanEntry);
      await repo.delete({ repId });
      if (dto.entries.length) {
        await repo.insert(
          dto.entries.map((e, i) =>
            repo.create({
              repId,
              customerId: e.customerId,
              weekdays: normalizeWeekdays(e.weekdays),
              isActive: e.isActive ?? true,
              note: e.note ?? null,
              todo: e.todo ?? null,
              sortOrder: e.sortOrder ?? i,
            }),
          ),
        );
      }
    });
    return this.list(repId);
  }

  /** Salesman marks an outlet's to-do done for today. */
  async markTodoDone(repId: string, customerId: string): Promise<JourneyPlanRow> {
    const entry = await this.entries.findOne({ where: { repId, customerId } });
    if (!entry) {
      throw new NotFoundException(
        `No journey-plan entry for customer ${customerId} under rep ${repId}`,
      );
    }
    entry.todoDoneDate = todayStr();
    await this.entries.save(entry);
    return this.rowById(entry.id);
  }

  /**
   * Outlet ids a rep should visit on `date` — active schedules whose weekdays
   * include the date's day-of-week (0=Sun..6=Sat, computed in UTC).
   */
  async dueCustomerIds(repId: string, date: string): Promise<string[]> {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const rows = await this.entries
      .createQueryBuilder('e')
      .select('e.customer_id', 'customerId')
      .where('e.rep_id = :repId', { repId })
      .andWhere('e.is_active = true')
      .andWhere(':dow = ANY(e.weekdays)', { dow })
      .getRawMany<{ customerId: string }>();
    return rows.map((r) => r.customerId);
  }

  /** Resolve the rep id linked to a user (for the salesman-facing endpoints). */
  assertSelfRep(repId: string | null): string {
    if (!repId) {
      throw new ForbiddenException('This account is not linked to a salesman');
    }
    return repId;
  }

  /* ----------------------------- helpers ------------------------------ */

  private async rowById(id: string): Promise<JourneyPlanRow> {
    const rows = await this.rows((qb) => qb.where('e.id = :id', { id }));
    return rows[0];
  }

  /** Build enriched rows by joining customers; caller adds where/order. */
  private async rows(
    apply: (
      qb: ReturnType<Repository<JourneyPlanEntry>['createQueryBuilder']>,
    ) => unknown,
  ): Promise<JourneyPlanRow[]> {
    const qb = this.entries
      .createQueryBuilder('e')
      .innerJoin(Customer, 'c', 'c.id = e.customer_id')
      .select([
        'e.id AS id',
        'e.customer_id AS "customerId"',
        'c.customer_number AS "customerNumber"',
        'c.customer_name AS "customerName"',
        'c.name_ar AS "nameAr"',
        'c.name_en AS "nameEn"',
        'c.city AS city',
        'c.address_ar AS "addressAr"',
        'c.phone AS phone',
        'c.latitude AS lat',
        'c.longitude AS lng',
        'e.weekdays AS weekdays',
        'e.note AS note',
        'e.todo AS todo',
        'e.sort_order AS "sortOrder"',
        'e.is_active AS "isActive"',
        'e.todo_done_date AS "todoDoneDate"',
      ]);
    apply(qb);
    const raw = await qb.getRawMany<{
      id: string;
      customerId: string;
      customerNumber: string;
      customerName: string;
      nameAr: string | null;
      nameEn: string | null;
      city: string | null;
      addressAr: string | null;
      phone: string | null;
      lat: string | null;
      lng: string | null;
      weekdays: number[];
      note: string | null;
      todo: string | null;
      sortOrder: number;
      isActive: boolean;
      todoDoneDate: string | null;
    }>();
    const today = todayStr();
    return raw.map((r) => ({
      id: r.id,
      customerId: r.customerId,
      customerNumber: r.customerNumber,
      customerName: r.customerName,
      nameAr: r.nameAr,
      nameEn: r.nameEn,
      city: r.city,
      addressAr: r.addressAr,
      phone: r.phone,
      lat: r.lat === null ? null : Number(r.lat),
      lng: r.lng === null ? null : Number(r.lng),
      weekdays: r.weekdays,
      note: r.note,
      todo: r.todo,
      sortOrder: r.sortOrder,
      isActive: r.isActive,
      todoDoneToday: ymdOf(r.todoDoneDate) === today,
    }));
  }

  private async assertRep(repId: string): Promise<void> {
    if (!(await this.reps.exist({ where: { id: repId } }))) {
      throw new NotFoundException(`Rep ${repId} not found`);
    }
  }

  /** Outlet must exist and either be unassigned or belong to this rep. */
  private async assertCustomerServable(
    repId: string,
    customerId: string,
  ): Promise<void> {
    const customer = await this.customers.findOne({ where: { id: customerId } });
    if (!customer) {
      throw new BadRequestException(`Customer ${customerId} does not exist`);
    }
    if (customer.repId && customer.repId !== repId) {
      throw new BadRequestException(
        `Customer ${customerId} is assigned to a different rep`,
      );
    }
  }
}

function normalizeWeekdays(days: number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Local server date as YYYY-MM-DD. */
function todayStr(): string {
  return ymdOf(new Date())!;
}

/** Normalise a pg `date` value (Date or string) to a local YYYY-MM-DD, or null. */
function ymdOf(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    const m = `${v.getMonth() + 1}`.padStart(2, '0');
    const day = `${v.getDate()}`.padStart(2, '0');
    return `${v.getFullYear()}-${m}-${day}`;
  }
  return String(v).slice(0, 10);
}
