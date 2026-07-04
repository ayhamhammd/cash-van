import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One AI report-agent chat thread. `messages` is the Anthropic message array
 * (user/assistant turns including tool_use / tool_result blocks) so a follow-up
 * request can resume with full context. Typed as `unknown[]` here (the store
 * casts to/from StoredMessage[]) to avoid TypeORM DeepPartial recursion on the
 * SDK's deeply-nested block unions. Single-tenant deployment, so no tenant
 * scoping — `createdBy` is just the admin user who started the thread.
 */
@Entity({ name: 'agent_conversations' })
@Index('idx_agent_conversations_updated', ['updatedAt'])
export class AgentConversation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', nullable: true })
  title?: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy?: string | null;

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  messages!: unknown[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
