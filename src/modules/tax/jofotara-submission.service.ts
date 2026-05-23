import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';

import { Invoice } from '../invoices/entities/invoice.entity';
import { InvoiceLine } from '../invoices/entities/invoice-line.entity';
import { CreditNote } from './entities/credit-note.entity';
import { CreditNoteLine } from './entities/credit-note-line.entity';
import { JoFotaraSubmissionLog } from './entities/jofotara-submission-log.entity';
import { Customer } from '../customers/entities/customer.entity';
import { JoFotaraBuilderService } from './jofotara-builder.service';
import { InvoiceValidatorService } from './invoice-validator.service';
import { JoFotaraApiService } from './jofotara-api.service';
import { TaxLedgerService } from './tax-ledger.service';
import { SettingsService } from '../settings/settings.service';

export interface SubmissionResult {
  status: string;
  qrCode?: string | null;
  registrationNumber?: string | null;
  errors?: { field: string; message: string }[];
}

/**
 * Orchestrates ISTD submission for invoices and credit notes:
 * validate → build payload → submit (mock/real) → log attempt → write back
 * status/QR → post to the tax ledger on VALIDATED.
 *
 * Triggered by `invoice.confirmed` / `credit_note.created` events, and exposed
 * synchronously via submitInvoice/submitCreditNote for manual retry + testing.
 */
@Injectable()
export class JoFotaraSubmissionService {
  private readonly logger = new Logger(JoFotaraSubmissionService.name);

  constructor(
    @InjectRepository(Invoice) private readonly invoices: Repository<Invoice>,
    @InjectRepository(InvoiceLine) private readonly invoiceLines: Repository<InvoiceLine>,
    @InjectRepository(CreditNote) private readonly creditNotes: Repository<CreditNote>,
    @InjectRepository(CreditNoteLine) private readonly creditNoteLines: Repository<CreditNoteLine>,
    @InjectRepository(JoFotaraSubmissionLog) private readonly subLog: Repository<JoFotaraSubmissionLog>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    private readonly builder: JoFotaraBuilderService,
    private readonly validator: InvoiceValidatorService,
    private readonly api: JoFotaraApiService,
    private readonly ledger: TaxLedgerService,
    private readonly settings: SettingsService,
  ) {}

