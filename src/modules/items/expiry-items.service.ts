import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';

import { ExpiryItem } from './entities/expiry-item.entity';
import { CreateExpiryItemDto } from './dto/create-expiry-item.dto';

@Injectable()
export class ExpiryItemsService {
  constructor(
    @InjectRepository(ExpiryItem)
    private readonly expiryRepo: Repository<ExpiryItem>,
  ) {}

  create(dto: CreateExpiryItemDto): Promise<ExpiryItem> {
    return this.expiryRepo.save(this.expiryRepo.create(dto));
  }

  list(): Promise<ExpiryItem[]> {
    return this.expiryRepo.find({ order: { expDate: 'ASC' } });
  }

  expiringBefore(date: string): Promise<ExpiryItem[]> {
    return this.expiryRepo.find({
      where: { expDate: LessThanOrEqual(date) },
      order: { expDate: 'ASC' },
    });
  }

  async remove(id: string): Promise<void> {
    const res = await this.expiryRepo.softDelete(id);
    if (!res.affected) {
      throw new NotFoundException(`Expiry record ${id} not found`);
    }
  }
}
