import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';

import { filsToJod } from '../../common/utils/currency.util';
import { Invoice } from '../invoices/entities/invoice.entity';
import { InvoiceLine } from '../invoices/entities/invoice-line.entity';
import { CreditNote } from './entities/credit-note.entity';
import { CreditNoteLine } from './entities/credit-note-line.entity';
import { Customer } from '../customers/entities/customer.entity';

const DATE_FMT = 'DD-MM-YYYY';
const BUYER_ID_THRESHOLD_FILS = 10_000_000; // 10,000 JOD

export interface SellerParty {
  tin: string | null;
  nameAr: string;
  nameEn: string | null;
  address: string | null;
}

type JsonObject = Record<string, unknown>;

/**
 * Builds the JoFotara JSON payload (port of spec §6). This is the ONLY place
 * fils are converted to '1.234' JOD strings.
 */
@Injectable()
export class JoFotaraBuilderService {
  buildInvoicePayload(
    invoice: Invoice,
    lines: InvoiceLine[],
    seller: SellerParty,
    buyer: Customer,
  ): JsonObject {
    return {
      invoiceId: invoice.invoiceNumber,
      uuid: invoice.jofotaraUuid,
      issueDate: dayjs(invoice.confirmedAt ?? invoice.createdAt).format(DATE_FMT),
      invoiceTypeCode: invoice.invoiceTypeCode,
      paymentMeans: invoice.paymentMethodCode,
      ...(invoice.note ? { note: invoice.note } : {}),
      accountingSupplierParty: this.buildSeller(seller),
      accountingCustomerParty: this.buildBuyer(buyer, invoice.grandTotal),
      invoiceLines: lines.map((l, i) => this.buildLine(i, l)),
      taxTotal: { taxAmount: filsToJod(invoice.totalTax) },
      legalMonetaryTotal: {
        lineExtensionAmount: filsToJod(
          invoice.netTaxable + invoice.netInclusive + invoice.netExempt,
        ),
        taxExclusiveAmount: filsToJod(invoice.netTaxable + invoice.netExempt),
        taxInclusiveAmount: filsToJod(invoice.grandTotal),
        allowanceTotalAmount: filsToJod(
          invoice.totalLineDiscounts + invoice.invoiceDiscountAmount,
        ),
        payableAmount: filsToJod(invoice.grandTotal),
      },
    };
  }

  buildCreditNotePayload(
    cn: CreditNote,
    lines: CreditNoteLine[],
    seller: SellerParty,
    buyer: Customer,
    originalInvoiceNumber: string,
    originalInvoiceUuid: string | null,
    originalIssueDate: Date,
  ): JsonObject {
    return {
      invoiceId: cn.creditNoteNumber,
      uuid: cn.jofotaraUuid,
      issueDate: dayjs(cn.issuedAt).format(DATE_FMT),
      invoiceTypeCode: cn.invoiceTypeCode, // 381
      paymentMeans: '012',
      reasonForReturn: cn.reason,
      billingReference: {
        invoiceDocumentReference: {
          id: originalInvoiceNumber,
          uuid: originalInvoiceUuid,
          issueDate: dayjs(originalIssueDate).format(DATE_FMT),
        },
      },
      accountingSupplierParty: this.buildSeller(seller),
      accountingCustomerParty: this.buildBuyer(buyer, cn.grandReturnTotal),
      invoiceLines: lines.map((l, i) => this.buildCreditLine(i, l)),
      taxTotal: { taxAmount: filsToJod(cn.totalReturnTax) },
      legalMonetaryTotal: {
        lineExtensionAmount: filsToJod(cn.netAfterLineDiscounts),
        taxExclusiveAmount: filsToJod(cn.netAfterLineDiscounts),
        taxInclusiveAmount: filsToJod(cn.grandReturnTotal),
        allowanceTotalAmount: filsToJod(cn.totalLineDiscounts),
        payableAmount: filsToJod(cn.grandReturnTotal),
      },
    };
  }

  private buildSeller(seller: SellerParty): JsonObject {
    return {
      party: {
        partyName: { name: seller.nameEn ?? seller.nameAr },
        partyTaxScheme: { companyId: seller.tin, taxScheme: { id: 'VAT' } },
        ...(seller.address ? { postalAddress: { streetName: seller.address } } : {}),
      },
    };
  }

  private buildBuyer(buyer: Customer, grandTotalFils: number): JsonObject {
    const idRequired = grandTotalFils >= BUYER_ID_THRESHOLD_FILS;
    const idType = buyer.tin ? 'TIN' : buyer.nin ? 'NIN' : buyer.passportNumber ? 'PN' : null;
    const idValue = buyer.tin ?? buyer.nin ?? buyer.passportNumber ?? null;
    const hasId = idValue !== null;
    return {
      party: {
        partyName: { name: buyer.nameEn ?? buyer.nameAr },
        ...(idRequired || hasId
          ? {
              partyIdentification: { id: idValue, schemeId: idType },
              ...(buyer.tin
                ? { partyTaxScheme: { companyId: buyer.tin, taxScheme: { id: 'VAT' } } }
                : {}),
            }
          : {}),
        ...(buyer.phone ? { contact: { telephone: buyer.phone } } : {}),
        ...(buyer.cityCode ? { postalAddress: { cityCode: buyer.cityCode } } : {}),
      },
    };
  }

  private buildLine(idx: number, l: InvoiceLine): JsonObject {
    const percent = (l.taxType === 'EXEMPT' ? 0 : Number(l.taxRate)) * 100;
    return {
      id: String(idx + 1),
      invoicedQuantity: { quantity: Number(l.quantity), unitCode: l.unitOfMeasure },
      lineExtensionAmount: filsToJod(l.netAfterLineDiscount),
      ...(l.lineDiscountAmount > 0
        ? {
            allowanceCharge: {
              chargeIndicator: false,
              amount: filsToJod(l.lineDiscountAmount),
              baseAmount: filsToJod(l.subtotal),
            },
          }
        : {}),
      taxTotal: {
        taxAmount: filsToJod(l.taxAmount),
        taxSubtotal: {
          taxableAmount: filsToJod(l.taxableBase),
          taxAmount: filsToJod(l.taxAmount),
          taxCategory: { id: l.taxCategory, percent, taxScheme: { id: 'VAT' } },
        },
      },
      item: { name: l.productId },
      price: { priceAmount: filsToJod(l.unitPrice), baseQuantity: 1 },
    };
  }

  private buildCreditLine(idx: number, l: CreditNoteLine): JsonObject {
    const percent = (l.taxType === 'EXEMPT' ? 0 : Number(l.taxRate)) * 100;
    return {
      id: String(idx + 1),
      invoicedQuantity: { quantity: Number(l.quantity), unitCode: l.unitOfMeasure },
      lineExtensionAmount: filsToJod(l.netAfterLineDiscount),
      taxTotal: {
        taxAmount: filsToJod(l.taxAmount),
        taxSubtotal: {
          taxableAmount: filsToJod(l.taxableBase),
          taxAmount: filsToJod(l.taxAmount),
          taxCategory: { id: l.taxCategory, percent, taxScheme: { id: 'VAT' } },
        },
      },
      item: { name: l.productId },
      price: { priceAmount: filsToJod(l.unitPrice), baseQuantity: 1 },
    };
  }
}
