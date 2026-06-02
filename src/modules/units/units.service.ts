import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';

import { Unit } from './entities/unit.entity';
import { ItemUnit } from './entities/item-unit.entity';
import { ItemCart } from '../items/entities/item-cart.entity';
import { CreateUnitDto, UpdateUnitDto } from './dto/unit.dto';
import {
  CreateItemUnitDto,
  UpdateItemUnitDto,
} from './dto/item-unit.dto';

/** The single, system-wide base unit. Always present (seeded by migration). */
export const BASE_UNIT_CODE = 'PCE';

@Injectable()
export class UnitsService {
  constructor(
    @InjectRepository(Unit) private readonly units: Repository<Unit>,
    @InjectRepository(ItemUnit) private readonly itemUnits: Repository<ItemUnit>,
    @InjectRepository(ItemCart) private readonly items: Repository<ItemCart>,
  ) {}

  // ---------- Unit catalog ----------

  list(): Promise<Unit[]> {
    return this.units.find({ order: { baseQty: 'ASC', code: 'ASC' } });
  }

  async findOne(id: string): Promise<Unit> {
    const u = await this.units.findOne({ where: { id } });
    if (!u) throw new NotFoundException(`Unit ${id} not found`);
    return u;
  }

  async create(dto: CreateUnitDto): Promise<Unit> {
    this.assertBaseRule(dto.code, dto.baseQty);
    await this.assertCodeUnique(dto.code);
    return this.units.save(this.units.create(dto));
  }

  async update(id: string, dto: UpdateUnitDto): Promise<Unit> {
    const u = await this.findOne(id);
    const nextCode = dto.code ?? u.code;
    const nextQty = dto.baseQty ?? u.baseQty;
    this.assertBaseRule(nextCode, nextQty);
    // Block renaming the base unit away from PCE.
    if (u.code === BASE_UNIT_CODE && nextCode !== BASE_UNIT_CODE) {
      throw new BadRequestException(
        `The base unit (${BASE_UNIT_CODE}) cannot be renamed`,
      );
    }
    if (dto.code && dto.code !== u.code) {
      await this.assertCodeUnique(dto.code, id);
    }
    Object.assign(u, dto);
    return this.units.save(u);
  }

  async remove(id: string): Promise<void> {
    const u = await this.findOne(id);
    if (u.code === BASE_UNIT_CODE) {
      throw new BadRequestException(`The base unit (${BASE_UNIT_CODE}) cannot be deleted`);
    }
    const inUse = await this.itemUnits.exist({ where: { unitId: id } });
    if (inUse) {
      throw new ConflictException(
        `Unit ${id} is referenced by item_units rows; detach those first`,
      );
    }
    const res = await this.units.delete({ id });
    if (!res.affected) throw new NotFoundException(`Unit ${id} not found`);
  }

  /** PCE ↔ baseQty=1 is a singleton invariant. */
  private assertBaseRule(code: string, baseQty: number): void {
    if (code === BASE_UNIT_CODE && baseQty !== 1) {
      throw new BadRequestException(`Code ${BASE_UNIT_CODE} must have baseQty = 1`);
    }
    if (code !== BASE_UNIT_CODE && baseQty === 1) {
      throw new BadRequestException(
        `Only ${BASE_UNIT_CODE} can have baseQty = 1 (piece is the global base)`,
      );
    }
  }

  private async assertCodeUnique(code: string, exceptId?: string): Promise<void> {
    const existing = await this.units.findOne({
      where: exceptId ? { code, id: Not(exceptId) } : { code },
    });
    if (existing) throw new ConflictException(`Unit code "${code}" is already used`);
  }

  // ---------- Per-item unit mappings ----------

  async listForItem(itemId: string): Promise<ItemUnit[]> {
    await this.assertItem(itemId);
    return this.itemUnits.find({
      where: { itemId },
      relations: { unit: true },
      order: { unit: { baseQty: 'ASC' } },
    });
  }

  async findForItemByBarcode(barcode: string): Promise<ItemUnit | null> {
    return this.itemUnits.findOne({
      where: { barcode },
      relations: { unit: true, item: true },
    });
  }

  async attach(itemId: string, dto: CreateItemUnitDto): Promise<ItemUnit> {
    await this.assertItem(itemId);
    await this.findOne(dto.unitId);
    const row = this.itemUnits.create({
      itemId,
      unitId: dto.unitId,
      barcode: dto.barcode,
      salePrice: dto.salePrice,
    });
    try {
      return await this.itemUnits.save(row);
    } catch (err) {
      throw this.toFriendlyError(err);
    }
  }

  async update_itemUnit(
    itemId: string,
    unitId: string,
    dto: UpdateItemUnitDto,
  ): Promise<ItemUnit> {
    const row = await this.itemUnits.findOne({
      where: { itemId, unitId },
      relations: { unit: true },
    });
    if (!row) {
      throw new NotFoundException(
        `No item_unit for item ${itemId} + unit ${unitId}`,
      );
    }
    if (dto.unitId && dto.unitId !== unitId) {
      throw new BadRequestException(
        'Changing unitId is not supported — detach + reattach instead',
      );
    }
    if (dto.barcode !== undefined) row.barcode = dto.barcode;
    if (dto.salePrice !== undefined) row.salePrice = dto.salePrice;
    try {
      return await this.itemUnits.save(row);
    } catch (err) {
      throw this.toFriendlyError(err);
    }
  }

  async detach(itemId: string, unitId: string): Promise<void> {
    const res = await this.itemUnits.delete({ itemId, unitId });
    if (!res.affected) {
      throw new NotFoundException(
        `No item_unit for item ${itemId} + unit ${unitId}`,
      );
    }
  }

  private async assertItem(itemId: string): Promise<void> {
    if (!(await this.items.exist({ where: { id: itemId } }))) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }
  }

  private toFriendlyError(err: unknown): Error {
    const msg = err instanceof Error ? err.message : String(err);
    if (/uq_item_units_item_unit/.test(msg)) {
      return new ConflictException('This unit is already attached to the item');
    }
    if (/uq_item_units_barcode/.test(msg)) {
      return new ConflictException('That barcode is already used by another unit');
    }
    return err instanceof Error ? err : new Error(msg);
  }
}
