import { outboxKindForVoucher } from '../erp-sync/outbox-enqueue';
import {
  allocateFils,
  buildReturnVoucher,
  returnRep,
  returnVoucherNote,
  returnVoucherNumber,
  type ReturnSourceLine,
  type ReturnVoucherInput,
} from './delivery-return-voucher';

/** The RETURN voucher an approved delivery return becomes (pure rules). */
const line = (over: Partial<ReturnSourceLine> = {}): ReturnSourceLine => ({
  itemNumber: 'W1',
  itemName: 'Water',
  itemUnitId: null,
  approvedQty: 3,
  billedQty: 10,
  lineTotalFils: 11600,
  unitPriceFils: 1000,
  taxRate: 16,
  reasonCode: 'DAMAGED',
  ...over,
});
const input = (over: Partial<ReturnVoucherInput> = {}): ReturnVoucherInput => ({
  voucherNumber: returnVoucherNumber('CN-0007'),
  userCode: 'S1',
  customerNumber: 'C001',
  referenceVoucherNumber: null,
  inDate: new Date('2026-11-09T09:00:00Z'),
  notes: 'n',
  creditNote: { totalFils: 3480, taxFils: 480, qr: 'CNQR', jofotaraStatus: 'SUBMITTED' },
  taxMode: 'EXCLUSIVE',
  lines: [line()],
  ...over,
});
const fils = (s: string) => Math.round(Number(s) * 1000);

describe('delivery return voucher — never pushed', () => {
  it('is numbered ERP-RET-<credit note>, which no outbox path will queue', () => {
    expect(returnVoucherNumber('CN-0007')).toBe('ERP-RET-CN-0007');
    expect(outboxKindForVoucher('RETURN', returnVoucherNumber('CN-0007'))).toBeNull();
    // An ordinary return is queued, so the guard is the number, not the kind.
    expect(outboxKindForVoucher('RETURN', 'RET-S1-5')).toBe('SALES_RETURN');
  });

  it('moves no stock: no store on any line, signedQty 0', () => {
    const v = buildReturnVoucher(input())!;
    for (const l of v.lines) {
      expect(l).toMatchObject({ storeNumber: null, fromStoreNumber: null, toStoreNumber: null, signedQty: '0' });
    }
  });
});

