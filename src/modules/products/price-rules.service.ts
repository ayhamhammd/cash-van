import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { PriceRule } from './entities/price-rule.entity';
import { CreatePriceRuleDto, UpdatePriceRuleDto } from './dto/price-rule.dto';

@Injectable()
export class PriceRulesService {
  constructor(
    @InjectRepository(PriceRule)
    private readonly repo: Repository<PriceRule>,
  ) {}

  list(): Promise<PriceRule[]> {
    return this.repo.find({
      where: { deletedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  create(dto: CreatePriceRuleDto): Promise<PriceRule> {
    return this.repo.save(this.repo.create(dto));
  }

  async update(id: string, dto: UpdatePriceRuleDto): Promise<PriceRule> {
    const rule = await this.repo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!rule) throw new NotFoundException(`Price rule ${id} not found`);
    Object.assign(rule, dto);
    return this.repo.save(rule);
  }

  async softDelete(id: string): Promise<void> {
    const res = await this.repo.softDelete({ id });
    if (!res.affected) throw new NotFoundException(`Price rule ${id} not found`);
  }
}
