import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Per-entity incremental cursor + last-run summary (for the dashboard status). */
@Entity({ name: 'erp_sync_cursor' })
export class ErpSyncCursor {
  /** 'item' | 'unit' | 'warehouse' | 'stock' */
  @PrimaryColumn({ type: 'text' })
  entity!: string;

  /** High-water mark for the next incremental pull (`updatedSince`). */
  @Column({ name: 'updated_since', type: 'timestamptz', nullable: true })
  updatedSince?: Date | null;

  @Column({ name: 'last_run_at', type: 'timestamptz', nullable: true })
  lastRunAt?: Date | null;

  @Column({ name: 'last_status', type: 'text', nullable: true })
  lastStatus?: string | null;

  @Column({ name: 'last_count', type: 'integer', default: 0 })
  lastCount!: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null;
}
