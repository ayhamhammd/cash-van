import { ErpOutboxService, TerminalPayloadError } from './erp-outbox.service';

/**
 * A cheque the ERP cannot identify fails ONCE, loudly, and waits for the office.
 *
 * The handsets send a cheque number and no due date — every cheque on record is
 * shaped that way — and the ERP refuses a CHECK receipt that carries only half
 * its identity. Nothing about that resolves itself: the date is printed on a
 * piece of paper in a van, and it reaches the system when somebody in the office
 * keys it in.
 *
 * So this must NOT ride the retry budget. Six attempts on a growing backoff end
 * in the same dead-letter, hours later, with the same message nobody saw. The
 * message is the point — it names the missing field and where to supply it.
 *
 * Arg order as in erp-outbox.collectingVan.spec.ts: collections(8),
 * customers(9), reps(14), cheques(15).
 */
function makeSvc(mocks: Record<number, unknown>): ErpOutboxService {
  const args: unknown[] = new Array(16).fill(null);
  for (const [i, v] of Object.entries(mocks)) args[Number(i)] = v;
  return new (ErpOutboxService as unknown as new (...a: unknown[]) => ErpOutboxService)(...args);
}

const one = (row: unknown) => ({ findOne: jest.fn().mockResolvedValue(row) });

describe('buildPayment — a cheque that cannot identify itself', () => {
  const collection = {
    id: 'col-1',
    collectionNumber: 'C-203-000024',
    customerId: 'cust-1',
    repId: 'rep-1',
    amount: 614_235,
    method: 'cheque',
    note: null,
  };
  const customer = { id: 'cust-1', customerNumber: '463', customerName: 'الشروق' };

  const build = (chequeRows: unknown[]) =>
    (
      makeSvc({
        4: one(null),
        8: one(collection),
        9: one(customer),
        14: one({ id: 'rep-1', code: '203' }),
        15: { find: jest.fn().mockResolvedValue(chequeRows) },
      }) as unknown as { buildPayment(id: string): Promise<{ body: Record<string, unknown> }> }
    ).buildPayment('col-1');

  it('dead-letters rather than retries when the due date is missing', async () => {
    // The real shape of all 16 cheques on the 94 client: numbered, undated.
    await expect(build([{ chequeNumber: '4893', dueDate: null }])).rejects.toBeInstanceOf(
      TerminalPayloadError,
    );
  });

  it('names the missing field and where to fix it', async () => {
    // What the office reads in GET /erp/outbox?status=dead_letter. "Bad request"
    // would send them to the logs; this sends them to the cheque.
    await expect(build([{ chequeNumber: '4893', dueDate: null }])).rejects.toThrow(
      /due date/,
    );
    await expect(build([{ chequeNumber: '4893', dueDate: null }])).rejects.toThrow(
      /C-203-000024/,
    );
    await expect(build([{ chequeNumber: '4893', dueDate: null }])).rejects.toThrow(
      /cheques\/:id\/details/,
    );
  });

  it('names BOTH fields when neither is present', async () => {
    await expect(build([{ chequeNumber: null, dueDate: null }])).rejects.toThrow(
      /cheque number and due date/,
    );
  });

  it('treats a whitespace-only number as missing', async () => {
    await expect(build([{ chequeNumber: '   ', dueDate: '2026-11-01' }])).rejects.toThrow(
      /cheque number/,
    );
  });

  it('builds the receipt normally once the cheque is identified', async () => {
    // The office supplied the date; the same collection now pushes.
    const out = await build([{ chequeNumber: '4893', dueDate: '2026-11-01' }]);
    expect(out.body).toMatchObject({
      externalId: 'col-1',
      paymentMethod: 'CHECK',
      checkNumber: '4893',
      checkDueDate: '2026-11-01',
    });
  });

  it('a collection carrying no cheque rows at all is left alone', async () => {
    // Not this guard's business: a cheque collection with no rows is a different
    // fault, and claiming a missing due date would misdescribe it.
    const out = await build([]);
    expect(out.body.checkNumber).toBeUndefined();
  });
});
