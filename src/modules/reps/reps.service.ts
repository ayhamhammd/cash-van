import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, ILike, IsNull, Repository } from 'typeorm';

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

  async create(dto: CreateRepDto): Promise<Rep> {
    const rep = this.repo.create(dto);
    return this.repo.save(rep);
  }

  async update(id: string, dto: UpdateRepDto): Promise<Rep> {
    const rep = await this.findOne(id);
    Object.assign(rep, dto);
    return this.repo.save(rep);
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
