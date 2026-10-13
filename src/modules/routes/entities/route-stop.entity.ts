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
  /**
   * Who the stop is — filled in on read, never stored.
   *
   * `route_stops` holds a customer_id and nothing else, so a plan served as it
   * is stored names nobody; the Daily-plans screen showed a UUID fragment per
   * stop because that was all it had. RoutesService.nameStops fills these in on
   * every read path. They are not @Column, so nothing writes them back.
   */
  customerName?: string | null;
  customerNumber?: string | null;
  lat?: number | null;
  lng?: number | null;

  @Column({ name: 'carried_over', type: 'boolean', default: false })
  carriedOver!: boolean;
}
