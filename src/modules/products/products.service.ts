import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, IsNull, Repository } from 'typeorm';

import { ItemCart } from '../items/entities/item-cart.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQuery } from './dto/list-products.query';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(ItemCart)
    private readonly products: Repository<ItemCart>,
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
    return { items, total };
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
      imageUrl: dto.imageUrl ?? null,
      isActive: dto.isActive ?? true,
      reorderQty: dto.reorderQty ?? 0,
      taxType: dto.taxType ?? 'TAXABLE',
      taxCategory: dto.taxCategory ?? 'S',
      taxRate: (dto.taxRate ?? 0.16).toString(),
      taxPercentage: ((dto.taxRate ?? 0.16) * 100).toFixed(2),
    });
    return this.products.save(entity);
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
