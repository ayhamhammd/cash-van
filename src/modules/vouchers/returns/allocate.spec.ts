import { allocateReturn } from './allocate';
import type { ReturnCandidate } from './candidates';
import { RETURN_STRATEGIES } from './strategies';

function candidate(over: Partial<ReturnCandidate> = {}): ReturnCandidate {
  const soldQty = over.soldQty ?? 10;
  return {
    voucherNumber: 'V-1',
    lineId: '00000000-0000-0000-0000-000000000001',
    inDate: '2026-05-01',
    customerNumber: 'CUST-1',
    itemNumber: 'ITEM-1',
    itemName: 'Item One',
    itemUnitId: null,
    unitCode: 'PCS',
    unitName: 'Piece',
    soldQty,
    remaining: over.remaining ?? soldQty,
    unitPrice: 2,
    discountValue: 0,
    taxValue: 0,
    netTotal: soldQty * 2,
    ...over,
  };
}

describe('allocateReturn', () => {
  it('walks an item over its sale vouchers in order, spanning several', () => {
    const plan = allocateReturn({
      request: [{ itemNumber: 'ITEM-1', itemUnitId: null, quantity: 10 }],
      candidates: [
        candidate({ voucherNumber: 'V-A', lineId: 'a', inDate: '2026-05-02', soldQty: 6 }),
        candidate({ voucherNumber: 'V-B', lineId: 'b', inDate: '2026-05-01', soldQty: 4 }),
      ],
      strategy: 'NEWEST_FIRST',
    });

    expect(plan.lines.map((l) => [l.voucherNumber, l.quantity])).toEqual([
      ['V-A', 6],
      ['V-B', 4],
    ]);
    // One RETURN voucher per source sale — the ERP takes a single
    // originalInvoiceNumber and JoFotara allows one invoice per credit note.
    expect(plan.voucherCount).toBe(2);
    expect(plan.unallocated).toEqual([]);
  });

  it('reports what it could not source instead of silently short-refunding', () => {
    const plan = allocateReturn({
      request: [{ itemNumber: 'ITEM-1', itemUnitId: null, quantity: 10 }],
      candidates: [candidate({ soldQty: 4 })],
      strategy: 'NEWEST_FIRST',
    });

    expect(plan.lines[0].quantity).toBe(4);
    expect(plan.unallocated).toHaveLength(1);
    expect(plan.unallocated[0].quantity).toBe(6);
  });

  it('never draws the same units twice when an item is requested twice', () => {
    const plan = allocateReturn({
      request: [
        { itemNumber: 'ITEM-1', itemUnitId: null, quantity: 6 },
        { itemNumber: 'ITEM-1', itemUnitId: null, quantity: 6 },
      ],
      candidates: [candidate({ soldQty: 10 })],
      strategy: 'NEWEST_FIRST',
    });

    const taken = plan.lines.reduce((s, l) => s + l.quantity, 0);
    expect(taken).toBe(10);
    expect(plan.unallocated[0].quantity).toBe(2);
  });

  it('does NOT let a carton return consume a piece line', () => {
    // The failure this guards: same item, two units. Matching on item alone
    // would refund 3 cartons out of a line that only ever sold pieces.
    const plan = allocateReturn({
      request: [{ itemNumber: 'ITEM-1', itemUnitId: 'carton', quantity: 3 }],
      candidates: [candidate({ itemUnitId: 'piece', soldQty: 100 })],
      strategy: 'NEWEST_FIRST',
    });

    expect(plan.lines).toEqual([]);
    expect(plan.unallocated[0].reason).toMatch(/No matching sale/);
  });

  it('orders oldest-first when asked', () => {
    const plan = allocateReturn({
      request: [{ itemNumber: 'ITEM-1', itemUnitId: null, quantity: 4 }],
      candidates: [
        candidate({ voucherNumber: 'V-A', lineId: 'a', inDate: '2026-05-02', soldQty: 6 }),
        candidate({ voucherNumber: 'V-B', lineId: 'b', inDate: '2026-05-01', soldQty: 6 }),
      ],
      strategy: 'OLDEST_FIRST',
    });
    expect(plan.lines[0].voucherNumber).toBe('V-B');
  });

  it('is deterministic when two sales share a date — the tie-break decides', () => {
    // Without the stable tie-break this is the bug that bites on a busy day:
    // preview walks one order, confirm walks another, and the user approves a
    // plan the system does not create.
    const sameDay = [
      candidate({ voucherNumber: 'V-B', lineId: 'b', inDate: '2026-05-02', soldQty: 5 }),
      candidate({ voucherNumber: 'V-A', lineId: 'a', inDate: '2026-05-02', soldQty: 5 }),
    ];
    for (const strategy of RETURN_STRATEGIES) {
      const run = () =>
        allocateReturn({
          request: [
            {
              itemNumber: 'ITEM-1',
              itemUnitId: null,
              quantity: 5,
              expectedUnitPrice: 2,
            },
          ],
          candidates: [...sameDay].reverse(),
          strategy,
        });
      // Strategy carried into the compared value so a failure names which one.
      expect({ strategy, first: run().lines[0].voucherNumber }).toEqual({
        strategy,
        first: run().lines[0].voucherNumber,
      });
      // Ascending voucher number is the documented tie-break.
      expect({ strategy, first: run().lines[0].voucherNumber }).toEqual({
        strategy,
        first: 'V-A',
      });
    }
  });

  it('pro-rates a partial return rather than recomputing from unit price', () => {
    // The sale carried a discount and tax the customer actually paid; a refund
    // recomputed from unit price would return a number never on the document.
    const plan = allocateReturn({
      request: [{ itemNumber: 'ITEM-1', itemUnitId: null, quantity: 5 }],
      candidates: [
        candidate({ soldQty: 10, discountValue: 4, taxValue: 1.6, netTotal: 17.6 }),
      ],
      strategy: 'NEWEST_FIRST',
    });

    expect(plan.lines[0].discountValue).toBe(2);
    expect(plan.lines[0].taxValue).toBe(0.8);
    expect(plan.lines[0].netTotal).toBe(8.8);
    expect(plan.refundTotal).toBe(8.8);
  });

  it('refuses CLOSEST_PRICE without the price the customer says they paid', () => {
    const plan = allocateReturn({
      request: [{ itemNumber: 'ITEM-1', itemUnitId: null, quantity: 1 }],
      candidates: [candidate()],
      strategy: 'CLOSEST_PRICE',
    });
    // Refuses rather than quietly falling back to another ordering, which would
    // be indistinguishable from a plan the user actually asked for.
    expect(plan.error).toMatch(/expectedUnitPrice/);
    expect(plan.lines).toEqual([]);
  });

  it('CLOSEST_PRICE picks the sale nearest what was paid', () => {
    const plan = allocateReturn({
      request: [
        { itemNumber: 'ITEM-1', itemUnitId: null, quantity: 1, expectedUnitPrice: 5 },
      ],
      candidates: [
        candidate({ voucherNumber: 'V-A', lineId: 'a', unitPrice: 2 }),
        candidate({ voucherNumber: 'V-B', lineId: 'b', unitPrice: 4.5 }),
      ],
      strategy: 'CLOSEST_PRICE',
    });
    expect(plan.lines[0].voucherNumber).toBe('V-B');
  });

  it('skips lines with nothing left to return', () => {
    const plan = allocateReturn({
      request: [{ itemNumber: 'ITEM-1', itemUnitId: null, quantity: 3 }],
      candidates: [
        candidate({ voucherNumber: 'V-A', lineId: 'a', soldQty: 10, remaining: 0 }),
        candidate({ voucherNumber: 'V-B', lineId: 'b', soldQty: 10, remaining: 3 }),
      ],
      strategy: 'NEWEST_FIRST',
    });
    expect(plan.lines.map((l) => l.voucherNumber)).toEqual(['V-B']);
  });
});
