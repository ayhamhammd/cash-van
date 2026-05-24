import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Rep } from '../reps/entities/rep.entity';
import { Region } from '../regions/entities/region.entity';
import { Warehouse } from '../warehouses/entities/warehouse.entity';
import { AppSettings } from '../settings/entities/app-settings.entity';
import { ItemCart } from '../items/entities/item-cart.entity';
import { ItemSwitch } from '../items/entities/item-switch.entity';
import { ItemBalanceView } from '../items/entities/item-balance.view';
import { ProductCategory } from '../products/entities/product-category.entity';

import { MobileController } from './mobile.controller';
import { MobileService } from './mobile.service';
import { MobileContextGuard } from './mobile-context.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Rep,
      Region,
      Warehouse,
      AppSettings,
      ItemCart,
      ItemSwitch,
      ItemBalanceView,
      ProductCategory,
    ]),
  ],
  controllers: [MobileController],
  providers: [MobileService, MobileContextGuard],
})
export class MobileModule {}
