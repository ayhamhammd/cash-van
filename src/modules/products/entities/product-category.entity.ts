import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity({ name: 'product_categories' })
export class ProductCategory extends BaseEntity {
  @Column({ name: 'name_ar', type: 'text' })
  nameAr!: string;

  @Column({ name: 'name_en', type: 'text', nullable: true })
  nameEn?: string | null;

  @Index('idx_product_categories_parent_sort')
  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId?: string | null;

  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder!: number;
}
