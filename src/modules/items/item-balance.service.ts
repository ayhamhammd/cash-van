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

  /**
   * One row per (item, stock pool, store). `stockUnitCode` filters to a single
   * pool — pass '' for the item's base pieces, which is what an unfiltered read
   * used to be the whole of.
   */
  list(filter?: {
    itemNumber?: string;
    stockNumber?: string;
    stockUnitCode?: string;
  }): Promise<ItemBalanceView[]> {
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
    // Explicit undefined check: '' is a real pool (the base one), not "no filter".
    if (filter?.stockUnitCode !== undefined) {
      qb.andWhere('b.stock_unit_code = :stockUnitCode', {
        stockUnitCode: filter.stockUnitCode,
      });
    }
    return qb
      .orderBy('b.item_name', 'ASC')
      .addOrderBy('b.stock_unit_code', 'ASC')
      .getMany();
  }
}
