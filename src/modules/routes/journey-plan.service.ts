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
  SetRouteCycleDto,
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
  /** Day indices within the rep's cycle. */
  cycleDays: number[];
  /**
   * Same values under the old name, for handsets built before route cycles
   * existed. Correct for a 7-day cycle, which is what those builds assume.
   * @deprecated read `cycleDays`.
   */
  weekdays: number[];
  note: string | null;
  todo: string | null;
  sortOrder: number;
  isActive: boolean;
  /** True when the salesman already marked the to-do done today. */
  todoDoneToday: boolean;
}

/** A rep's route cycle: how long it runs, and where it starts counting. */
export interface RouteCycleInfo {
  cycleDays: number;
  anchorDate: string;
  name: string | null;
  /** Which day of the cycle today falls on. */
  todayIndex: number;
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
   * Outlets a rep visits on a given day of their cycle — active entries only,
   * ordered by manual sort then name. Used for the day map view + mobile.
   */
  async day(repId: string, dayIndex: number): Promise<JourneyPlanRow[]> {
    const rep = await this.loadRep(repId);
    const n = cycleLengthOf(rep);
    if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= n) {
      throw new BadRequestException(
        `day must be an integer 0..${n - 1} for this rep's ${n}-day cycle`,
      );
    }
    return this.rows((qb) =>
      qb
        .where('e.rep_id = :repId', { repId })
        .andWhere('e.is_active = true')
        .andWhere(':dayIndex = ANY(e.cycle_days)', { dayIndex })
        .orderBy('e.sort_order', 'ASC')
        .addOrderBy('c.customer_name', 'ASC'),
    );
  }

  /** Outlets due for a rep on a calendar date, resolved through their cycle. */
  async dayForDate(repId: string, date: string): Promise<JourneyPlanRow[]> {
    const rep = await this.loadRep(repId);
    return this.day(repId, cycleIndexOf(rep, date));
  }

  /* --------------------------- route cycle ---------------------------- */

  /** The rep's cycle, plus where today sits in it. */
  async cycle(repId: string): Promise<RouteCycleInfo> {
    const rep = await this.loadRep(repId);
    return this.cycleInfoOf(rep);
  }

  /**
   * Change a rep's cycle length, anchor or name.
   *
   * Shrinking is the dangerous direction: going 14 → 7 leaves entries sitting
   * on days 7..13 that can never come due again, so those outlets silently drop
   * off the route and nobody notices for a month. Rather than discard visits on
   * the quiet, this refuses and names the outlets; `force` then drops only the
   * out-of-range days, deleting an entry outright only when it has none left.
   */
  async setCycle(repId: string, dto: SetRouteCycleDto): Promise<RouteCycleInfo> {
    const rep = await this.loadRep(repId);
    const next = dto.cycleDays ?? cycleLengthOf(rep);

    if (next < cycleLengthOf(rep)) {
      const affected = await this.entriesBeyond(repId, next);
      if (affected.length && !dto.force) {
        throw new BadRequestException({
          message:
            `Shrinking to ${next} days would strand ${affected.length} outlet(s) ` +
            `scheduled beyond day ${next - 1}. Re-send with force=true to drop those days.`,
          code: 'ROUTE_CYCLE_WOULD_STRAND_OUTLETS',
          outlets: affected,
        });
      }
      if (affected.length) await this.trimEntriesTo(repId, next);
    }

    rep.routeCycleDays = next;
    if (dto.anchorDate !== undefined) rep.routeCycleAnchor = dto.anchorDate;
    if (dto.name !== undefined) rep.routeCycleName = dto.name;
    await this.reps.save(rep);
    return this.cycleInfoOf(rep);
  }

  /** Create or update the schedule for one outlet under a rep. */
  async upsert(
    repId: string,
    customerId: string,
    dto: UpsertJourneyPlanDto,
  ): Promise<JourneyPlanRow> {
    const rep = await this.loadRep(repId);
    await this.assertCustomerServable(repId, customerId);
    const days = this.validDays(dto, rep);

    let entry = await this.entries.findOne({ where: { repId, customerId } });
    if (entry) {
      entry.cycleDays = days;
      if (dto.isActive !== undefined) entry.isActive = dto.isActive;
      if (dto.note !== undefined) entry.note = dto.note;
      if (dto.todo !== undefined) entry.todo = dto.todo;
      if (dto.sortOrder !== undefined) entry.sortOrder = dto.sortOrder;
    } else {
      entry = this.entries.create({
        repId,
        customerId,
        cycleDays: days,
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
    const rep = await this.loadRep(repId);
    const ids = dto.entries.map((e) => e.customerId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Duplicate customerId in entries');
    }
    for (const id of ids) await this.assertCustomerServable(repId, id);
    // Validate every row before writing any, so a bad day index on the last
    // entry cannot leave the plan half-replaced.
    const days = dto.entries.map((e) => this.validDays(e, rep));

    await this.entries.manager.transaction(async (em) => {
      const repo = em.getRepository(JourneyPlanEntry);
      await repo.delete({ repId });
      if (dto.entries.length) {
        await repo.insert(
          dto.entries.map((e, i) =>
            repo.create({
              repId,
              customerId: e.customerId,
              cycleDays: days[i]!,
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
   * Outlet ids a rep should visit on `date` — active schedules that include the
   * day `date` falls on in that rep's cycle.
   *
   * This is the single place the recurrence rule lives: route planning,
   * adherence and the mobile day view all resolve through here, so a cycle of
   * any length is understood everywhere the moment it is understood here.
   */
  async dueCustomerIds(repId: string, date: string): Promise<string[]> {
    const rep = await this.loadRep(repId);
    const dayIndex = cycleIndexOf(rep, date);
    const rows = await this.entries
      .createQueryBuilder('e')
      .select('e.customer_id', 'customerId')
      .where('e.rep_id = :repId', { repId })
      .andWhere('e.is_active = true')
      .andWhere(':dayIndex = ANY(e.cycle_days)', { dayIndex })
      .getRawMany<{ customerId: string }>();
    return rows.map((r) => r.customerId);
  }

  /**
   * How far back missed-visit carry-forward should look for this rep.
   *
   * A fixed 30 days silently drops misses from the previous cycle once the
   * cycle is longer than a month, so it scales with the cycle: two full cycles,
   * never less than the old 30 days.
   */
  async carryForwardLookbackDays(repId: string): Promise<number> {
    const rep = await this.loadRep(repId);
    return Math.max(30, cycleLengthOf(rep) * 2);
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
        'e.cycle_days AS "cycleDays"',
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
      cycleDays: number[];
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
      cycleDays: r.cycleDays,
      weekdays: r.cycleDays,
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

  /** The rep row itself — needed wherever the cycle has to be resolved. */
  private async loadRep(repId: string): Promise<Rep> {
    const rep = await this.reps.findOne({ where: { id: repId } });
    if (!rep) throw new NotFoundException(`Rep ${repId} not found`);
    return rep;
  }

  private cycleInfoOf(rep: Rep): RouteCycleInfo {
    return {
      cycleDays: cycleLengthOf(rep),
      anchorDate: ymdOf(rep.routeCycleAnchor) ?? DEFAULT_ANCHOR,
      name: rep.routeCycleName ?? null,
      todayIndex: cycleIndexOf(rep, todayStr()),
    };
  }

  /**
   * Accept `cycleDays`, falling back to the old `weekdays` field so a handset
   * built before route cycles existed still writes a valid plan.
   */
  private validDays(
    dto: { cycleDays?: number[]; weekdays?: number[] },
    rep: Rep,
  ): number[] {
    const raw = dto.cycleDays ?? dto.weekdays;
    if (!raw?.length) {
      throw new BadRequestException('cycleDays must list at least one day');
    }
    const n = cycleLengthOf(rep);
    const bad = raw.filter((d) => !Number.isInteger(d) || d < 0 || d >= n);
    if (bad.length) {
      throw new BadRequestException(
        `Day(s) ${bad.join(', ')} are outside this rep's ${n}-day cycle (0..${n - 1})`,
      );
    }
    return [...new Set(raw)].sort((a, b) => a - b);
  }

  /** Outlets scheduled on a day index at or beyond `limit`. */
  private async entriesBeyond(
    repId: string,
    limit: number,
  ): Promise<Array<{ customerId: string; customerName: string | null; days: number[] }>> {
    const rows = (await this.entries.manager.query(
      `SELECT e."customer_id" AS "customerId",
              c."customer_name" AS "customerName",
              e."cycle_days"   AS "days"
         FROM "journey_plan_entries" e
         JOIN "customers" c ON c."id" = e."customer_id"
        WHERE e."rep_id" = $1
          AND EXISTS (SELECT 1 FROM unnest(e."cycle_days") d WHERE d >= $2)
        ORDER BY c."customer_name"`,
      [repId, limit],
    )) as Array<{ customerId: string; customerName: string | null; days: number[] }>;
    return rows;
  }

  /** Drop out-of-range days; remove entries left with no days at all. */
  private async trimEntriesTo(repId: string, limit: number): Promise<void> {
    await this.entries.manager.transaction(async (em) => {
      await em.query(
        `UPDATE "journey_plan_entries"
            SET "cycle_days" = ARRAY(SELECT d FROM unnest("cycle_days") d WHERE d < $2)
          WHERE "rep_id" = $1`,
        [repId, limit],
      );
      await em.query(
        `DELETE FROM "journey_plan_entries"
          WHERE "rep_id" = $1 AND cardinality("cycle_days") = 0`,
        [repId],
      );
    });
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

/** A Sunday, so a 7-day cycle lines up with 0=Sunday..6=Saturday. */
const DEFAULT_ANCHOR = '2024-01-07';

function cycleLengthOf(rep: Rep): number {
  const n = Number(rep.routeCycleDays);
  return Number.isInteger(n) && n > 0 ? n : 7;
}

/**
 * Which day of the rep's cycle a calendar date falls on.
 *
 * The modulo is taken twice because a date *before* the anchor gives a negative
 * remainder in JS — `-1 % 7` is `-1`, not `6` — which would silently miss every
 * plan scheduled for the last day of the cycle.
 */
function cycleIndexOf(rep: Rep, date: string): number {
  const n = cycleLengthOf(rep);
  const anchor = ymdOf(rep.routeCycleAnchor) ?? DEFAULT_ANCHOR;
  const diff = daysBetween(anchor, ymdOf(date) ?? todayStr());
  return ((diff % n) + n) % n;
}

/**
 * Whole days between two YYYY-MM-DD dates.
 *
 * Deliberately built from the date parts rather than parsing to a local
 * `Date`: the server's timezone must not decide which day of the cycle an
 * outlet is due on, or a rep near midnight sees a different route than the
 * office does.
 */
function daysBetween(fromYmd: string, toYmd: string): number {
  const MS_PER_DAY = 86_400_000;
  return Math.round((utcMsOf(toYmd) - utcMsOf(fromYmd)) / MS_PER_DAY);
}

function utcMsOf(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
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
