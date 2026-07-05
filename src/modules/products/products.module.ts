import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ItemCart } from '../items/entities/item-cart.entity';
import { ItemUnit } from '../units/entities/item-unit.entity';
import { Rep } from '../reps/entities/rep.entity';
import { CustomerAiProfile } from '../customers/entities/customer-ai-profile.entity';
import { Customer } from '../customers/entities/customer.entity';

import { ProductCategory } from './entities/product-category.entity';
import { VanStock } from './entities/van-stock.entity';
import { PriceRule } from './entities/price-rule.entity';
import { CustomerPrice } from './entities/customer-price.entity';
import { PriceList } from './entities/price-list.entity';
import { PriceListItem } from './entities/price-list-item.entity';

import { ProductsService } from './products.service';
import { CategoriesService } from './categories.service';
import { VanStockService } from './van-stock.service';
import { PriceRulesService } from './price-rules.service';
import { PricingService } from './pricing.service';
import { CustomerPricesService } from './customer-prices.service';
import { PriceListsService } from './price-lists.service';

import { ProductsController } from './products.controller';
import { CategoriesController } from './categories.controller';
import { VanStockController } from './van-stock.controller';
import { PriceRulesController } from './price-rules.controller';
import { CustomerPricesController } from './customer-prices.controller';
import { PriceListsController } from './price-lists.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ItemCart,
      ItemUnit,
      ProductCategory,
      VanStock,
      PriceRule,
      CustomerPrice,
      PriceList,
      PriceListItem,
      Customer,
      Rep,
      CustomerAiProfile,
    ]),
  ],
  controllers: [
    ProductsController,
    CategoriesController,
    VanStockController,
    PriceRulesController,
    CustomerPricesController,
    PriceListsController,
  ],
  providers: [
    ProductsService,
    CategoriesService,
    VanStockService,
    PriceRulesService,
    PricingService,
    CustomerPricesService,
    PriceListsService,
  ],
  exports: [ProductsService, PricingService, PriceListsService],
})
export class ProductsModule {}
