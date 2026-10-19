import { Module } from '@nestjs/common';

import { Unit } from './entities/unit.entity';
import { ItemUnit } from './entities/item-unit.entity';
import { ItemCart } from '../items/entities/item-cart.entity';

import { UnitsService } from './units.service';
import { UnitsController } from './units.controller';
import { ItemUnitsController } from './item-units.controller';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

@Module({
  imports: [TenantOrmModule.forFeature([Unit, ItemUnit, ItemCart])],
  controllers: [UnitsController, ItemUnitsController],
  providers: [UnitsService],
  exports: [UnitsService],
})
export class UnitsModule {}
