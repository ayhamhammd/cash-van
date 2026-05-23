import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ItemBalanceView } from './entities/item-balance.view';

@Injectable()
export class ItemBalanceService {
  constructor(
    @InjectRepository(ItemBalanceView)
    private readonly balanceRepo: Repository<ItemBalanceView>,
  ) {}

  list(filter?: { itemNumber?: string; stockNumber?: string }): Promise<ItemBalanceView[]> {
    const qb = this.balanceRepo.createQueryBuilder('b');
    if (filter?.itemNumber) {
      qb.andWhere('b.item_number = :itemNumber', {
        itemNumber: filter.itemNumber,
      });
    }
    if (filter?.stockNumber) {
      qb.andWhere('b.stock_number = :stockNumber', {
        stockNumber: filter.stockNumber,
      });
    }
    return qb.orderBy('b.item_name', 'ASC').getMany();
  }
}
