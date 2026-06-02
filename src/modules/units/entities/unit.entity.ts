import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Global unit catalog (piece, carton, pallet…). Admin-maintained. */
@Entity({ name: 'units' })
export class Unit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uq_units_code', { unique: true })
  @Column({ type: 'text' })
  code!: string;

  @Column({ name: 'name_ar', type: 'text' })
  nameAr!: string;

  @Column({ name: 'name_en', type: 'text', nullable: true })
  nameEn?: string | null;

  /** How many base units (pieces) make one of this unit. PCE = 1. */
  @Column({ name: 'base_qty', type: 'integer', default: 1 })
  baseQty!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
