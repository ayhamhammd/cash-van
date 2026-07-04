import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ItemCart } from '../items/entities/item-cart.entity';
import { Customer } from '../customers/entities/customer.entity';
import { VoucherHeader } from '../vouchers/entities/voucher-header.entity';
import { AppSettings } from '../settings/entities/app-settings.entity';
import { Offer } from './entities/offer.entity';
import { OfferRedemption } from './entities/offer-redemption.entity';
import { OffersController } from './offers.controller';
import { OffersService } from './offers.service';
import { OffersEngineService } from './offers-engine.service';

/**
 * Offers engine. Registers the offer + redemption tables and read-only access to
 * items/customers/vouchers (the engine needs item prices, customer segments and
 * first-purchase detection). Exports its services so VouchersModule can record
 * redemptions at sale time without importing this module's controllers.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Offer,
      OfferRedemption,
      ItemCart,
      Customer,
      VoucherHeader,
      AppSettings,
    ]),
  ],
  controllers: [OffersController],
  providers: [OffersService, OffersEngineService],
  exports: [OffersService, OffersEngineService],
})
export class OffersModule {}
