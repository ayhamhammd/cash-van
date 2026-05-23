import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';

@Entity({ name: 'reps' })
export class Rep extends BaseEntity {
  @Index('idx_reps_user_id_partial', { where: '"user_id" IS NOT NULL' })
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId?: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: User | null;

  @Column({ name: 'name_ar', type: 'text' })
  nameAr!: string;

  @Column({ name: 'name_en', type: 'text', nullable: true })
  nameEn?: string | null;

  @Column({ type: 'text', nullable: true })
  phone?: string | null;

  @Index('idx_reps_region_id')
  @Column({ name: 'region_id', type: 'uuid', nullable: true })
  regionId?: string | null;

  @Column({ name: 'van_id', type: 'uuid', nullable: true })
  vanId?: string | null;

  @Index('idx_reps_is_active')
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'hire_date', type: 'date', nullable: true })
  hireDate?: string | null;

  @Column({ name: 'daily_quota_fils', type: 'integer', nullable: true })
  dailyQuotaFils?: number | null;
}
