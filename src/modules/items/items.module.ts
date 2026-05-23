import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ItemCart } from './entities/item-cart.entity';
import { ItemSwitch } from './entities/item-switch.entity';
import { ExpiryItem } from './entities/expiry-item.entity';
import { ItemBalanceView } from './entities/item-balance.view';

import { ItemCartService } from './item-cart.service';
import { ItemSwitchesService } from './item-switches.service';
import { ExpiryItemsService } from './expiry-items.service';
import { ItemBalanceService } from './item-balance.service';

import { ItemsController } from './items.controller';
import { WarehousesModule } from '../warehouses/warehouses.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ItemCart,
      ItemSwitch,
      ExpiryItem,
      ItemBalanceView,
    ]),
    WarehousesModule,
  ],
  controllers: [ItemsController],
  providers: [
    ItemCartService,
    ItemSwitchesService,
    ExpiryItemsService,
    ItemBalanceService,
  ],
  exports: [
    ItemCartService,
    ItemSwitchesService,
    TypeOrmModule,
  ],
})
export class ItemsModule {}
