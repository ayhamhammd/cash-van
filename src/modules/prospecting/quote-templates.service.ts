import { randomBytes } from 'crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';

import {
  PaginationDto,
  PaginatedResult,
} from '../../common/dto/pagination.dto';
import { QuoteTemplate } from './entities/quote-template.entity';
import {
  CreateQuoteTemplateDto,
  UpdateQuoteTemplateDto,
} from './dto/quote-template.dto';

@Injectable()
export class QuoteTemplatesService {
  constructor(
    @InjectRepository(QuoteTemplate)
    private readonly repo: Repository<QuoteTemplate>,
  ) {}

  async findAll(query: PaginationDto): Promise<PaginatedResult<QuoteTemplate>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const [items, total] = await this.repo.findAndCount({
      where: query.search ? { name: ILike(`%${query.search}%`) } : {},
      order: { updatedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async findOne(id: string): Promise<QuoteTemplate> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Quote template not found');
    return row;
  }

  async create(dto: CreateQuoteTemplateDto): Promise<QuoteTemplate> {
    const row = this.repo.create({
      ...dto,
      phones: dto.phones ?? [],
      items: dto.items ?? [],
      // 32 hex chars — unguessable, and stable for the template's lifetime so
      // links already sent to prospects keep working across edits.
      publicToken: randomBytes(16).toString('hex'),
    });
    return this.repo.save(row);
  }

  async update(id: string, dto: UpdateQuoteTemplateDto): Promise<QuoteTemplate> {
    const row = await this.findOne(id);
    Object.assign(row, dto);
    return this.repo.save(row);
  }

  async remove(id: string): Promise<void> {
    const row = await this.findOne(id);
    await this.repo.softRemove(row);
  }

  /**
   * PUBLIC resolution for /q/<token>: only active, non-deleted templates, and
   * only presentation fields — no ids or internal metadata leak to prospects.
   */
  async findByToken(token: string): Promise<{
    name: string;
    logoUrl: string | null;
    descriptionAr: string | null;
    phones: string[];
    items: QuoteTemplate['items'];
  }> {
    const row = await this.repo.findOne({
      where: { publicToken: token, isActive: true },
    });
    if (!row) throw new NotFoundException('Quote not found');
    return {
      name: row.name,
      logoUrl: row.logoUrl ?? null,
      descriptionAr: row.descriptionAr ?? null,
      phones: row.phones ?? [],
      items: row.items ?? [],
    };
  }
}
