import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type AuditAction = 'create' | 'update' | 'delete' | string;

/** Range-partitioned monthly by acted_at (see migration). */
@Entity({ name: 'audit_log' })
@Index('idx_audit_entity', ['entity', 'entityId', 'actedAt'])
@Index('idx_audit_actor', ['actorId', 'actedAt'])
export class AuditLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId?: string | null;

  @Column({ type: 'text' })
  entity!: string;

  @Column({ name: 'entity_id', type: 'text' })
  entityId!: string;

  @Column({ type: 'text' })
  action!: AuditAction;

  @Column({ name: 'diff_json', type: 'jsonb', nullable: true })
  diffJson?: Record<string, unknown> | null;

  @Column({ name: 'ip_address', type: 'inet', nullable: true })
  ipAddress?: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent?: string | null;

  @CreateDateColumn({ name: 'acted_at', type: 'timestamptz' })
  actedAt!: Date;
}
