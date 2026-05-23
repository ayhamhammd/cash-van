import { Injectable } from '@nestjs/common';

import { Invoice } from '../invoices/entities/invoice.entity';
import { InvoiceLine } from '../invoices/entities/invoice-line.entity';
import { Customer } from '../customers/entities/customer.entity';
import { SellerParty } from './jofotara-builder.service';

const BUYER_ID_THRESHOLD_FILS = 10_000_000; // 10,000 JOD

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Pre-submission validation (port of spec §9). Returns a list of errors; an
 * empty list means the invoice is safe to submit to ISTD.
 */
@Injectable()
export class InvoiceValidatorService {
  validate(
    invoice: Invoice,
    lines: InvoiceLine[],
    seller: SellerParty,
    buyer: Customer,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    if (!seller.tin?.trim()) {
      errors.push({ field: 'seller.tin', message: 'Seller TIN is required (set it in Settings)' });
    }

    const buyerId = buyer.tin ?? buyer.nin ?? buyer.passportNumber ?? '';
    if (invoice.grandTotal >= BUYER_ID_THRESHOLD_FILS && !buyerId.trim()) {
      errors.push({
        field: 'buyer.id',
        message: `Buyer TIN/NIN/Passport is required for invoices >= 10,000 JOD`,
      });
    }

    if (lines.length === 0) {
      errors.push({ field: 'lines', message: 'Invoice must have at least one line item' });
    }

    lines.forEach((l, idx) => {
      const prefix = `lines[${idx}]`;
      if (Number(l.quantity) <= 0) {
        errors.push({ field: `${prefix}.quantity`, message: 'Quantity must be > 0' });
      }
      if (l.unitPrice < 0) {
        errors.push({ field: `${prefix}.unitPrice`, message: 'Unit price cannot be negative' });
      }
      // Taxable line at zero rate must be explicitly zero-rated (category Z).
      if (l.taxType === 'TAXABLE' && Number(l.taxRate) <= 0 && l.taxCategory !== 'Z') {
        errors.push({
          field: `${prefix}.taxRate`,
          message: 'Taxable line has zero rate but is not marked ZERO_RATED (category Z)',
        });
      }
    });

    if (invoice.grandTotal < 0) {
      errors.push({ field: 'grandTotal', message: 'Grand total cannot be negative' });
    }

    return errors;
  }
}
