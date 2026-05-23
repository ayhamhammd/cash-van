import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ItemSwitch } from './entities/item-switch.entity';
import { CreateItemSwitchDto } from './dto/create-item-switch.dto';

@Injectable()
export class ItemSwitchesService {
  constructor(
    @InjectRepository(ItemSwitch)
    private readonly switchesRepo: Repository<ItemSwitch>,
  ) {}

  async create(dto: CreateItemSwitchDto): Promise<ItemSwitch> {
    const dup = await this.switchesRepo.exist({
      where: [
        { barcode: dto.barcode },
        { itemNumber: dto.itemNumber, unitName: dto.unitName },
      ],
    });
    if (dup) {
      throw new ConflictException(
        'Unit switch with this barcode or (itemNumber, unitName) already exists',
      );
    }
    return this.switchesRepo.save(this.switchesRepo.create(dto));
  }

  async findByBarcode(barcode: string): Promise<ItemSwitch | null> {
    return this.switchesRepo.findOne({ where: { barcode } });
  }

  listForItem(itemNumber: string): Promise<ItemSwitch[]> {
    return this.switchesRepo.find({
      where: { itemNumber },
      order: { unitQty: 'ASC' },
    });
  }

  async remove(id: string): Promise<void> {
    const res = await this.switchesRepo.softDelete(id);
    if (!res.affected) {
      throw new NotFoundException(`Item switch ${id} not found`);
    }
  }
}
