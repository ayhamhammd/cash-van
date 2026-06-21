import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

import type { ReportFormat } from '../agent.types';

/**
 * Metadata for one report file the agent produced. The bytes live in object
 * storage under `storageKey`; this row lets us re-serve the file (with the
 * right filename + content-type) and audit what SQL produced it.
 */
@Entity({ name: 'agent_reports' })
@Index('idx_agent_reports_conversation', ['conversationId', 'createdAt'])
export class AgentReport {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'conversation_id', type: 'uuid', nullable: true })
  conversationId?: string | null;

  @Column({ type: 'text', nullable: true })
  title?: string | null;

  @Column({ type: 'text' })
  format!: ReportFormat;

  @Column({ type: 'text' })
  filename!: string;

  @Column({ name: 'storage_key', type: 'text' })
  storageKey!: string;

  @Column({ name: 'content_type', type: 'text' })
  contentType!: string;

  @Column({ name: 'row_count', type: 'integer', default: 0 })
  rowCount!: number;

  @Column({ name: 'sql_text', type: 'text', nullable: true })
  sqlText?: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
