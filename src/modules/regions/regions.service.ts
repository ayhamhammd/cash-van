import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, IsNull, Not, Repository } from 'typeorm';

import { Region } from './entities/region.entity';
import { CreateRegionDto } from './dto/create-region.dto';
import { UpdateRegionDto } from './dto/update-region.dto';
import { ListRegionsQuery } from './dto/list-regions.query';
import {
  GeoJsonPolygon,
  isPointInPolygon,
  validateGeoJsonPolygon,
} from '../../common/geo/geo.util';

@Injectable()
export class RegionsService {
  constructor(
    @InjectRepository(Region)
    private readonly repo: Repository<Region>,
  ) {}

  async list(query: ListRegionsQuery): Promise<{ items: Region[]; total: number }> {
    const qb = this.repo
      .createQueryBuilder('r')
      .where('r.deleted_at IS NULL')
      .orderBy('r.name_ar', 'ASC')
      .take(query.limit ?? 50)
      .skip(query.offset ?? 0);
    if (query.isActive !== undefined) {
      qb.andWhere('r.is_active = :a', { a: query.isActive });
    }
    if (query.q) {
      qb.andWhere(
        new Brackets((b) => {
          const p = `%${query.q}%`;
          b.where('r.name_ar ILIKE :p', { p }).orWhere('r.name_en ILIKE :p', { p });
        }),
      );
    }
    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  async findOne(id: string): Promise<Region> {
    const r = await this.repo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!r) throw new NotFoundException(`Region ${id} not found`);
    return r;
  }

  async create(dto: CreateRegionDto): Promise<Region> {
    if (dto.code) await this.assertCodeUnique(dto.code);
    const boundary = this.normalizeBoundary(dto.boundary);
    return this.repo.save(this.repo.create({ ...dto, boundary }));
  }

  async update(id: string, dto: UpdateRegionDto): Promise<Region> {
    const region = await this.findOne(id);
    if (dto.code !== undefined) {
      if (dto.code) await this.assertCodeUnique(dto.code, id);
      region.code = dto.code;
    }
    if (dto.boundary !== undefined) {
      region.boundary = this.normalizeBoundary(dto.boundary);
    }
    if (dto.nameAr !== undefined) region.nameAr = dto.nameAr;
    if (dto.nameEn !== undefined) region.nameEn = dto.nameEn;
    if (dto.isActive !== undefined) region.isActive = dto.isActive;
    return this.repo.save(region);
  }

  private async assertCodeUnique(code: string, exceptId?: string): Promise<void> {
    const existing = await this.repo.findOne({
      where: exceptId
        ? { code, id: Not(exceptId), deletedAt: IsNull() }
        : { code, deletedAt: IsNull() },
    });
    if (existing) {
      throw new ConflictException(`Route code "${code}" is already in use`);
    }
  }

  async softDelete(id: string): Promise<void> {
    const res = await this.repo.softDelete({ id });
    if (!res.affected) throw new NotFoundException(`Region ${id} not found`);
  }

  /** Returns the first active region whose polygon contains (lat,lng), or null. */
  async findRegionContaining(lat: number, lng: number): Promise<Region | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new BadRequestException('lat and lng must be numeric');
    }
    const candidates = await this.repo.find({
      where: { isActive: true, deletedAt: IsNull() },
    });
    for (const r of candidates) {
      if (!r.boundary) continue;
      if (isPointInPolygon([lng, lat], r.boundary)) return r;
    }
    return null;
  }

  private normalizeBoundary(input: unknown): GeoJsonPolygon | null {
    if (input == null) return null;
    try {
      return validateGeoJsonPolygon(input);
    } catch (err) {
      throw new BadRequestException(`Invalid boundary polygon: ${(err as Error).message}`);
    }
  }
}
