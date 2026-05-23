import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Warehouse } from './entities/warehouse.entity';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto';

@Injectable()
export class WarehousesService {
  constructor(
    @InjectRepository(Warehouse)
    private readonly warehousesRepo: Repository<Warehouse>,
  ) {}

  async create(dto: CreateWarehouseDto): Promise<Warehouse> {
    const exists = await this.warehousesRepo.exist({
      where: { whNumber: dto.whNumber },
    });
    if (exists) {
      throw new ConflictException(`Warehouse ${dto.whNumber} already exists`);
    }
    return this.warehousesRepo.save(this.warehousesRepo.create(dto));
  }

  async update(id: string, dto: UpdateWarehouseDto): Promise<Warehouse> {
    const wh = await this.findOneOrThrow(id);
    Object.assign(wh, dto);
    return this.warehousesRepo.save(wh);
  }

  async findOneOrThrow(id: string): Promise<Warehouse> {
    const wh = await this.warehousesRepo.findOne({ where: { id } });
    if (!wh) {
      throw new NotFoundException(`Warehouse ${id} not found`);
    }
    return wh;
  }

  async findByNumber(whNumber: string): Promise<Warehouse | null> {
    return this.warehousesRepo.findOne({ where: { whNumber } });
  }

  list(): Promise<Warehouse[]> {
    return this.warehousesRepo.find({ order: { whNumber: 'ASC' } });
  }

  async remove(id: string): Promise<void> {
    const res = await this.warehousesRepo.softDelete(id);
    if (!res.affected) {
      throw new NotFoundException(`Warehouse ${id} not found`);
    }
  }
}
