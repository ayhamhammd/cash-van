import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type ApprovalAction = 'submitted' | 'approved' | 'rejected' | 'override';

@Entity({ name: 'invoice_approvals' })
@Index('idx_invoice_approvals_invoice_acted', ['invoiceId', 'actedAt'])
export class InvoiceApproval {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'invoice_id', type: 'uuid' })
  invoiceId!: string;

  @Column({ type: 'text' })
  action!: ApprovalAction;

  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId?: string | null;

  @Column({ type: 'text', nullable: true })
  reason?: string | null;

  @CreateDateColumn({ name: 'acted_at', type: 'timestamptz' })
  actedAt!: Date;
}
