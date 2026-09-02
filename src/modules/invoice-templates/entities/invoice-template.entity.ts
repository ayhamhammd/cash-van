import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A designed print layout ("Template Designer" document). One row per saved
 * template; the layout itself is the designer's JSON (zones + absolutely
 * positioned elements in millimetres — see builtin-layouts.ts for the shape).
 *
 * Resolution order when printing a document type:
 *   1. the template pinned to the requesting branch (store),
 *   2. the global default (branch_id NULL, is_default true),
 *   3. the built-in fallback layout compiled into the service.
 */
@Entity({ name: 'invoice_templates' })
@Index('uq_invoice_templates_doc_branch', ['documentType', 'branchId'], { unique: true })
@Index('idx_invoice_templates_doc', ['documentType'])
export class InvoiceTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  /** SALE_INVOICE | RETURN_INVOICE | … — see DOCUMENT_TYPES in the DTO. */
  @Column({ name: 'document_type', type: 'text' })
  documentType!: string;

  /** A4 | A5 | THERMAL_80 */
  @Column({ name: 'paper_size', type: 'text', default: 'A4' })
  paperSize!: string;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault!: boolean;

  /** null = global default; set = pinned to one branch (warehouse/store id). */
  @Column({ name: 'branch_id', type: 'text', nullable: true })
  branchId!: string | null;

  @Column({ type: 'jsonb', default: {} })
  layout!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
