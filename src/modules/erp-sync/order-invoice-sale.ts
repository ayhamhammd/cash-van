/**
 * The SALE a salesman's ORDER became, once the office invoiced it in the ERP.
 *
 * A pre-seller does not sell from the van: he raises an ORDER, cash-van pushes
 * it to the ERP as a sales order, and the office generates the invoice there.
 * Until now that invoice reached cash-van only as a mirrored office invoice
 * (erp_invoices), credited to whoever the customer is assigned to and with no
 * voucher behind it. The salesman who took the order had no sale to return
 * against, and a sale that was his counted for someone else.
 *
 * This shapes the ERP invoice into the SALE voucher he would have written
 * himself, so it lists among his sales and a RETURN can reference it. Pure: the
 * caller resolves SKUs and does the writing.
 *
 * Three rules hold the rest of the system steady:
 *
 *  - The number starts `ERP-`. The outbox sweep resends any posted SALE it has
 *    no row for unless its number starts `ERP-`, and resending this one would
 *    raise a second invoice for the same goods.
 *  - No line names a from/to store, so van stock does not move. The ERP shipped
 *    these goods from its own warehouse (a van order carries none). Each line
 *    still names the van in `storeNumber`, which is where a RETURN against it
 *    puts the goods back.
 *  - The ORDER itself never counted toward a target, and the invoice is no
 *    longer mirrored as an office invoice, so the sale counts once — for the
 *    salesman who took the order.
 */

export interface ErpInvoiceDetail {
  id: string;
  invoiceNumber?: string | null;
  status?: string | null;
  issuedAt?: string | null;
  paymentType?: string | null;
  totalAmount?: number | string | null;
  totalTax?: number | string | null;
  totalDiscount?: number | string | null;
  items?: Array<{
    skuCode?: string | null;
    productName?: string | null;
    quantityBilled?: number | string | null;
    sellingPrice?: number | string | null;
    discountAmount?: number | string | null;
    taxAmount?: number | string | null;
    lineTotal?: number | string | null;
  }> | null;
}

export interface OrderRef {
  voucherNumber: string;
  userCode: string;
  customerNumber?: string | null;
  isTaxExempt: boolean;
  taxExemptionSource: 'CUSTOMER' | 'MANUAL' | 'NONE';
  taxExemptionNumber?: string | null;
  taxExemptionReason?: string | null;
  taxExemptionType?: string | null;
  notes?: string | null;
}

export interface ResolvedItem {
  itemNumber: string;
  itemName: string;
  itemUnitId: string | null;
}

export interface OrderSale {
  header: {
    voucherNumber: string;
    transKind: 'SALE';
    userCode: string;
    customerNumber: string | null;
    referenceVoucherNumber: string;
    inDate: Date;
    total: string;
    totalTax: string;
    netTotal: string;
    totalDiscountValue: string;
    totalDiscountPercentage: string;
    appliedOfferIds: string[];
    notes: string | null;
    isPosted: true;
    isEdit: false;
    isTaxExempt: boolean;
    taxExemptionSource: 'CUSTOMER' | 'MANUAL' | 'NONE';
    taxExemptionNumber: string | null;
    taxExemptionReason: string | null;
    taxExemptionType: string | null;
  };
  lines: Array<{
    voucherNumber: string;
    itemNumber: string;
    itemName: string;
    transKind: 'SALE';
    storeNumber: string | null;
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
  payment: { voucherNumber: string; amount: string; paymentType: 'CASH' | 'CREDIT'; paymentDate: Date };
  unresolvedSkus: string[];
}

export const orderSaleNumber = (invoiceNumber: string): string => `ERP-${invoiceNumber}`;

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const money = (v: number): string => (Math.round(v * 1000) / 1000).toFixed(3);

export function buildOrderSale(
  invoice: ErpInvoiceDetail,
  order: OrderRef,
  vanStore: string | null,
  resolve: (skuCode: string) => ResolvedItem | null,
): OrderSale | null {
  if (!invoice.invoiceNumber) return null;
  const issued = invoice.issuedAt ? new Date(invoice.issuedAt) : null;
  if (!issued || Number.isNaN(issued.getTime())) return null;

  const voucherNumber = orderSaleNumber(invoice.invoiceNumber);
  const unresolvedSkus: string[] = [];
  const lines: OrderSale['lines'] = [];

  for (const item of invoice.items ?? []) {
    const sku = item.skuCode ?? '';
    const resolved = sku ? resolve(sku) : null;
    if (!resolved) {
      unresolvedSkus.push(sku || '(no sku)');
      continue;
    }
    const qty = num(item.quantityBilled);
    if (qty <= 0) continue;
    const lineTotal = num(item.lineTotal);
    const tax = num(item.taxAmount);
    const net = lineTotal - tax;
    const rate = net > 0 && tax > 0 ? Math.round((tax / net) * 10000) / 100 : 0;
    lines.push({
      voucherNumber,
      itemNumber: resolved.itemNumber,
      itemName: resolved.itemName || item.productName || resolved.itemNumber,
      transKind: 'SALE',
      storeNumber: vanStore,
      fromStoreNumber: null,
      toStoreNumber: null,
      itemQty: String(qty),
      qtyOfUnit: String(qty),
      unitBaseQty: 1,
      stockUnitCode: '',
      itemUnitId: resolved.itemUnitId,
      unitPrice: money(num(item.sellingPrice)),
      taxPercentage: rate.toFixed(2),
      discountPercentage: '0',
      discountValue: money(num(item.discountAmount)),
      total: money(net),
      netTotal: money(lineTotal),
      signedQty: String(-qty),
      realDate: issued,
    });
  }

  const totalAmount = num(invoice.totalAmount);
  const totalTax = num(invoice.totalTax);
  return {
    header: {
      voucherNumber,
      transKind: 'SALE',
      userCode: order.userCode,
      customerNumber: order.customerNumber ?? null,
      referenceVoucherNumber: order.voucherNumber,
      inDate: issued,
      total: money(totalAmount - totalTax),
      totalTax: money(totalTax),
      netTotal: money(totalAmount),
      totalDiscountValue: money(num(invoice.totalDiscount)),
      totalDiscountPercentage: '0',
      appliedOfferIds: [],
      notes: order.notes ?? null,
      isPosted: true,
      isEdit: false,
      isTaxExempt: order.isTaxExempt,
      taxExemptionSource: order.taxExemptionSource,
      taxExemptionNumber: order.taxExemptionNumber ?? null,
      taxExemptionReason: order.taxExemptionReason ?? null,
      taxExemptionType: order.taxExemptionType ?? null,
    },
    lines,
    payment: {
      voucherNumber,
      amount: money(totalAmount),
      paymentType: (invoice.paymentType ?? '').toUpperCase() === 'CASH' ? 'CASH' : 'CREDIT',
      paymentDate: issued,
    },
    unresolvedSkus,
  };
}
