import { ErpOutboxService } from './erp-outbox.service';

/**
 * A pushed receipt must name the van that took the money in.
 *
 * Without it the ERP falls back to the warehouse on whichever invoice the
 * receipt was allocated against, and a receipt allocates FIFO across the
 * customer's oldest open invoices — so the cash lands on whoever made THAT
 * sale, possibly weeks earlier and possibly a different salesman. Every van
 * then closed its day showing CASH COLLECTED 0.000 while its own report showed
 * real figures (see docs VAN-RECEIPT-COLLECTING-VAN).
 *
 * Built by hand with only the repos each builder touches — the rest of the
 * constructor args are unused here.
 *
 * Arg order: erp, settings, cashAccounts, outbox, idmap(4), headers(5),
 * lines(6), tobaccoProfiles, collections(8), customers(9), salesmanSettlements,
 * payments(11), itemUnits, stockRequests, reps(14), cheques(15).
 */
function makeSvc(mocks: Record<number, unknown>): ErpOutboxService {
  const args: unknown[] = new Array(16).fill(null);
  for (const [i, v] of Object.entries(mocks)) args[Number(i)] = v;
  return new (ErpOutboxService as unknown as new (...a: unknown[]) => ErpOutboxService)(...args);
}

const one = (row: unknown) => ({ findOne: jest.fn().mockResolvedValue(row) });

describe('buildPayment — the collecting van rides the receipt', () => {
  const collection = {
    id: 'col-1',
    customerId: 'cust-1',
    repId: 'rep-1',
    amount: 25_000,          // fils
    method: 'cash',
    note: null,
  };
  const customer = { id: 'cust-1', customerNumber: '463' };

  const build = (rep: unknown) =>
    (
      makeSvc({
        4: one(null),                       // idmap — no ERP uuid, falls back to code
        8: one(collection),                 // collections
        9: one(customer),                   // customers
        14: one(rep),                       // reps
      }) as unknown as { buildPayment(id: string): Promise<{ body: Record<string, unknown> }> }
    ).buildPayment('col-1');

  it('sends warehouseCode — the rep code IS the ERP warehouse code', async () => {
    const out = await build({ id: 'rep-1', code: '203' });
    expect(out.body.warehouseCode).toBe('203');
    // …and salesmanCode, the ERP's preferred route: warehouseCode says which
    // cash box, salesmanCode says who carried the money. Same string, because
    // van 203 and salesman 203 are one identity on this deployment.
    expect(out.body.salesmanCode).toBe('203');
    // and nothing else about the call changed
    expect(out.body).toMatchObject({
      externalId: 'col-1',
      customerCode: '463',
      amount: 25,
      paymentMethod: 'CASH',
    });
  });

  it('a cheque collection carries the van too', async () => {
    const svc = makeSvc({
      4: one(null),
      8: one({ ...collection, method: 'cheque' }),
      9: one(customer),
      14: one({ id: 'rep-1', code: '106' }),
      // A cheque receipt now reads its cheque rows to identify the cheque.
      15: { find: jest.fn().mockResolvedValue([{ chequeNumber: 'X', dueDate: '2026-11-01' }]) },
    }) as unknown as { buildPayment(id: string): Promise<{ body: Record<string, unknown> }> };
    const out = await svc.buildPayment('col-1');
    expect(out.body).toMatchObject({
      paymentMethod: 'CHECK', warehouseCode: '106', salesmanCode: '106',
    });
  });

  it('omits the field rather than sending null when the rep has no code', async () => {
    // The ERP REFUSES a named warehouse it cannot resolve (404). Sending an empty
    // value to be "explicit" would turn a good collection into a failed push; the
    // documented fallback for an absent field is the old behaviour, which is
    // exactly what we want here.
    const out = await build({ id: 'rep-1', code: null });
    expect('warehouseCode' in out.body).toBe(false);
    // salesmanCode is refused HARDER than a warehouse — the ERP 404s an
    // unknown one — so a rep with no code must send no salesman either.
    expect('salesmanCode' in out.body).toBe(false);
  });

  it('omits the field when the collection names no rep', async () => {
    const svc = makeSvc({
      4: one(null),
      8: one({ ...collection, repId: null }),
      9: one(customer),
      14: one(null),
    }) as unknown as { buildPayment(id: string): Promise<{ body: Record<string, unknown> }> };
    const out = await svc.buildPayment('col-1');
    expect('warehouseCode' in out.body).toBe(false);
    expect('salesmanCode' in out.body).toBe(false);
  });
});

/**
 * A CHECK receipt has to identify the cheque.
 *
 * The ERP used to accept one that did not, and the result was a voucher naming
 * a cheque nobody could find: no Financial Paper, and no way to post it, because
 * posting builds the paper out of the number and the due date. It now returns
 * 400 instead, so a receipt that omits them never completes at all.
 */
describe('buildPayment — a cheque receipt identifies the cheque', () => {
  const customer = { id: 'cust-1', customerNumber: '463', customerName: 'أسواق الراعي' };
  const chequeCollection = {
    id: 'col-1', customerId: 'cust-1', repId: 'rep-1',
    amount: 25_000, method: 'cheque', note: null,
  };

  const build = (cheques: unknown[], col: unknown = chequeCollection) =>
    (
      makeSvc({
        4: one(null),
        8: one(col),
        9: one(customer),
        14: one({ id: 'rep-1', code: '203' }),
        15: { find: jest.fn().mockResolvedValue(cheques) },
      }) as unknown as { buildPayment(id: string): Promise<{ body: Record<string, unknown> }> }
    ).buildPayment('col-1');

  it('sends the number, due date, bank and drawer', async () => {
    const out = await build([
      { chequeNumber: '556677', dueDate: '2026-11-01', bankName: 'Housing Bank' },
    ]);
    expect(out.body).toMatchObject({
      paymentMethod: 'CHECK',
      checkNumber: '556677',
      checkDueDate: '2026-11-01',
      checkBankName: 'Housing Bank',
      // The DRAWER is the customer who wrote it — payee is us.
      checkDrawerName: 'أسواق الراعي',
    });
  });

  it('trims a due date that arrives as a timestamp', async () => {
    // `date` columns can come back as a Date or a longer string depending on
    // the driver; the ERP wants YYYY-MM-DD.
    const out = await build([{ chequeNumber: 'A', dueDate: '2026-11-01T00:00:00.000Z' }]);
    expect(out.body.checkDueDate).toBe('2026-11-01');
  });

  it('omits a blank number rather than sending whitespace', async () => {
    // The ERP counts whitespace as missing, so sending it only makes its own
    // error message less accurate.
    const out = await build([{ chequeNumber: '   ', dueDate: '2026-11-01' }]);
    expect('checkNumber' in out.body).toBe(false);
    expect(out.body.checkDueDate).toBe('2026-11-01');
  });

  it('sends no cheque fields at all on a cash collection', async () => {
    const out = await build([], { ...chequeCollection, method: 'cash' });
    expect(out.body.paymentMethod).toBe('CASH');
    for (const k of ['checkNumber', 'checkDueDate', 'checkBankName', 'checkDrawerName']) {
      expect(k in out.body).toBe(false);
    }
  });
});
