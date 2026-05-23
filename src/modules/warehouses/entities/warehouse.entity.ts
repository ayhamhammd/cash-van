import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity({ name: 'warehouses' })
export class Warehouse extends BaseEntity {
  @Index('uq_warehouses_wh_number', { unique: true })
  @Column({ name: 'wh_number', type: 'text' })
  whNumber!: string;

  @Column({ name: 'wh_name', type: 'text' })
  whName!: string;

  @Column({
    name: 'wh_credit_box',
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
  })
  whCreditBox!: string;

  @Column({
    name: 'wh_debit_box',
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
  })
  whDebitBox!: string;
}
