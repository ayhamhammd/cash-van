import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity({ name: 'year_config' })
@Index('uq_year_config_year_acc', ['year', 'accName'], { unique: true })
export class YearConfig extends BaseEntity {
  @Column({ type: 'smallint' })
  year!: number;

  @Column({ name: 'acc_name', type: 'text' })
  accName!: string;

  @Column({
    name: 'acc_value',
    type: 'numeric',
    precision: 18,
    scale: 4,
    default: 0,
  })
  accValue!: string;

  @Column({
    name: 'total_sale',
    type: 'numeric',
    precision: 18,
    scale: 2,
    default: 0,
  })
  totalSale!: string;

  @Column({
    name: 'total_d',
    type: 'numeric',
    precision: 18,
    scale: 2,
    default: 0,
    comment: 'total debit',
  })
  totalD!: string;

  @Column({
    name: 'total_r',
    type: 'numeric',
    precision: 18,
    scale: 2,
    default: 0,
    comment: 'total credit / receipts',
  })
  totalR!: string;
}