describe('delivery return voucher — the credit note is the truth', () => {
  it('header totals are the credit note’s, to the fil; payment is one CREDIT row; JoFotara copied', () => {
    const v = buildReturnVoucher(input())!;
    expect(v.header).toMatchObject({
      voucherNumber: 'ERP-RET-CN-0007',
      transKind: 'RETURN',
      userCode: 'S1',
      customerNumber: 'C001',
      netTotal: '3.480',
      totalTax: '0.480',
      total: '3.000',
      isPosted: true,
      jofotaraQrCode: 'CNQR',
      jofotaraStatus: 'SUBMITTED',
    });
    expect(v.payment).toMatchObject({ paymentType: 'CREDIT', amount: '3.480' });
  });

  it('lines add up to the credit note exactly, even when the invoice prices would round differently', () => {
    // Three awkward lines; the ERP's credit note says 10.001 with 1.379 tax.
    const v = buildReturnVoucher(
      input({
        creditNote: { totalFils: 10001, taxFils: 1379, qr: null, jofotaraStatus: null },
        lines: [
          line({ itemNumber: 'A', approvedQty: 1, billedQty: 3, lineTotalFils: 10000, taxRate: 16 }),
          line({ itemNumber: 'B', approvedQty: 2, billedQty: 7, lineTotalFils: 9999, taxRate: 16 }),
          line({ itemNumber: 'C', approvedQty: 1.5, billedQty: 4, lineTotalFils: 7777, taxRate: 0 }),
        ],
      }),
    )!;
    const sum = (k: 'netTotal' | 'total') => v.lines.reduce((s, l) => s + fils(l[k]), 0);
    expect(sum('netTotal')).toBe(10001);
    expect(sum('netTotal') - sum('total')).toBe(1379);
    expect(fils(v.header.netTotal)).toBe(10001);
    expect(fils(v.header.totalTax)).toBe(1379);
    // The untaxed line carries no tax.
    expect(v.lines.find((l) => l.itemNumber === 'C')).toMatchObject({ taxPercentage: '0.00' });
    expect(v.lines.map((l) => l.itemQty)).toEqual(['1', '2', '1.5']);
  });

  it('a tax-free credit note (an exempt customer) has no tax on any line', () => {
    const v = buildReturnVoucher(input({ creditNote: { totalFils: 3000, taxFils: 0, qr: null, jofotaraStatus: null } }))!;
    expect(v.lines[0]).toMatchObject({ taxPercentage: '0.00', total: '3.000', netTotal: '3.000' });
    expect(v.header.totalTax).toBe('0.000');
  });

  it('the unit price follows the company tax mode', () => {
    expect(buildReturnVoucher(input())!.lines[0].unitPrice).toBe('1.000'); // 3 × 1.000 + 16%
    expect(buildReturnVoucher(input({ taxMode: 'INCLUSIVE' }))!.lines[0].unitPrice).toBe('1.160');
  });

  it('only approved lines; nothing approved → no voucher', () => {
    const v = buildReturnVoucher(input({ lines: [line(), line({ itemNumber: 'X', approvedQty: 0 })] }))!;
    expect(v.lines.map((l) => l.itemNumber)).toEqual(['W1']);
    expect(buildReturnVoucher(input({ lines: [line({ approvedQty: 0 })] }))).toBeNull();
  });

  it('allocateFils splits to whole fils that add up', () => {
    expect(allocateFils(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateFils(5, [0, 0])).toEqual([5, 0]);
    expect(allocateFils(10001, [3333.3, 2856.9, 2916.4]).reduce((a, b) => a + b, 0)).toBe(10001);
  });
});

describe('delivery return voucher — whose return it is', () => {
  const rep = (code: string, kind = 'SALES', hasLogin = true, isActive = true) => ({ id: `r-${code}`, code, kind, hasLogin, isActive });

  it('the original sale’s seller first, then the invoice’s rep, then the customer’s salesman, then the delivery rep', () => {
    const all = { saleSeller: rep('A'), invoiceRep: rep('B'), customerRep: rep('C'), deliveryRep: rep('D', 'DELIVERY') };
    expect(returnRep(all)).toMatchObject({ rep: { code: 'A' }, source: 'SALE' });
    expect(returnRep({ ...all, saleSeller: null })).toMatchObject({ rep: { code: 'B' }, source: 'INVOICE' });
    expect(returnRep({ ...all, saleSeller: null, invoiceRep: null })).toMatchObject({ rep: { code: 'C' }, source: 'CUSTOMER' });
    expect(returnRep({ deliveryRep: rep('D', 'DELIVERY') })).toMatchObject({ rep: { code: 'D' }, source: 'DELIVERY' });
  });

  it('passes over a rep without a login, and a customer rep who does not sell', () => {
    expect(returnRep({ saleSeller: rep('A', 'SALES', false), deliveryRep: rep('D', 'DELIVERY') })).toMatchObject({ source: 'DELIVERY' });
    expect(returnRep({ customerRep: rep('C', 'DELIVERY'), deliveryRep: rep('D', 'DELIVERY') })).toMatchObject({ source: 'DELIVERY' });
    expect(returnRep({ customerRep: rep('C', 'SALES', true, false), deliveryRep: rep('D', 'DELIVERY') })).toMatchObject({ source: 'DELIVERY' });
    expect(returnRep({ deliveryRep: rep('D', 'DELIVERY', false) })).toBeNull();
  });

  it('the note names the run, the invoice, the credit note, the reasons and the office note', () => {
    const n = returnVoucherNote({
      runNumber: 'DR-1',
      invoiceNumber: 'INV-9',
      creditNoteNumber: 'CN-7',
      reasons: ['DAMAGED', 'DAMAGED', 'EXPIRED'],
      officeNote: ' three damaged ',
    });
    expect(n).toContain('Delivery return — run DR-1 — invoice INV-9 — credit note CN-7');
    expect(n).toContain('مرتجع توصيل — الرحلة DR-1 — الفاتورة INV-9');
    expect(n).toContain('Reason: DAMAGED, EXPIRED');
    expect(n.endsWith('three damaged')).toBe(true);
  });
});