  @OnEvent('invoice.confirmed')
  async onInvoiceConfirmed(p: { invoiceId: string }): Promise<void> {
    try {
      await this.submitInvoice(p.invoiceId);
    } catch (err) {
      this.logger.warn(`auto-submit invoice ${p.invoiceId} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent('credit_note.created')
  async onCreditNoteCreated(p: { creditNoteId: string }): Promise<void> {
    try {
      await this.submitCreditNote(p.creditNoteId);
    } catch (err) {
      this.logger.warn(`auto-submit credit note ${p.creditNoteId} failed: ${(err as Error).message}`);
    }
  }

  async submitInvoice(invoiceId: string): Promise<SubmissionResult> {
    const invoice = await this.invoices.findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice ${invoiceId} not found`);
    const lines = await this.invoiceLines.find({ where: { invoiceId } });
    const buyer = await this.customers.findOneOrFail({ where: { id: invoice.customerId } });
    const seller = await this.settings.getSellerInfo();

    const errors = this.validator.validate(invoice, lines, seller, buyer);
    if (errors.length > 0) {
      invoice.jofotaraStatus = 'REJECTED';
      invoice.jofotaraErrorCode = 'VALIDATION';
      invoice.jofotaraErrorMessage = errors.map((e) => `${e.field}: ${e.message}`).join('; ');
      await this.invoices.save(invoice);
      return { status: 'REJECTED', errors };
    }

    const payload = this.builder.buildInvoicePayload(invoice, lines, seller, buyer);
    const creds = await this.settings.getJoFotaraCredentials();
    const attempt = (await this.subLog.count({ where: { documentId: invoiceId } })) + 1;
    invoice.jofotaraStatus = 'SUBMITTED';
    await this.invoices.save(invoice);

    const res = await this.api.submit(payload, creds);
    await this.subLog.save(
      this.subLog.create({
        documentKind: 'INVOICE',
        documentId: invoiceId,
        attempt,
        requestUrl: res.requestUrl ?? null,
        requestPayload: payload,
        responseStatus: res.responseStatus ?? null,
        responseBody: res.responseBody ?? null,
        durationMs: res.durationMs,
        error: res.success ? null : `${res.errorCode}: ${res.errorMessage}`,
      }),
    );

    if (res.success) {
      invoice.jofotaraStatus = 'VALIDATED';
      invoice.jofotaraQrCode = res.qrCode ?? null;
      invoice.jofotaraRegistrationNumber = res.registrationNumber ?? null;
      invoice.jofotaraSubmittedAt = new Date();
      await this.invoices.save(invoice);
      await this.ledger.post({
        entryType: 'SALE',
        documentKind: 'INVOICE',
        documentId: invoice.id,
        documentNumber: invoice.invoiceNumber,
        entryDate: (invoice.confirmedAt ?? invoice.createdAt).toISOString().slice(0, 10),
        buyerName: buyer.nameAr,
        buyerTin: buyer.tin ?? null,
        taxableAmount: invoice.netTaxable + invoice.netInclusive,
        taxAmount: invoice.totalTax,
        grandTotal: invoice.grandTotal,
        jofotaraStatus: 'VALIDATED',
        qrCode: res.qrCode ?? null,
      });
      return { status: 'VALIDATED', qrCode: res.qrCode, registrationNumber: res.registrationNumber };
    }

    invoice.jofotaraStatus = 'ERROR';
    invoice.jofotaraErrorCode = res.errorCode ?? null;
    invoice.jofotaraErrorMessage = res.errorMessage ?? null;
    await this.invoices.save(invoice);
    return { status: 'ERROR', errors: [{ field: 'istd', message: res.errorMessage ?? 'submit failed' }] };
  }

  async submitCreditNote(creditNoteId: string): Promise<SubmissionResult> {
    const cn = await this.creditNotes.findOne({ where: { id: creditNoteId } });
    if (!cn) throw new NotFoundException(`Credit note ${creditNoteId} not found`);
    const lines = await this.creditNoteLines.find({ where: { creditNoteId } });
    const buyer = await this.customers.findOneOrFail({ where: { id: cn.customerId } });
    const seller = await this.settings.getSellerInfo();
    const original = await this.invoices.findOneOrFail({ where: { id: cn.originalInvoiceId } });

    const payload = this.builder.buildCreditNotePayload(
      cn,
      lines,
      seller,
      buyer,
      original.invoiceNumber,
      original.jofotaraUuid ?? null,
      original.confirmedAt ?? original.createdAt,
    );
    const creds = await this.settings.getJoFotaraCredentials();
    const attempt = (await this.subLog.count({ where: { documentId: creditNoteId } })) + 1;
    cn.jofotaraStatus = 'SUBMITTED';
    await this.creditNotes.save(cn);

    const res = await this.api.submit(payload, creds);
    await this.subLog.save(
      this.subLog.create({
        documentKind: 'CREDIT_NOTE',
        documentId: creditNoteId,
        attempt,
        requestUrl: res.requestUrl ?? null,
        requestPayload: payload,
        responseStatus: res.responseStatus ?? null,
        responseBody: res.responseBody ?? null,
        durationMs: res.durationMs,
        error: res.success ? null : `${res.errorCode}: ${res.errorMessage}`,
      }),
    );

    if (res.success) {
      cn.jofotaraStatus = 'VALIDATED';
      cn.jofotaraQrCode = res.qrCode ?? null;
      cn.jofotaraRegistrationNumber = res.registrationNumber ?? null;
      cn.jofotaraSubmittedAt = new Date();
      await this.creditNotes.save(cn);
      await this.ledger.post({
        entryType: 'RETURN',
        documentKind: 'CREDIT_NOTE',
        documentId: cn.id,
        documentNumber: cn.creditNoteNumber,
        referenceDocumentNumber: original.invoiceNumber,
        entryDate: cn.issuedAt.toISOString().slice(0, 10),
        buyerName: buyer.nameAr,
        buyerTin: buyer.tin ?? null,
        taxableAmount: -cn.netAfterLineDiscounts,
        taxAmount: -cn.totalReturnTax,
        grandTotal: -cn.grandReturnTotal,
        jofotaraStatus: 'VALIDATED',
        qrCode: res.qrCode ?? null,
      });
      return { status: 'VALIDATED', qrCode: res.qrCode, registrationNumber: res.registrationNumber };
    }

    cn.jofotaraStatus = 'ERROR';
    cn.jofotaraErrorCode = res.errorCode ?? null;
    cn.jofotaraErrorMessage = res.errorMessage ?? null;
    await this.creditNotes.save(cn);
    return { status: 'ERROR', errors: [{ field: 'istd', message: res.errorMessage ?? 'submit failed' }] };
  }

  async submissionLog(documentId: string): Promise<JoFotaraSubmissionLog[]> {
    return this.subLog.find({ where: { documentId }, order: { attempt: 'ASC' } });
  }
}
