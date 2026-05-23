import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { RouteStop } from './route-stop.entity';

export type RouteSource = 'manual' | 'ai_optimized';

@Entity({ name: 'route_plans' })
@Index('uq_route_plans_rep_date', ['repId', 'planDate'], { unique: true })
export class RoutePlan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  @Index('idx_route_plans_date')
  @Column({ name: 'plan_date', type: 'date' })
  planDate!: string;

  @Column({ type: 'text', default: 'manual' })
  source!: RouteSource;

  @Column({ name: 'ai_est_distance', type: 'real', nullable: true })
  aiEstDistance?: number | null;

  @Column({ name: 'ai_est_duration', type: 'integer', nullable: true })
  aiEstDuration?: number | null;

  @Column({ name: 'ai_savings_min', type: 'integer', nullable: true })
  aiSavingsMin?: number | null;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => RouteStop, (s) => s.plan, { cascade: true })
  stops?: RouteStop[];
}
