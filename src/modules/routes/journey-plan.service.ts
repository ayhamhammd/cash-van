import {
  BadRequestException,
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

  /** All schedule rows for a rep (most recently updated first). */
  async list(repId: string): Promise<JourneyPlanEntry[]> {
    await this.assertRep(repId);
    return this.entries.find({
      where: { repId },
      order: { updatedAt: 'DESC' },
    });
  }

  /** Create or update the schedule for one outlet under a rep. */
  async upsert(
    repId: string,
    customerId: string,
    dto: UpsertJourneyPlanDto,
  ): Promise<JourneyPlanEntry> {
    await this.assertRep(repId);
    await this.assertCustomerServable(repId, customerId);

    const existing = await this.entries.findOne({
      where: { repId, customerId },
    });
    if (existing) {
      existing.weekdays = normalizeWeekdays(dto.weekdays);
      if (dto.isActive !== undefined) existing.isActive = dto.isActive;
      return this.entries.save(existing);
    }
    const created = this.entries.create({
      repId,
      customerId,
      weekdays: normalizeWeekdays(dto.weekdays),
      isActive: dto.isActive ?? true,
    });
    return this.entries.save(created);
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
  ): Promise<JourneyPlanEntry[]> {
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
          dto.entries.map((e) =>
            repo.create({
              repId,
              customerId: e.customerId,
              weekdays: normalizeWeekdays(e.weekdays),
              isActive: e.isActive ?? true,
            }),
          ),
        );
      }
    });
    return this.list(repId);
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
