import { ErpOutboxService } from './erp-outbox.service';

/**
 * Unit tests for the cash-vs-credit classification a van SALE carries when pushed
 * to the ERP, and the Phase-2 split-sale companion receipt
 * (docs/SPEC-cash-sale-erp-export.md). The service is built by hand with only the
 * repos each method touches mocked — the rest of the constructor args are unused.
 */

type Row = { voucherNumber: string; amount: string; paymentType: string };

// Constructor arg order: erp, settings, cashAccounts, outbox, idmap(4), headers(5),
// lines, tobaccoProfiles, collections, customers, salesmanSettlements, payments(11).
function makeSvc(mocks: { payments?: any; headers?: any; idmap?: any } = {}) {
  const args: any[] = new Array(12).fill(null);
  args[4] = mocks.idmap ?? null;
  args[5] = mocks.headers ?? null;
  args[11] = mocks.payments ?? null;
  return new (ErpOutboxService as any)(...args) as ErpOutboxService;
}

const pay = (paymentType: string, amount = '10.000'): Row => ({
  voucherNumber: 'S-1',
  amount,
  paymentType,
});

const paymentsRepo = (rows: Row[]) => ({ find: jest.fn().mockResolvedValue(rows) });

describe('ErpOutboxService.salePaymentFields (invoice payment classification)', () => {
  const run = (rows: Row[]) =>
    (makeSvc({ payments: paymentsRepo(rows) }) as any).salePaymentFields('S-1') as Promise<{
      paymentMethod?: string;
      paymentType: 'CASH' | 'CREDIT';
    }>;

  it('CASH sale → paid, paymentMethod CASH', async () => {
    expect(await run([pay('CASH')])).toEqual({ paymentMethod: 'CASH', paymentType: 'CASH' });
  });

  it('CHEQUE sale → paid, mapped to CHECK (cheque = paid — Phase 1 decision)', async () => {
    expect(await run([pay('CHEQUE')])).toEqual({ paymentMethod: 'CHECK', paymentType: 'CASH' });
  });

  it('CARD sale → paid, paymentMethod CARD', async () => {
    expect(await run([pay('CARD')])).toEqual({ paymentMethod: 'CARD', paymentType: 'CASH' });
  });

  it('TRANSFER sale → paid, mapped to BANK_TRANSFER', async () => {
    expect(await run([pay('TRANSFER')])).toEqual({
      paymentMethod: 'BANK_TRANSFER',
      paymentType: 'CASH',
    });
  });

  it('CREDIT sale → on-account, no paymentMethod', async () => {
    expect(await run([pay('CREDIT')])).toEqual({ paymentType: 'CREDIT' });
  });

  it('no payment rows → on-account (safe default, no regression)', async () => {
    expect(await run([])).toEqual({ paymentType: 'CREDIT' });
  });

  it('split cash + credit → invoice booked as CREDIT (paid part handled by a receipt)', async () => {
    expect(await run([pay('CASH', '5.000'), pay('CREDIT', '5.000')])).toEqual({
      paymentType: 'CREDIT',
    });
  });

  it('fully paid by mixed methods → picks the dominant (higher value) method', async () => {
    expect(await run([pay('CASH', '10.000'), pay('CARD', '30.000')])).toEqual({
      paymentMethod: 'CARD',
      paymentType: 'CASH',
    });
  });
});

describe('ErpOutboxService.splitPaidPortion', () => {
  const run = (rows: Row[]) =>
    (makeSvc({ payments: paymentsRepo(rows) }) as any).splitPaidPortion('S-1') as Promise<{
      amount: number;
      paymentMethod: string;
    } | null>;

  it('split CASH 60 + CREDIT 40 → paid portion 60 CASH', async () => {
    expect(await run([pay('CASH', '60.000'), pay('CREDIT', '40.000')])).toEqual({
      amount: 60,
      paymentMethod: 'CASH',
    });
  });

  it('split CHEQUE 30 + CREDIT 70 → 30 CHECK', async () => {
    expect(await run([pay('CHEQUE', '30.000'), pay('CREDIT', '70.000')])).toEqual({
      amount: 30,
      paymentMethod: 'CHECK',
    });
  });

  it('split with mixed paid methods → sums paid, dominant method', async () => {
    expect(
      await run([pay('CASH', '20.000'), pay('CARD', '40.000'), pay('CREDIT', '40.000')]),
    ).toEqual({ amount: 60, paymentMethod: 'CARD' });
  });

  it('fully paid (no credit row) → null (settled on the invoice, no receipt)', async () => {
    expect(await run([pay('CASH', '100.000')])).toBeNull();
  });

  it('fully credit → null', async () => {
    expect(await run([pay('CREDIT', '100.000')])).toBeNull();
  });

  it('no payments → null', async () => {
    expect(await run([])).toBeNull();
  });
});

describe('ErpOutboxService.buildSplitReceipt', () => {
  function build(opts: { rows: Row[]; erpInvoiceNumber?: string | null; customerNumber?: string }) {
    const idmap = {
      findOne: jest.fn(({ where }: any) => {
        if (where.entity === 'customer') return Promise.resolve(null); // → customerCode fallback
        if (where.entity === 'voucher') {
          return Promise.resolve(opts.erpInvoiceNumber ? { erpCode: opts.erpInvoiceNumber } : null);
        }
        return Promise.resolve(null);
      }),
    };
    const headers = {
      findOne: jest.fn().mockResolvedValue({ customerNumber: opts.customerNumber ?? 'C-1' }),
    };
    const svc = makeSvc({ payments: paymentsRepo(opts.rows), headers, idmap });
    return (svc as any).buildSplitReceipt('S-1') as Promise<any>;
  }

  it('builds a receipt for the paid part, allocated to the ERP invoice, with its own idem', async () => {
    const call = await build({
      rows: [pay('CASH', '60.000'), pay('CREDIT', '40.000')],
      erpInvoiceNumber: 'INV-500',
    });
    expect(call).toEqual({
      path: 'receipts',
      idem: 'S-1-PAY',
      body: {
        externalId: 'S-1-PAY',
        customerCode: 'C-1',
        amount: 60,
        paymentMethod: 'CASH',
        invoiceNumber: 'INV-500',
      },
    });
  });

  it('omits invoiceNumber when the sale is not yet id-mapped (on-account FIFO fallback)', async () => {
    const call = await build({
      rows: [pay('CASH', '60.000'), pay('CREDIT', '40.000')],
      erpInvoiceNumber: null,
    });
    expect(call.body).not.toHaveProperty('invoiceNumber');
    expect(call.body).toMatchObject({ externalId: 'S-1-PAY', amount: 60, paymentMethod: 'CASH' });
  });

  it('returns null when the sale is not a split (nothing to receipt)', async () => {
    expect(await build({ rows: [pay('CASH', '100.000')], erpInvoiceNumber: 'INV-1' })).toBeNull();
  });
});
