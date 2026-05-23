import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { ProductCategory } from './entities/product-category.entity';
import {
  CreateProductCategoryDto,
  UpdateProductCategoryDto,
} from './dto/category.dto';

export interface CategoryNode extends ProductCategory {
  children: CategoryNode[];
}

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(ProductCategory)
    private readonly repo: Repository<ProductCategory>,
  ) {}

  /** Returns the full category forest (roots with nested children). */
  async tree(): Promise<CategoryNode[]> {
    const all = await this.repo.find({
      where: { deletedAt: IsNull() },
      order: { sortOrder: 'ASC', nameAr: 'ASC' },
    });
    const byId = new Map<string, CategoryNode>();
    all.forEach((c) => byId.set(c.id, { ...c, children: [] }));
    const roots: CategoryNode[] = [];
    for (const node of byId.values()) {
      if (node.parentId && byId.has(node.parentId)) {
        byId.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  async create(dto: CreateProductCategoryDto): Promise<ProductCategory> {
    return this.repo.save(this.repo.create(dto));
  }

  async update(id: string, dto: UpdateProductCategoryDto): Promise<ProductCategory> {
    const cat = await this.repo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!cat) throw new NotFoundException(`Category ${id} not found`);
    Object.assign(cat, dto);
    return this.repo.save(cat);
  }

  async softDelete(id: string): Promise<void> {
    const res = await this.repo.softDelete({ id });
    if (!res.affected) throw new NotFoundException(`Category ${id} not found`);
  }
}
