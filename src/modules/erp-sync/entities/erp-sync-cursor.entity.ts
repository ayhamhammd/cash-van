import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Per-entity incremental cursor + last-run summary (for the dashboard status). */
@Entity({ name: 'erp_sync_cursor' })
export class ErpSyncCursor {
  /** 'item' | 'unit' | 'warehouse' | 'customer' | 'movements:<store>' … */
  @PrimaryColumn({ type: 'text' })
  entity!: string;

  /** High-water mark for the next incremental pull (`updatedSince`). */
  @Column({ name: 'updated_since', type: 'timestamptz', nullable: true })
  updatedSince?: Date | null;

  @Column({ name: 'last_run_at', type: 'timestamptz', nullable: true })
  lastRunAt?: Date | null;

  /** 'running' | 'ok' | 'failed' | 'skipped'. */
  @Column({ name: 'last_status', type: 'text', nullable: true })
  lastStatus?: string | null;

  @Column({ name: 'last_count', type: 'integer', default: 0 })
  lastCount!: number;

  /**
   * Rows the last run could not apply and deliberately stepped over (a product
   * whose barcode collides, a price list whose code is taken). Separate from
   * `last_count` so "900 in, 3 skipped" never reads as a clean run.
   */
  @Column({ name: 'last_skipped', type: 'integer', default: 0 })
  lastSkipped!: number;

  /** Wall-clock of the last run, ms — the only way to see which step is slow. */
  @Column({ name: 'duration_ms', type: 'integer', nullable: true })
  durationMs?: number | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null;
}
