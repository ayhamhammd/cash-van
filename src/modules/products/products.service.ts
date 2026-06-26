import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Brackets, In, IsNull, Repository } from 'typeorm';

import { ItemCart } from '../items/entities/item-cart.entity';
import { ItemUnit } from '../units/entities/item-unit.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQuery } from './dto/list-products.query';

/** One sellable unit of an item (base + each item_unit), sent to the app. */
export interface ProductUnitView {
  name: string;
  code: string;
  /** Pieces (base units) this unit represents — base = 1. */
  conversionQty: number;
  /** Unit sale price in fils (minor units), like the item price. */
  priceFils: number;
  barcode: string;
  isBase: boolean;
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(ItemCart)
    private readonly products: Repository<ItemCart>,
    @InjectRepository(ItemUnit)
    private readonly itemUnits: Repository<ItemUnit>,
    private readonly events: EventEmitter2,
  ) {}

  async list(query: ListProductsQuery): Promise<{ items: ItemCart[]; total: number }> {
    const qb = this.products
      .createQueryBuilder('p')
      .where('p.deleted_at IS NULL')
      .orderBy('p.name_ar', 'ASC')
      .take(query.limit ?? 50)
      .skip(query.offset ?? 0);

    if (query.categoryId) qb.andWhere('p.category_id = :cid', { cid: query.categoryId });
    if (query.isActive !== undefined) qb.andWhere('p.is_active = :a', { a: query.isActive });
    if (query.q) {
      qb.andWhere(
        new Brackets((b) => {
          const s = `%${query.q}%`;
          b.where('p.sku ILIKE :s', { s })
            .orWhere('p.name_ar ILIKE :s', { s })
            .orWhere('p.item_name ILIKE :s', { s })
            .orWhere('p.barcode ILIKE :s', { s });
        }),
      );
    }
    const [items, total] = await qb.getManyAndCount();
    await this.attachUnits(items);
    return { items, total };
  }

  /**
   * Attach each item's real sellable units (the base unit + its item_units) so
   * the app shows the item's own units instead of a hardcoded list. Loaded in
   * one query for the whole page (no N+1).
   */
  private async attachUnits(items: ItemCart[]): Promise<void> {
    if (items.length === 0) return;
    const ids = items.map((i) => i.id);
    const rows = await this.itemUnits.find({
      where: { itemId: In(ids) },
      relations: { unit: true },
    });
    const byItem = new Map<string, ItemUnit[]>();
    for (const r of rows) {
      const list = byItem.get(r.itemId) ?? [];
      list.push(r);
      byItem.set(r.itemId, list);
    }
    for (const item of items) {
      const base: ProductUnitView = {
        name: item.unit,
        code: item.unitOfMeasure,
        conversionQty: 1,
        priceFils: item.price,
        barcode: item.barcode,
        isBase: true,
      };
      const larger: ProductUnitView[] = (byItem.get(item.id) ?? [])
        .map((iu) => ({
          name: iu.unit?.nameAr || iu.unit?.code || item.unit,
          code: iu.unit?.code ?? item.unitOfMeasure,
          conversionQty: iu.qty > 0 ? iu.qty : 1,
          priceFils: Math.round((Number(iu.salePrice) || 0) * 1000),
          barcode: iu.barcode,
          isBase: false,
        }))
        .sort((a, b) => a.conversionQty - b.conversionQty);
      // The entity is serialized to JSON as-is; an extra prop rides along.
      (item as ItemCart & { units: ProductUnitView[] }).units = [base, ...larger];
    }
  }

  /**
   * Fetch an item's image bytes from wherever it's hosted (the ERP), server-side.
   * Lets the app load images via the cash-van host it already reaches, instead of
   * the ERP's host (which is often unreachable from a device, e.g. 127.0.0.1).
   */
  async imageBytes(
    itemNumber: string,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    const row = await this.products.findOne({ where: { itemNumber } });
    if (!row?.imageUrl) return null;
    try {
      const upstream = await fetch(row.imageUrl);
      if (!upstream.ok) return null;
      return {
        buffer: Buffer.from(await upstream.arrayBuffer()),
        contentType: upstream.headers.get('content-type') ?? 'image/jpeg',
      };
    } catch {
      return null;
    }
  }

  async findOne(id: string): Promise<ItemCart> {
    const p = await this.products.findOne({ where: { id, deletedAt: IsNull() } });
    if (!p) throw new NotFoundException(`Product ${id} not found`);
    return p;
  }

  async create(dto: CreateProductDto): Promise<ItemCart> {
    const dup = await this.products.exist({ where: { itemNumber: dto.itemNumber } });
    if (dup) throw new ConflictException(`Product ${dto.itemNumber} already exists`);

    const entity = this.products.create({
      itemNumber: dto.itemNumber,
      sku: dto.sku ?? dto.itemNumber,
      barcode: dto.barcode,
      name: dto.name,
      nameAr: dto.nameAr ?? dto.name,
      nameEn: dto.nameEn ?? null,
      categoryId: dto.categoryId ?? null,
      unit: dto.unit ?? 'carton',
      unitOfMeasure: dto.unitOfMeasure ?? 'PCE',
      price: dto.price,
      cost: dto.cost ?? null,
      erpCategoryId: dto.erpCategoryId ?? null,
      erpTaxRateId: dto.erpTaxRateId ?? null,
      imageUrl: dto.imageUrl ?? null,
      isActive: dto.isActive ?? true,
      reorderQty: dto.reorderQty ?? 0,
      taxType: dto.taxType ?? 'TAXABLE',
      taxCategory: dto.taxCategory ?? 'S',
      taxRate: (dto.taxRate ?? 0.16).toString(),
      taxPercentage: ((dto.taxRate ?? 0.16) * 100).toFixed(2),
    });
    const saved = await this.products.save(entity);
    // Mirror to the ERP (ErpSyncService listener; no-op when ERP off / defaults unset).
    this.events.emit('erp.item.created', {
      itemNumber: saved.itemNumber,
      name: saved.name ?? saved.nameAr ?? saved.itemNumber,
      priceFils: saved.price ?? 0,
      costFils: saved.cost ?? 0,
      erpCategoryId: saved.erpCategoryId ?? null,
      erpTaxRateId: saved.erpTaxRateId ?? null,
    });
    return saved;
  }

  async update(id: string, dto: UpdateProductDto): Promise<ItemCart> {
    const product = await this.findOne(id);
    Object.assign(product, {
      ...dto,
      taxRate: dto.taxRate !== undefined ? dto.taxRate.toString() : product.taxRate,
      taxPercentage:
        dto.taxRate !== undefined ? (dto.taxRate * 100).toFixed(2) : product.taxPercentage,
    });
    return this.products.save(product);
  }

  async softDelete(id: string): Promise<void> {
    const res = await this.products.softDelete({ id });
    if (!res.affected) throw new NotFoundException(`Product ${id} not found`);
  }
}
