import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ItemCart } from './entities/item-cart.entity';
import { ExpiryItem } from './entities/expiry-item.entity';
import { ItemBalanceView } from './entities/item-balance.view';

import { ItemCartService } from './item-cart.service';
import { ExpiryItemsService } from './expiry-items.service';
import { ItemBalanceService } from './item-balance.service';

import { ItemsController } from './items.controller';
import { WarehousesModule } from '../warehouses/warehouses.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ItemCart, ExpiryItem, ItemBalanceView]),
    WarehousesModule,
  ],
  controllers: [ItemsController],
  providers: [ItemCartService, ExpiryItemsService, ItemBalanceService],
  exports: [ItemCartService, TypeOrmModule],
})
export class ItemsModule {}
