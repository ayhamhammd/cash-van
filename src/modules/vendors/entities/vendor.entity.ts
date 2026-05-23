import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity({ name: 'vendors' })
export class Vendor extends BaseEntity {
  @Index('uq_vendors_vendor_number', { unique: true })
  @Column({ name: 'vendor_number', type: 'text' })
  vendorNumber!: string;

  @Column({ name: 'vendor_name', type: 'text' })
  vendorName!: string;

  @Column({ name: 'vendor_phone', type: 'text', nullable: true })
  vendorPhone?: string | null;

  @Column({
    name: 'vendor_debit',
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
  })
  vendorDebit!: string;

  @Column({
    name: 'vendor_credit',
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
  })
  vendorCredit!: string;
}
