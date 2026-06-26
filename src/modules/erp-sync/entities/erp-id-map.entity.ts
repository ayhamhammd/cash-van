import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/** Maps an ERP record to its cash-van counterpart so syncs are idempotent and
 *  the outbound push can translate cash-van keys → ERP ids/codes. */
@Entity({ name: 'erp_id_map' })
@Unique('uq_erp_id_map_entity_erp', ['entity', 'erpId'])
export class ErpIdMap {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** 'item' | 'unit' | 'warehouse' | 'customer' */
  @Column({ type: 'text' })
  entity!: string;

  @Column({ name: 'erp_id', type: 'text' })
  erpId!: string;

  @Column({ name: 'erp_code', type: 'text', nullable: true })
  erpCode?: string | null;

  @Column({ name: 'local_id', type: 'text' })
  localId!: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
