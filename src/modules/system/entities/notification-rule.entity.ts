import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type NotificationTrigger =
  | 'anomaly_high'
  | 'churn_spike'
  | 'rep_offline'
  | 'overdue';
export type NotificationChannel = 'email' | 'sms' | 'whatsapp' | 'push';

@Entity({ name: 'notification_rules' })
export class NotificationRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Index('idx_notif_active_trigger')
  @Column({ type: 'text' })
  trigger!: NotificationTrigger;

  @Column({ type: 'jsonb', nullable: true })
  threshold?: Record<string, unknown> | null;

  @Column({ type: 'text' })
  channel!: NotificationChannel;

  @Column({ type: 'uuid', array: true, default: () => "'{}'" })
  recipients!: string[];

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
