import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'customer_visits' })
@Index('idx_cv_customer_visited_desc', ['customerId', 'visitedAt'])
@Index('idx_cv_rep_visited_desc', ['repId', 'visitedAt'])
export class CustomerVisit {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  @Column({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  @Column({ name: 'visited_at', type: 'timestamptz', default: () => 'now()' })
  visitedAt!: Date;

  @Column({ name: 'had_sale', type: 'boolean', default: false })
  hadSale!: boolean;

  @Column({ name: 'visit_note', type: 'text', nullable: true })
  visitNote?: string | null;

  @Column({ type: 'double precision', nullable: true })
  lat?: number | null;

  @Column({ type: 'double precision', nullable: true })
  lng?: number | null;
}
