import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { GeoJsonPolygon } from '../../../common/geo/geo.util';

@Entity({ name: 'regions' })
export class Region extends BaseEntity {
  /** Human route code (e.g. "R-A01") used by the mobile contract. Unique when set. */
  @Index('uq_regions_code', { unique: true, where: '"code" IS NOT NULL' })
  @Column({ type: 'text', nullable: true })
  code?: string | null;

  @Column({ name: 'name_ar', type: 'text' })
  nameAr!: string;

  @Column({ name: 'name_en', type: 'text', nullable: true })
  nameEn?: string | null;

  /** GeoJSON Polygon, validated on insert/update by RegionsService. */
  @Column({ type: 'jsonb', nullable: true })
  boundary?: GeoJsonPolygon | null;

  @Index('idx_regions_is_active')
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;
}
