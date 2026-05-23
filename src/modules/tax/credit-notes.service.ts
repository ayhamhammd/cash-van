import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';

import { CreditNote } from './entities/credit-note.entity';
import { CreditNoteLine } from './entities/credit-note-line.entity';
import { Invoice } from '../invoices/entities/invoice.entity';
import { InvoiceLine } from '../invoices/entities/invoice-line.entity';
import { calculateInvoice, CalcLineInput } from '../invoices/invoice-calculator';
import { CreateCreditNoteDto } from './dto/create-credit-note.dto';

export interface ReturnableLine {
  invoiceLineId: string;
  productId: string;
  originalQty: number;
  returnableQty: number;
}

@Injectable()
export class CreditNotesService {
  constructor(
    @InjectRepository(CreditNote) private readonly creditNotes: Repository<CreditNote>,
    @InjectRepository(CreditNoteLine) private readonly cnLines: Repository<CreditNoteLine>,
    @InjectRepository(Invoice) private readonly invoices: Repository<Invoice>,
    @InjectRepository(InvoiceLine) private readonly invoiceLines: Repository<InvoiceLine>,
    private readonly ds: DataSource,
    private readonly bus: EventEmitter2,
  ) {}

  list(): Promise<CreditNote[]> {
    return this.creditNotes.find({ order: { createdAt: 'DESC' }, relations: { lines: true } });
  }

  async findOne(id: string): Promise<CreditNote> {
    const cn = await this.creditNotes.findOne({ where: { id }, relations: { lines: true } });
    if (!cn) throw new NotFoundException(`Credit note ${id} not found`);
    return cn;
  }

  forInvoice(invoiceId: string): Promise<CreditNote[]> {
    return this.creditNotes.find({
      where: { originalInvoiceId: invoiceId },
      relations: { lines: true },
      order: { createdAt: 'DESC' },
    });
  }

  /** Remaining returnable quantity per line of an invoice. */
  async returnable(invoiceId: string): Promise<ReturnableLine[]> {
    const lines = await this.invoiceLines.find({ where: { invoiceId } });
    if (lines.length === 0) {
      await this.invoices.findOneOrFail({ where: { id: invoiceId } });
    }
    const rows = (await this.ds.query(
      `SELECT invoice_line_id, returnable_qty
       FROM invoice_line_returnable_qty
       WHERE invoice_line_id = ANY($1)`,
      [lines.map((l) => l.id)],
    )) as Array<{ invoice_line_id: string; returnable_qty: string }>;
    const returnableById = new Map(rows.map((r) => [String(r.invoice_line_id), Number(r.returnable_qty)]));
    return lines.map((l) => ({
      invoiceLineId: l.id,
      productId: l.productId,
      originalQty: Number(l.quantity),
      returnableQty: returnableById.get(l.id) ?? Number(l.quantity),
    }));
  }

  async create(dto: CreateCreditNoteDto): Promise<CreditNote> {
    const invoice = await this.invoices.findOne({ where: { id: dto.originalInvoiceId } });
    if (!invoice) throw new BadRequestException(`Invoice ${dto.originalInvoiceId} not found`);
    if (invoice.status === 'draft' || invoice.status === 'cancelled') {
      throw new BadRequestException('Can only return against a confirmed invoice');
    }

    const lineIds = dto.lines.map((l) => l.invoiceLineId);
    const origLines = await this.invoiceLines.find({ where: { id: In(lineIds) } });
    const origById = new Map(origLines.map((l) => [l.id, l]));
    const returnable = new Map((await this.returnable(invoice.id)).map((r) => [r.invoiceLineId, r.returnableQty]));

    for (const l of dto.lines) {
      const orig = origById.get(l.invoiceLineId);
      if (!orig || orig.invoiceId !== invoice.id) {
        throw new BadRequestException(`Line ${l.invoiceLineId} is not part of invoice ${invoice.id}`);
      }
      const remaining = returnable.get(l.invoiceLineId) ?? 0;
      if (l.returnQuantity <= 0 || l.returnQuantity > remaining) {
        throw new BadRequestException(
          `Return qty ${l.returnQuantity} for line ${l.invoiceLineId} exceeds returnable ${remaining}`,
        );
      }
    }

    // Compute return amounts via the shared calculator (line-level only).
    const calcInputs: CalcLineInput[] = dto.lines.map((l) => {
      const orig = origById.get(l.invoiceLineId)!;
      return {
        quantity: l.returnQuantity,
        unitPrice: orig.unitPrice,
        taxType: orig.taxType,
        taxRate: Number(orig.taxRate),
        // line discount proportional to returned fraction
        lineDiscountType: 'FIXED_AMOUNT',
        lineDiscountValue: Math.round(
          (orig.lineDiscountAmount * l.returnQuantity) / Number(orig.quantity),
        ),
      };
    });
    const calc = calculateInvoice({ lines: calcInputs });

    const number = await this.nextNumber();
    const saved = await this.ds.transaction(async (em) => {
      const cn = em.getRepository(CreditNote).create({
        creditNoteNumber: number,
        originalInvoiceId: invoice.id,
        repId: invoice.repId,
        customerId: invoice.customerId,
        reason: dto.reason,
        jofotaraUuid: randomUUID(),
        subtotal: calc.subtotal,
        totalLineDiscounts: calc.totalLineDiscounts,
        netAfterLineDiscounts: calc.netTaxable + calc.netInclusive + calc.netExempt,
        totalReturnTax: calc.totalTax,
        grandReturnTotal: calc.grandTotal,
      });
      const persisted = await em.getRepository(CreditNote).save(cn);

      const lines = dto.lines.map((l, i) => {
        const orig = origById.get(l.invoiceLineId)!;
        const c = calc.lines[i];
        return em.getRepository(CreditNoteLine).create({
          creditNoteId: persisted.id,
          invoiceLineId: l.invoiceLineId,
          productId: orig.productId,
          quantity: l.returnQuantity.toString(),
          unitPrice: orig.unitPrice,
          unitOfMeasure: orig.unitOfMeasure,
          taxType: orig.taxType,
          taxCategory: orig.taxCategory,
          taxRate: Number(orig.taxRate).toFixed(4),
          subtotal: c.subtotal,
          lineDiscountAmount: c.lineDiscountAmount,
          netAfterLineDiscount: c.netAfterLineDiscount,
          taxableBase: c.taxableBase,
          taxAmount: c.taxAmount,
          lineTotal: c.lineTotal,
        });
      });
      await em.getRepository(CreditNoteLine).save(lines);

      await em.getRepository(Invoice).update({ id: invoice.id }, { hasCreditNotes: true });
      return persisted;
    });

    this.bus.emit('credit_note.created', { creditNoteId: saved.id });
    return this.findOne(saved.id);
  }

  private async nextNumber(): Promise<string> {
    const rows = (await this.ds.query(
      `SELECT nextval('credit_note_number_seq') AS seq`,
    )) as Array<{ seq: string }>;
    return `CN-${new Date().getFullYear()}-${String(Number(rows[0].seq)).padStart(6, '0')}`;
  }
}
