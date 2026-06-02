import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Rep } from '../reps/entities/rep.entity';
import { User } from '../users/entities/user.entity';
import { Region } from '../regions/entities/region.entity';
import { Warehouse } from '../warehouses/entities/warehouse.entity';
import { AppSettings } from '../settings/entities/app-settings.entity';
import { ItemCart } from '../items/entities/item-cart.entity';
import { ItemUnit } from '../units/entities/item-unit.entity';
import { ItemBalanceView } from '../items/entities/item-balance.view';
import { ProductCategory } from '../products/entities/product-category.entity';
import { VanStock } from '../products/entities/van-stock.entity';

import { MobileController } from './mobile.controller';
import { MobileService } from './mobile.service';
import { MobileContextGuard } from './mobile-context.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Rep,
      User,
      Region,
      Warehouse,
      AppSettings,
      ItemCart,
      ItemUnit,
      ItemBalanceView,
      ProductCategory,
      VanStock,
    ]),
  ],
  controllers: [MobileController],
  providers: [MobileService, MobileContextGuard],
})
export class MobileModule {}
