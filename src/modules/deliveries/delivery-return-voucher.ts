/**
 * The CashVan RETURN voucher an approved delivery return becomes. Pure: the
 * service resolves the items, the rep and the reference, and does the writing.
 *
 * The ERP already holds the return — the credit note its approval issued. This
 * voucher is CashVan's own record of the same document, so the return shows in
 * the vouchers list and in the original salesman's returns. Rules that keep it
 * from counting twice anywhere:
 *
 *  - The number is `ERP-RET-<credit note number>`. Every path that pushes a
 *    voucher to the ERP skips `ERP-` numbers (the outbox sweep, the pending
 *    export list and its "export all", the single export button, and
 *    outboxKindForVoucher in the vouchers path), so it can never become a
 *    second sales-return there. `RET-` keeps it apart from the `ERP-<invoice>`
 *    SALEs mirrored from invoiced orders.
 *  - No line names a from/to store and signedQty is 0, so neither the stock
 *    ledger trigger nor any van moves: the ERP already put the goods back in
 *    its own warehouses.
 *  - The totals ARE the credit note's (fils), not a recompute. Lines are priced
 *    from the invoice (line total, tax included, prorated over the billed
 *    quantity — as the ERP prices a return) and then allocated so they add up to
 *    the credit note exactly.
 *  - Payment is one CREDIT row: a return is the customer's credit, never cash.
 */

export const RETURN_VOUCHER_PREFIX = 'ERP-RET-';

export const returnVoucherNumber = (creditNoteNumber: string): string =>
  `${RETURN_VOUCHER_PREFIX}${creditNoteNumber}`;

export interface ReturnSourceLine {
  itemNumber: string;
  itemName: string;
  itemUnitId: string | null;
  approvedQty: number;
  /** The invoice line's billed quantity — what lineTotalFils is the price of. */
  billedQty: number;
  /** The invoice line's total, tax included. */
  lineTotalFils: number;
  /** Fallback price when no line total was mirrored. */
  unitPriceFils: number;
  /** Percent, e.g. 16. */
  taxRate: number;
  reasonCode: string | null;
}

export interface ReturnVoucherInput {
  voucherNumber: string;
  userCode: string;
  customerNumber: string;
  referenceVoucherNumber: string | null;
  inDate: Date;
  notes: string;
  creditNote: { totalFils: number; taxFils: number; qr: string | null; jofotaraStatus: string | null };
  taxMode: 'INCLUSIVE' | 'EXCLUSIVE';
  lines: ReturnSourceLine[];
}

export interface ReturnVoucher {
  header: {
    voucherNumber: string;
    transKind: 'RETURN';
    userCode: string;
    customerNumber: string;
    referenceVoucherNumber: string | null;
    inDate: Date;
    total: string;
    totalTax: string;
    netTotal: string;
    totalDiscountValue: string;
    totalDiscountPercentage: string;
    appliedOfferIds: string[];
    notes: string;
    isPosted: true;
    isEdit: false;
    jofotaraQrCode: string | null;
    jofotaraStatus: string | null;
  };
  lines: Array<{
    voucherNumber: string;
    itemNumber: string;
    itemName: string;
    transKind: 'RETURN';
    storeNumber: null;
    fromStoreNumber: null;
    toStoreNumber: null;
    itemQty: string;
    qtyOfUnit: string;
    unitBaseQty: number;
    stockUnitCode: string;
    itemUnitId: string | null;
    unitPrice: string;
    taxPercentage: string;
    discountPercentage: string;
    discountValue: string;
    total: string;
    netTotal: string;
    signedQty: string;
    realDate: Date;
  }>;
  payment: { voucherNumber: string; amount: string; paymentType: 'CREDIT'; paymentDate: Date };
}

const jod = (fils: number): string => (fils / 1000).toFixed(3);

/**
 * Split `total` (integer fils) over `weights` so the parts are integers that add
 * up to it exactly: floor each share, then hand the leftover fils to the largest
 * remainders. An all-zero weighting puts it all on the first part.
 */
export function allocateFils(total: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const raw = weights.map((w) => (Math.max(0, w) / sum) * total);
  const out = raw.map((r) => Math.floor(r));
  let left = total - out.reduce((s, v) => s + v, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left -= 1) out[order[k].i] += 1;
  return out;
}

