import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/** An area the office divides its customers into. See CustomerAreas1727900000000. */
@Entity({ name: 'customer_areas' })
export class CustomerArea extends BaseEntity {
  @Column({ name: 'name_ar', type: 'text' })
  nameAr!: string;

  @Column({ name: 'name_en', type: 'text', nullable: true })
  nameEn?: string | null;

  /** A hex colour for the area's chip, e.g. #3B82F6. */
  @Column({ type: 'text', nullable: true })
  color?: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;
}
