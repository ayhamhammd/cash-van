import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type DeliveryRunStatus = 'OPEN' | 'CLOSED';

/**
 * Mirror of one ERP delivery run (docs/SPEC-delivery-rep.md §4.1).
 *
 * The ERP owns the run (R1). This row is written only by the pull and by the
 * dashboard's live writes re-reading the run they just changed — never edited
 * here on its own.
 */
@Entity({ name: 'delivery_runs' })
@Index('uq_delivery_runs_erp_id', ['erpId'], { unique: true })
export class DeliveryRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'erp_id', type: 'text' })
  erpId!: string;

  @Column({ name: 'run_number', type: 'text', nullable: true })
  runNumber?: string | null;

  /** The rep whose code is the driver's ERP salesman code; null when none matches. */
  @Column({ name: 'rep_id', type: 'uuid', nullable: true })
  repId?: string | null;

  @Column({ name: 'driver_code', type: 'text', nullable: true })
  driverCode?: string | null;

  @Column({ name: 'driver_name', type: 'text', nullable: true })
  driverName?: string | null;

  @Column({ name: 'vehicle_erp_id', type: 'text', nullable: true })
  vehicleErpId?: string | null;

  @Column({ name: 'vehicle_name', type: 'text', nullable: true })
  vehicleName?: string | null;

  @Column({ name: 'vehicle_plate', type: 'text', nullable: true })
  vehiclePlate?: string | null;

  /** YYYY-MM-DD. */
  @Column({ name: 'run_date', type: 'date', nullable: true })
  runDate?: string | null;

  @Column({ type: 'text', default: 'OPEN' })
  status!: DeliveryRunStatus;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  @Column({ name: 'opened_at', type: 'timestamptz', nullable: true })
  openedAt?: Date | null;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt?: Date | null;

  /** The ERP's updatedAt of the version mirrored here — an older reply never overwrites a newer one. */
  @Column({ name: 'erp_updated_at', type: 'timestamptz', nullable: true })
  erpUpdatedAt?: Date | null;

  @Column({ name: 'synced_at', type: 'timestamptz', nullable: true })
  syncedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
