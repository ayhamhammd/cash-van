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
import { MobileOrderController } from './mobile-order.controller';
import { MobileService } from './mobile.service';
import { MobileContextGuard } from './mobile-context.guard';
import { ErpSyncModule } from '../erp-sync/erp-sync.module';

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
    // For live ERP on-hand overlay on the cross-store itemBalance lookup.
    ErpSyncModule,
  ],
  controllers: [MobileController, MobileOrderController],
  providers: [MobileService, MobileContextGuard],
})
export class MobileModule {}
