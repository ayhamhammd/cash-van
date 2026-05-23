import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { LedgerDocumentKind } from './tax-ledger-entry.entity';

@Entity({ name: 'jofotara_submission_log' })
@Index('idx_jsl_document', ['documentId', 'attempt'])
export class JoFotaraSubmissionLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'document_kind', type: 'text' })
  documentKind!: LedgerDocumentKind;

  @Column({ name: 'document_id', type: 'uuid' })
  documentId!: string;

  @Column({ type: 'integer' })
  attempt!: number;

  @Column({ name: 'request_url', type: 'text', nullable: true })
  requestUrl?: string | null;

  @Column({ name: 'request_payload', type: 'jsonb', nullable: true })
  requestPayload?: Record<string, unknown> | null;

  @Column({ name: 'response_status', type: 'integer', nullable: true })
  responseStatus?: number | null;

  @Column({ name: 'response_body', type: 'jsonb', nullable: true })
  responseBody?: Record<string, unknown> | null;

  @Column({ name: 'duration_ms', type: 'integer', nullable: true })
  durationMs?: number | null;

  @Column({ type: 'text', nullable: true })
  error?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
