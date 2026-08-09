import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/** One lead-finder run: a map point + radius + the categories searched. */
@Entity({ name: 'prospect_searches' })
export class ProspectSearch extends BaseEntity {
  @Column({ name: 'center_lat', type: 'numeric', precision: 9, scale: 6 })
  centerLat!: string;

  @Column({ name: 'center_lng', type: 'numeric', precision: 9, scale: 6 })
  centerLng!: string;

  @Column({ name: 'radius_m', type: 'integer' })
  radiusM!: number;

  /** Google Places `includedTypes` used for this run. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  categories!: string[];

  /** The rep's own terms, matched against business names. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  keywords!: string[];

  /** Total businesses Places returned. */
  @Column({ name: 'found_count', type: 'integer', default: 0 })
  foundCount!: number;

  /** How many of those were NOT already customers. */
  @Column({ name: 'new_count', type: 'integer', default: 0 })
  newCount!: number;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy?: string | null;
}
