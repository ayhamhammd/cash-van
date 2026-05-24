import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, ILike, IsNull, Not, Repository } from 'typeorm';

import { Rep } from './entities/rep.entity';
import { CreateRepDto } from './dto/create-rep.dto';
import { UpdateRepDto } from './dto/update-rep.dto';
import { ListRepsQuery } from './dto/list-reps.query';

export interface RepKpis {
  todayRevenueFils: number;
  routeCompletionPct: number;
  invoicesToday: number;
  customersAtRisk: number;
}

@Injectable()
export class RepsService {
  constructor(
    @InjectRepository(Rep)
    private readonly repo: Repository<Rep>,
  ) {}

  async list(query: ListRepsQuery): Promise<{ items: Rep[]; total: number }> {
    const qb = this.repo
      .createQueryBuilder('rep')
      .where('rep.deleted_at IS NULL')
      .orderBy('rep.name_ar', 'ASC')
      .take(query.limit ?? 50)
      .skip(query.offset ?? 0);

    if (query.regionId) {
      qb.andWhere('rep.region_id = :regionId', { regionId: query.regionId });
    }
    if (query.isActive !== undefined) {
      qb.andWhere('rep.is_active = :isActive', { isActive: query.isActive });
    }
    if (query.q) {
      qb.andWhere(
        new Brackets((b) => {
          const pattern = `%${query.q}%`;
          b.where('rep.name_ar ILIKE :p', { p: pattern })
            .orWhere('rep.name_en ILIKE :p', { p: pattern })
            .orWhere('rep.phone ILIKE :p', { p: pattern });
        }),
      );
    }

    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  async findOne(id: string): Promise<Rep> {
    const rep = await this.repo.findOne({
      where: { id, deletedAt: IsNull() },
    });
    if (!rep) throw new NotFoundException(`Rep ${id} not found`);
    return rep;
  }

  /** Resolve the rep linked to a dashboard user (1:1), or null if unlinked. */
  async findByUserId(userId: string): Promise<Rep | null> {
    return this.repo.findOne({ where: { userId, deletedAt: IsNull() } });
  }

  async findByUserIdOrThrow(userId: string): Promise<Rep> {
    const rep = await this.findByUserId(userId);
    if (!rep) {
      throw new NotFoundException('No rep is linked to this user account');
    }
    return rep;
  }

  /** KPIs for the rep linked to the current user (used by /reps/me/kpis). */
  async kpisForUser(userId: string): Promise<RepKpis> {
    const rep = await this.findByUserIdOrThrow(userId);
    return this.kpis(rep.id);
  }

  /** Resolve the rep with this salesman code (used by the mobile BFF). */
  async findByCode(code: string): Promise<Rep | null> {
    return this.repo.findOne({ where: { code, deletedAt: IsNull() } });
  }

  async create(dto: CreateRepDto): Promise<Rep> {
    if (dto.userId) await this.assertUserUnlinked(dto.userId);
    if (dto.code) await this.assertCodeUnique(dto.code);
    const rep = this.repo.create(dto);
    return this.repo.save(rep);
  }

  async update(id: string, dto: UpdateRepDto): Promise<Rep> {
    const rep = await this.findOne(id);
    if (dto.userId) await this.assertUserUnlinked(dto.userId, id);
    if (dto.code) await this.assertCodeUnique(dto.code, id);
    Object.assign(rep, dto);
    return this.repo.save(rep);
  }

  private async assertCodeUnique(code: string, exceptRepId?: string): Promise<void> {
    const existing = await this.repo.findOne({
      where: exceptRepId
        ? { code, id: Not(exceptRepId), deletedAt: IsNull() }
        : { code, deletedAt: IsNull() },
    });
    if (existing) {
      throw new ConflictException(`Salesman code "${code}" is already in use`);
    }
  }

  /** Guard the 1:1 user↔rep invariant before it hits the unique index. */
  private async assertUserUnlinked(
    userId: string,
    exceptRepId?: string,
  ): Promise<void> {
    const existing = await this.repo.findOne({
      where: exceptRepId
        ? { userId, id: Not(exceptRepId), deletedAt: IsNull() }
        : { userId, deletedAt: IsNull() },
    });
    if (existing) {
      throw new ConflictException(
        `User ${userId} is already linked to rep ${existing.id}`,
      );
    }
  }

  async softDelete(id: string): Promise<void> {
    const result = await this.repo.softDelete({ id });
    if (!result.affected) {
      throw new NotFoundException(`Rep ${id} not found`);
    }
  }

  /** Stub — populated by plan 06 (invoices) once revenue data exists. */
  async kpis(id: string): Promise<RepKpis> {
    await this.findOne(id); // 404 if missing
    return {
      todayRevenueFils: 0,
      routeCompletionPct: 0,
      invoicesToday: 0,
      customersAtRisk: 0,
    };
  }
}

// Avoid "unused" lint on ILike (kept for future ILike usage).
void ILike;
