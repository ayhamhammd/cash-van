import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Unit } from './entities/unit.entity';
import { ItemUnit } from './entities/item-unit.entity';
import { ItemCart } from '../items/entities/item-cart.entity';

import { UnitsService } from './units.service';
import { UnitsController } from './units.controller';
import { ItemUnitsController } from './item-units.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Unit, ItemUnit, ItemCart])],
  controllers: [UnitsController, ItemUnitsController],
  providers: [UnitsService],
  exports: [UnitsService],
})
export class UnitsModule {}
