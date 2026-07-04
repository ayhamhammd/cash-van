import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TobaccoTaxProfile } from './entities/tobacco-tax-profile.entity';
import {
  CreateTobaccoTaxProfileDto,
  UpdateTobaccoTaxProfileDto,
} from './dto/tobacco-tax-profile.dto';

/**
 * Tobacco tax profiles. When FlowVan works WITH the ERP these are synced in and
 * read-only (writes blocked by ErpReadOnlyGuard at the controller); standalone
 * they're admin-managed here. Money fields are integer fils. See
 * docs/SPEC-tobacco-tax.md.
 */
@Injectable()
export class TobaccoTaxProfilesService {
  constructor(
    @InjectRepository(TobaccoTaxProfile)
    private readonly repo: Repository<TobaccoTaxProfile>,
  ) {}

  /** List profiles. `activeOnly` (default) hides deactivated ones. */
  list(activeOnly = true): Promise<TobaccoTaxProfile[]> {
    return this.repo.find({
      where: activeOnly ? { isActive: true } : {},
      order: { name: 'ASC' },
    });
  }

  async get(id: string): Promise<TobaccoTaxProfile> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Tobacco tax profile ${id} not found`);
    return row;
  }

  create(dto: CreateTobaccoTaxProfileDto): Promise<TobaccoTaxProfile> {
    return this.repo.save(this.repo.create(dto));
  }

  async update(id: string, dto: UpdateTobaccoTaxProfileDto): Promise<TobaccoTaxProfile> {
    const row = await this.get(id);
    Object.assign(row, dto);
    return this.repo.save(row);
  }

  /** Soft-remove = deactivate (history keeps referencing the profile by id). */
  async remove(id: string): Promise<TobaccoTaxProfile> {
    const row = await this.get(id);
    row.isActive = false;
    return this.repo.save(row);
  }
}
