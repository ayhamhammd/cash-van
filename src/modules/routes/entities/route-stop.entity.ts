import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { RoutePlan } from './route-plan.entity';

export type RouteStopStatus = 'pending' | 'visited' | 'skipped';

@Entity({ name: 'route_stops' })
@Index('idx_route_stops_plan_order', ['planId', 'stopOrder'])
@Index('idx_route_stops_customer_status', ['customerId', 'status'])
export class RouteStop {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'plan_id', type: 'uuid' })
  planId!: string;

  @ManyToOne(() => RoutePlan, (p) => p.stops, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_id' })
  plan?: RoutePlan;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  @Column({ name: 'stop_order', type: 'integer' })
  stopOrder!: number;

  @Column({ name: 'est_arrival', type: 'timestamptz', nullable: true })
  estArrival?: Date | null;

  @Column({ name: 'est_duration_min', type: 'integer', default: 20 })
  estDurationMin!: number;

  @Column({ name: 'actual_arrival', type: 'timestamptz', nullable: true })
  actualArrival?: Date | null;

  @Column({ name: 'actual_departure', type: 'timestamptz', nullable: true })
  actualDeparture?: Date | null;

  @Column({ type: 'text', default: 'pending' })
  status!: RouteStopStatus;

  @Column({ name: 'skip_reason', type: 'text', nullable: true })
  skipReason?: string | null;

  /** True when this stop was rolled forward from an earlier missed day. */
  @Column({ name: 'carried_over', type: 'boolean', default: false })
  carriedOver!: boolean;
}
