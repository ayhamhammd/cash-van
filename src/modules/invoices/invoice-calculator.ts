import { roundFils } from '../../common/utils/currency.util';
import type { TaxType } from '../items/entities/item-cart.entity';

export type DiscountType = 'PERCENTAGE' | 'FIXED_AMOUNT';

export interface CalcLineInput {
  quantity: number;
  unitPrice: number; // fils
  taxType: TaxType;
  taxRate: number; // decimal, e.g. 0.16
  lineDiscountType?: DiscountType;
  lineDiscountValue?: number; // pct (0-100) or fils
}

export interface CalcLineResult {
  subtotal: number; // qty * unitPrice (fils)
  lineDiscountAmount: number; // line-level only (fils)
  netAfterLineDiscount: number; // subtotal - line discount (before invoice discount)
  invoiceDiscountShare: number; // proportional invoice-level discount applied to this line
  finalNet: number; // netAfterLineDiscount - invoiceDiscountShare
  taxableBase: number; // 0 EXEMPT; finalNet TAXABLE; finalNet - extracted INCLUSIVE
  taxAmount: number;
  lineTotal: number; // TAXABLE: finalNet + tax; INCLUSIVE/EXEMPT: finalNet
}

export interface InvoiceCalcInput {
  lines: CalcLineInput[];
  invoiceDiscountType?: DiscountType;
  invoiceDiscountValue?: number;
}

export interface InvoiceCalcResult {
  lines: CalcLineResult[];
  subtotal: number;
  totalLineDiscounts: number;
  invoiceDiscountAmount: number;
  netTaxable: number;
  netInclusive: number;
  netExempt: number;
  taxOnTaxable: number;
  taxExtractedFromInclusive: number;
  totalTax: number;
  grandTotal: number;
}

function computeDiscount(base: number, type: DiscountType, value: number): number {
  if (value <= 0) return 0;
  const raw = type === 'PERCENTAGE' ? base * (value / 100) : value;
  return Math.min(roundFils(raw), base); // clamp to base, never negative
}

/**
 * Fils-based port of Jordan_Tax_JoFotara_NodeJS_Spec.md §5.
 *
 * Differences vs the spec (intentional, for integer consistency):
 *  - All money is INTEGER fils; rounding is half-up via roundFils.
 *  - The invoice-level discount is distributed proportionally INTO each line
 *    (by net share) and tax is computed on the post-distribution net, so the
 *    per-line tax always sums exactly to the invoice tax (no spec drift).
 *  - The remainder from proportional rounding is absorbed by the last
 *    discounted line so Σ shares == invoiceDiscountAmount exactly.
 */
export function calculateInvoice(input: InvoiceCalcInput): InvoiceCalcResult {
  const lines = input.lines.map((item) => {
    const subtotal = roundFils(item.quantity * item.unitPrice);
    const lineDiscountAmount = computeDiscount(
      subtotal,
      item.lineDiscountType ?? 'PERCENTAGE',
      item.lineDiscountValue ?? 0,
    );
    const netAfterLineDiscount = subtotal - lineDiscountAmount;
    return {
      item,
      subtotal,
      lineDiscountAmount,
      netAfterLineDiscount,
      invoiceDiscountShare: 0,
      finalNet: netAfterLineDiscount,
      taxableBase: 0,
      taxAmount: 0,
      lineTotal: 0,
    };
  });

  const sumLineNet = lines.reduce((a, l) => a + l.netAfterLineDiscount, 0);

  // Invoice-level discount, distributed proportionally by net share.
  const invoiceDiscountAmount = computeDiscount(
    sumLineNet,
    input.invoiceDiscountType ?? 'PERCENTAGE',
    input.invoiceDiscountValue ?? 0,
  );
  if (invoiceDiscountAmount > 0 && sumLineNet > 0) {
    let distributed = 0;
    lines.forEach((l, idx) => {
      const isLast = idx === lines.length - 1;
      const share = isLast
        ? invoiceDiscountAmount - distributed
        : roundFils((invoiceDiscountAmount * l.netAfterLineDiscount) / sumLineNet);
      l.invoiceDiscountShare = share;
      distributed += share;
    });
  }

  // Per-line final net + tax by type.
  for (const l of lines) {
    l.finalNet = l.netAfterLineDiscount - l.invoiceDiscountShare;
    const rate = l.item.taxRate;
    switch (l.item.taxType) {
      case 'TAXABLE': {
        const tax = roundFils(l.finalNet * rate);
        l.taxableBase = l.finalNet;
        l.taxAmount = tax;
        l.lineTotal = l.finalNet + tax;
        break;
      }
      case 'INCLUSIVE': {
        const tax = roundFils(l.finalNet * (rate / (1 + rate)));
        l.taxableBase = l.finalNet - tax;
        l.taxAmount = tax;
        l.lineTotal = l.finalNet; // tax already inside
        break;
      }
      case 'EXEMPT':
      default: {
        l.taxableBase = 0;
        l.taxAmount = 0;
        l.lineTotal = l.finalNet;
        break;
      }
    }
  }

  const byType = (t: TaxType) => lines.filter((l) => l.item.taxType === t);
  const sum = (arr: typeof lines, fn: (l: (typeof lines)[number]) => number) =>
    arr.reduce((a, l) => a + fn(l), 0);

  const netTaxable = sum(byType('TAXABLE'), (l) => l.finalNet);
  const netInclusive = sum(byType('INCLUSIVE'), (l) => l.finalNet);
  const netExempt = sum(byType('EXEMPT'), (l) => l.finalNet);
  const taxOnTaxable = sum(byType('TAXABLE'), (l) => l.taxAmount);
  const taxExtractedFromInclusive = sum(byType('INCLUSIVE'), (l) => l.taxAmount);
  const totalTax = taxOnTaxable + taxExtractedFromInclusive;
  const grandTotal = sum(lines, (l) => l.lineTotal);

  return {
    lines: lines.map((l) => ({
      subtotal: l.subtotal,
      lineDiscountAmount: l.lineDiscountAmount,
      netAfterLineDiscount: l.netAfterLineDiscount,
      invoiceDiscountShare: l.invoiceDiscountShare,
      finalNet: l.finalNet,
      taxableBase: l.taxableBase,
      taxAmount: l.taxAmount,
      lineTotal: l.lineTotal,
    })),
    subtotal: sum(lines, (l) => l.subtotal),
    totalLineDiscounts: sum(lines, (l) => l.lineDiscountAmount),
    invoiceDiscountAmount,
    netTaxable,
    netInclusive,
    netExempt,
    taxOnTaxable,
    taxExtractedFromInclusive,
    totalTax,
    grandTotal,
  };
}