/** Build the voucher. Null when nothing was approved back. */
export function buildReturnVoucher(input: ReturnVoucherInput): ReturnVoucher | null {
  const lines = input.lines.filter((l) => l.approvedQty > 0);
  if (!lines.length) return null;
  const cnTotal = Math.round(input.creditNote.totalFils);
  const cnTax = Math.min(Math.round(input.creditNote.taxFils), cnTotal);

  // As the invoice priced each line, tax included…
  const priced = lines.map((l) =>
    l.billedQty > 0 && l.lineTotalFils > 0
      ? (l.lineTotalFils * l.approvedQty) / l.billedQty
      : l.unitPriceFils * l.approvedQty * (1 + l.taxRate / 100),
  );
  // …then made to add up to the credit note, which is the truth.
  const gross = allocateFils(cnTotal, priced);
  const taxShare = gross.map((g, i) => (lines[i].taxRate > 0 ? (g * lines[i].taxRate) / (100 + lines[i].taxRate) : 0));
  const tax = cnTax > 0 ? allocateFils(cnTax, taxShare).map((t, i) => Math.min(t, gross[i])) : gross.map(() => 0);
  // A min() above can only have taken fils off; put any back on the largest line.
  const taxGap = cnTax - tax.reduce((s, t) => s + t, 0);
  if (taxGap > 0) {
    const big = gross.indexOf(Math.max(...gross));
    tax[big] += taxGap;
  }

  const voucherNumber = input.voucherNumber;
  const date = input.inDate;
  return {
    header: {
      voucherNumber,
      transKind: 'RETURN',
      userCode: input.userCode,
      customerNumber: input.customerNumber,
      referenceVoucherNumber: input.referenceVoucherNumber,
      inDate: date,
      total: jod(cnTotal - cnTax),
      totalTax: jod(cnTax),
      netTotal: jod(cnTotal),
      totalDiscountValue: '0.000',
      totalDiscountPercentage: '0',
      appliedOfferIds: [],
      notes: input.notes,
      isPosted: true,
      isEdit: false,
      jofotaraQrCode: input.creditNote.qr,
      jofotaraStatus: input.creditNote.jofotaraStatus,
    },
    lines: lines.map((l, i) => {
      const net = gross[i] - tax[i];
      const perUnit = (input.taxMode === 'INCLUSIVE' ? gross[i] : net) / l.approvedQty;
      return {
        voucherNumber,
        itemNumber: l.itemNumber,
        itemName: l.itemName,
        transKind: 'RETURN',
        storeNumber: null,
        fromStoreNumber: null,
        toStoreNumber: null,
        itemQty: String(l.approvedQty),
        qtyOfUnit: String(l.approvedQty),
        unitBaseQty: 1,
        stockUnitCode: '',
        itemUnitId: l.itemUnitId,
        unitPrice: (perUnit / 1000).toFixed(3),
        taxPercentage: (tax[i] > 0 ? l.taxRate : 0).toFixed(2),
        discountPercentage: '0',
        discountValue: '0.000',
        total: jod(net),
        netTotal: jod(gross[i]),
        signedQty: '0',
        realDate: date,
      };
    }),
    payment: { voucherNumber, amount: jod(cnTotal), paymentType: 'CREDIT', paymentDate: date },
  };
}

/** A rep who may own a voucher: he has a code, and the code is a login (user_code → users). */
export interface RepCandidate {
  id: string;
  code: string | null;
  kind: string;
  hasLogin: boolean;
  isActive?: boolean;
}

/**
 * Whose return it is: the ORIGINAL SALESMAN, so it comes off the seller's net
 * sales. In order —
 *  1. the seller of the CashVan sale voucher the invoice came from;
 *  2. the rep the ERP invoice is credited to (the invoice mirror);
 *  3. the customer's own salesman (SALES or BOTH), as an increase order does;
 *  4. the delivery rep who drove the run.
 * A candidate without a code or a login is passed over.
 */
export function returnRep(c: {
  saleSeller?: RepCandidate | null;
  invoiceRep?: RepCandidate | null;
  customerRep?: RepCandidate | null;
  deliveryRep?: RepCandidate | null;
}): { rep: RepCandidate; source: 'SALE' | 'INVOICE' | 'CUSTOMER' | 'DELIVERY' } | null {
  const ok = (r?: RepCandidate | null): r is RepCandidate => !!r && !!r.code && r.hasLogin;
  if (ok(c.saleSeller)) return { rep: c.saleSeller, source: 'SALE' };
  if (ok(c.invoiceRep)) return { rep: c.invoiceRep, source: 'INVOICE' };
  if (ok(c.customerRep) && (c.customerRep.kind === 'SALES' || c.customerRep.kind === 'BOTH') && c.customerRep.isActive !== false) {
    return { rep: c.customerRep, source: 'CUSTOMER' };
  }
  if (ok(c.deliveryRep)) return { rep: c.deliveryRep, source: 'DELIVERY' };
  return null;
}

/** The note the voucher carries: where it came from, why, and the office's word (ar / en). */
export function returnVoucherNote(p: {
  runNumber: string | null;
  invoiceNumber: string | null;
  creditNoteNumber: string;
  reasons: string[];
  officeNote: string | null;
}): string {
  const run = p.runNumber ?? '';
  const inv = p.invoiceNumber ?? '';
  const parts = [
    `مرتجع توصيل — الرحلة ${run} — الفاتورة ${inv} — إشعار دائن ${p.creditNoteNumber}`,
    `Delivery return — run ${run} — invoice ${inv} — credit note ${p.creditNoteNumber}`,
  ];
  if (p.reasons.length) parts.push(`Reason: ${[...new Set(p.reasons)].join(', ')}`);
  if (p.officeNote?.trim()) parts.push(p.officeNote.trim());
  return parts.join('\n');
}
