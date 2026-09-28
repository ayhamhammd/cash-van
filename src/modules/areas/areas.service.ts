import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

import { Customer } from '../customers/entities/customer.entity';
import { CustomerArea } from './entities/customer-area.entity';
import { CreateAreaDto, ListAreaMembersQuery, UpdateAreaDto } from './dto/area.dto';

export interface AreaRow {
  id: string;
  nameAr: string;
  nameEn: string | null;
  color: string | null;
  isActive: boolean;
  memberCount: number;
}

/**
 * Areas: an office-managed division of the customer book, one area per customer.
 *
 * Every write that moves a customer tells the vans to re-pull, so a rep's area
 * filter follows the office without waiting for a manual refresh.
 */
@Injectable()
export class AreasService {
  constructor(
    @InjectRepository(CustomerArea) private readonly areas: Repository<CustomerArea>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    private readonly events: EventEmitter2,
  ) {}

  async list(): Promise<{ items: AreaRow[]; total: number }> {
    const rows: Array<AreaRow & { memberCount: string }> = await this.areas.query(
      `SELECT a.id, a.name_ar AS "nameAr", a.name_en AS "nameEn", a.color,
              a.is_active AS "isActive",
              (SELECT COUNT(*) FROM customers c
                WHERE c.area_id = a.id AND c.deleted_at IS NULL) AS "memberCount"
         FROM customer_areas a
        WHERE a.deleted_at IS NULL
        ORDER BY a.name_ar ASC`,
    );
    const items = rows.map((r) => ({ ...r, memberCount: Number(r.memberCount) || 0 }));
    return { items, total: items.length };
  }

  /** Active areas, for a picker — what a rep may file a new customer under. */
  async options(): Promise<Array<{ id: string; nameAr: string; nameEn: string | null; color: string | null }>> {
    const rows = await this.areas.find({ where: { isActive: true }, order: { nameAr: 'ASC' } });
    return rows.map((r) => ({ id: r.id, nameAr: r.nameAr, nameEn: r.nameEn ?? null, color: r.color ?? null }));
  }

  async getOne(id: string): Promise<CustomerArea> {
    const area = await this.areas.findOne({ where: { id } });
    if (!area) throw new NotFoundException('This area no longer exists. Refresh the areas list.');
    return area;
  }

  async create(dto: CreateAreaDto): Promise<CustomerArea> {
    await this.assertNameFree(dto.nameAr);
    return this.areas.save(
      this.areas.create({
        nameAr: dto.nameAr.trim(),
        nameEn: dto.nameEn?.trim() || null,
        color: dto.color ?? null,
        isActive: dto.isActive ?? true,
      }),
    );
  }

  async update(id: string, dto: UpdateAreaDto): Promise<CustomerArea> {
    const area = await this.getOne(id);
    if (dto.nameAr !== undefined && dto.nameAr.trim() !== area.nameAr) {
      await this.assertNameFree(dto.nameAr, id);
      area.nameAr = dto.nameAr.trim();
    }
    if (dto.nameEn !== undefined) area.nameEn = dto.nameEn.trim() || null;
    if (dto.color !== undefined) area.color = dto.color;
    if (dto.isActive !== undefined) area.isActive = dto.isActive;
    const saved = await this.areas.save(area);
    this.changed('area.updated');
    return saved;
  }

  /** Deleting an area leaves its customers in none, rather than refusing. */
  async remove(id: string): Promise<void> {
    await this.getOne(id);
    await this.customers.update({ areaId: id }, { areaId: null });
    await this.areas.softDelete(id);
    this.changed('area.deleted');
  }

  async members(
    id: string,
    q: ListAreaMembersQuery,
  ): Promise<{ items: Customer[]; total: number }> {
    await this.getOne(id);
    const qb = this.customers
      .createQueryBuilder('c')
      .where('c.deleted_at IS NULL')
      .andWhere('c.area_id = :id', { id })
      .orderBy('c.name_ar', 'ASC')
      .addOrderBy('c.id', 'ASC')
      .take(q.limit ?? 50)
      .skip(q.offset ?? 0);
    if (q.q?.trim()) {
      qb.andWhere('(c.name_ar ILIKE :s OR c.customer_number ILIKE :s)', { s: `%${q.q.trim()}%` });
    }
    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  /** Move customers into this area. A customer has one area, so this replaces any other. */
  async addMembers(id: string, customerIds: string[]): Promise<{ moved: number }> {
    const area = await this.getOne(id);
    if (!area.isActive) {
      throw new BadRequestException(
        'This area is deactivated. Activate it from the Areas page before adding customers.',
      );
    }
    const found = await this.customers.count({ where: { id: In(customerIds), deletedAt: IsNull() } });
    if (found !== customerIds.length) {
      throw new BadRequestException(
        'Some of the chosen customers no longer exist. Refresh the list and choose again.',
      );
    }
    const res = await this.customers.update({ id: In(customerIds) }, { areaId: id });
    this.changed('area.members');
    return { moved: res.affected ?? 0 };
  }

  async removeMember(id: string, customerId: string): Promise<void> {
    await this.getOne(id);
    await this.customers.update({ id: customerId, areaId: id }, { areaId: null });
    this.changed('area.members');
  }

  /**
   * An area a customer may be filed under: it must exist and be active. The id
   * comes from a picker this server filled, so a miss means the app holds a
   * stale list, and saving the customer with no area would hide that.
   */
  async assertAssignable(areaId: string | null | undefined): Promise<void> {
    if (!areaId) return;
    const area = await this.areas.findOne({ where: { id: areaId } });
    if (!area) {
      throw new BadRequestException(
        'The chosen area no longer exists. Refresh the areas list and choose again.',
      );
    }
    if (!area.isActive) {
      throw new BadRequestException(
        'The chosen area is deactivated. Choose another area, or activate it from the Areas page.',
      );
    }
  }

  private async assertNameFree(nameAr: string, exceptId?: string): Promise<void> {
    const clash = await this.areas.findOne({ where: { nameAr: nameAr.trim() } });
    if (clash && clash.id !== exceptId) {
      throw new ConflictException(`An area named "${nameAr.trim()}" already exists. Use a different name.`);
    }
  }

  private changed(reason: string): void {
    this.events.emit('customer.changed', { reason });
  }
}
