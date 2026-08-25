import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ItemCart } from './entities/item-cart.entity';
import { ExpiryItem } from './entities/expiry-item.entity';
import { ItemBalanceView } from './entities/item-balance.view';
import { ItemBalanceTotalView } from './entities/item-balance-total.view';
import { TobaccoTaxProfile } from './entities/tobacco-tax-profile.entity';

import { ItemCartService } from './item-cart.service';
import { ExpiryItemsService } from './expiry-items.service';
import { ItemBalanceService } from './item-balance.service';
import { TobaccoTaxProfilesService } from './tobacco-tax-profiles.service';

import { ItemsController } from './items.controller';
import { TobaccoTaxProfilesController } from './tobacco-tax-profiles.controller';
import { WarehousesModule } from '../warehouses/warehouses.module';
import { ErpSyncModule } from '../erp-sync/erp-sync.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ItemCart,
      ExpiryItem,
      ItemBalanceView,
      ItemBalanceTotalView,
      TobaccoTaxProfile,
    ]),
    WarehousesModule,
    forwardRef(() => ErpSyncModule),
  ],
  controllers: [ItemsController, TobaccoTaxProfilesController],
  providers: [ItemCartService, ExpiryItemsService, ItemBalanceService, TobaccoTaxProfilesService],
  exports: [ItemCartService, TobaccoTaxProfilesService, TypeOrmModule],
})
export class ItemsModule {}
