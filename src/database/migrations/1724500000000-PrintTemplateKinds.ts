import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Print templates are keyed by voucher kind (SALE, RETURN, TRANSFER, …) rather
 * than by the POS document names the table was created with. The two names
 * that map onto a kind are renamed; the rest (X/Z reports, POS report types,
 * scale and barcode labels) were POS-only documents nothing here prints, so
 * their rows are dropped. See docs/SPEC-print-templates.md §1.
 */
export class PrintTemplateKinds1724500000000 implements MigrationInterface {
  name = 'PrintTemplateKinds1724500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE "invoice_templates" SET "document_type" = 'SALE' WHERE "document_type" = 'SALE_INVOICE'`);
    await q.query(`UPDATE "invoice_templates" SET "document_type" = 'RETURN' WHERE "document_type" = 'RETURN_INVOICE'`);
    await q.query(`
      DELETE FROM "invoice_templates"
      WHERE "document_type" NOT IN (
        'SALE','RETURN','ORDER','TRANSFER','TRANSFER_IN','TRANSFER_OUT',
        'IN','OUT','PURCHASE','ADJUSTMENT','PAYMENT_IN','PAYMENT_OUT'
      )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    // The deleted POS-only rows are not restorable; only the renames reverse.
    await q.query(`UPDATE "invoice_templates" SET "document_type" = 'SALE_INVOICE' WHERE "document_type" = 'SALE'`);
    await q.query(`UPDATE "invoice_templates" SET "document_type" = 'RETURN_INVOICE' WHERE "document_type" = 'RETURN'`);
  }
}
