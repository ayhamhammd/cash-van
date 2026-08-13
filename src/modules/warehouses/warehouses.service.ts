import {
  ConflictException,
  ForbiddenException,
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

  /**
   * Every store dropdown in the dashboard is fed from here, so this is where a
   * scoped supervisor stops being offered other salesmen's vans.
   *
   * A VAN store is a salesman — it is created with them, named after them, and
   * holds their stock — so it follows the same scope as the salesman. A DEPOT
   * (`is_van = false`) is company infrastructure that belongs to nobody, and
   * stays visible to everyone: stock still has to be transferred out of it and
   * purchases still land in it. A van with no salesman assigned is nobody's,
   * which under scope means it is not yours — the same rule the customer list
   * applies to a customer with no rep.
   */
  list(visibleRepIds: string[] | null = null): Promise<Warehouse[]> {
    const qb = this.warehousesRepo
      .createQueryBuilder('w')
      .orderBy('w.wh_number', 'ASC');

    if (visibleRepIds !== null) {
      qb.leftJoin('reps', 'wr', 'wr.van_id = w.id AND wr.deleted_at IS NULL');
      if (visibleRepIds.length === 0) {
        qb.andWhere('w.is_van = false');
      } else {
        qb.andWhere('(w.is_van = false OR wr.id IN (:...visibleRepIds))', {
          visibleRepIds,
        });
      }
    }

    return qb.getMany();
  }

  /**
   * Throw unless this store is the caller's to see. Same rule as [list]; a 403
   * rather than a 404 so "not yours" does not read as "no such store".
   */
  async assertVisible(
    id: string,
    visibleRepIds: string[] | null,
  ): Promise<void> {
    if (visibleRepIds === null) return;
    const wh = await this.findOneOrThrow(id);
    if (!wh.isVan) return;
    const owner = await this.warehousesRepo.manager
      .createQueryBuilder()
      .select('r.id', 'id')
      .from('reps', 'r')
      .where('r.van_id = :id AND r.deleted_at IS NULL', { id })
      .getRawOne<{ id: string }>();
    if (!owner || !visibleRepIds.includes(owner.id)) {
      throw new ForbiddenException('This store is outside your assigned scope');
    }
  }

  async remove(id: string): Promise<void> {
    const res = await this.warehousesRepo.softDelete(id);
    if (!res.affected) {
      throw new NotFoundException(`Warehouse ${id} not found`);
    }
  }
}
