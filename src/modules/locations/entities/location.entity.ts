import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export const LOCATION_KINDS = ['COUNTRY', 'GOVERNORATE', 'AREA'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/**
 * One node of the location tree: Jordan › a governorate › an area. Customers
 * sit on AREA nodes only; a governorate is read off the area's parent.
 * See docs/SPEC-location-tree.md and LocationTree1728590000000.
 */
@Entity({ name: 'locations' })
export class Location extends BaseEntity {
  @Index('idx_locations_parent')
  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId?: string | null;

  @Column({ type: 'text' })
  kind!: LocationKind;

  /** '/<rootId>/<govId>/<areaId>/' — a subtree is every path starting with a node's. */
  @Column({ type: 'text' })
  path!: string;

  /** 0 country, 1 governorate, 2 area. */
  @Column({ type: 'smallint' })
  depth!: number;

  /** A governorate's ISO / JoFotara code (JO-AM); an area's optional office code. */
  @Column({ type: 'text', nullable: true })
  code?: string | null;

  @Column({ name: 'name_ar', type: 'text' })
  nameAr!: string;

  @Column({ name: 'name_en', type: 'text', nullable: true })
  nameEn?: string | null;

  /** A hex colour for the node's chip, e.g. #3B82F6. */
  @Column({ type: 'text', nullable: true })
  color?: string | null;

  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder!: number;

  /** The salesman covering this node; empty means "inherit from above". */
  @Column({ name: 'rep_id', type: 'uuid', nullable: true })
  repId?: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;
}
