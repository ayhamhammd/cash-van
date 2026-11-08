import { checkLines, checkProofs } from './delivery-result-checks';
import { conditionOf } from './delivery-reasons';

/** Contract §0 and §B: the outcome follows the lines, and the proofs it needs. */
describe('result checks — lines', () => {
  const stop = [
    { erpInvoiceItemId: 'a', invoicedQty: 10 },
    { erpInvoiceItemId: 'b', invoicedQty: 2.5 },
  ];
  const fail = (outcome: 'DELIVERED' | 'PARTIAL' | 'RETURNED', lines?: unknown[]) => {
    const r = checkLines(stop, outcome, lines as never);
    return r.ok ? null : r.reason;
  };

  it('no lines: DELIVERED is all in full, RETURNED is all at 0, PARTIAL cannot be', () => {
    const d = checkLines(stop, 'DELIVERED', undefined);
    expect(d.ok && d.lines.map((l) => l.deliveredQty)).toEqual([10, 2.5]);
    expect(d.ok && d.differing).toBe(0);
    const r = checkLines(stop, 'RETURNED', []);
    expect(r.ok && r.lines.map((l) => l.deliveredQty)).toEqual([0, 0]);
    expect(r.ok && r.differing).toBe(2);
    expect(fail('PARTIAL')).toBe('OUTCOME_MISMATCH');
  });

  it('lines left out are delivered in full', () => {
    const r = checkLines(stop, 'PARTIAL', [{ erpInvoiceItemId: 'a', deliveredQty: 8, reasonCode: 'DAMAGED' }]);
    expect(r.ok && r.lines).toEqual([
      expect.objectContaining({ erpInvoiceItemId: 'a', deliveredQty: 8, reasonCode: 'DAMAGED', differs: true }),
      expect.objectContaining({ erpInvoiceItemId: 'b', deliveredQty: 2.5, differs: false }),
    ]);
    expect(r.ok && r.differing).toBe(1);
  });

  it('the outcome must match the lines', () => {
    const short = [{ erpInvoiceItemId: 'a', deliveredQty: 8, reasonCode: 'DAMAGED' }];
    expect(fail('DELIVERED', short)).toBe('OUTCOME_MISMATCH');
    expect(fail('RETURNED', short)).toBe('OUTCOME_MISMATCH');
    const none = [
      { erpInvoiceItemId: 'a', deliveredQty: 0, reasonCode: 'CUSTOMER_REFUSED' },
      { erpInvoiceItemId: 'b', deliveredQty: 0, reasonCode: 'CUSTOMER_REFUSED' },
    ];
    expect(fail('PARTIAL', none)).toBe('OUTCOME_MISMATCH');
    expect(fail('RETURNED', none)).toBeNull();
    expect(fail('DELIVERED', [{ erpInvoiceItemId: 'a', deliveredQty: 10 }])).toBeNull();
  });

  it('0 ≤ deliveredQty ≤ invoicedQty, decimals allowed', () => {
    expect(fail('PARTIAL', [{ erpInvoiceItemId: 'a', deliveredQty: 11 }])).toBe('QTY_OUT_OF_RANGE');
    expect(fail('PARTIAL', [{ erpInvoiceItemId: 'b', deliveredQty: -0.5, reasonCode: 'LOST' }])).toBe(
      'QTY_OUT_OF_RANGE',
    );
    expect(fail('PARTIAL', [{ erpInvoiceItemId: 'b', deliveredQty: 1.25, reasonCode: 'LOST' }])).toBeNull();
  });

  it('a short line needs a reason, and OTHER a note', () => {
    expect(fail('PARTIAL', [{ erpInvoiceItemId: 'a', deliveredQty: 8 }])).toBe('REASON_REQUIRED');
    expect(fail('PARTIAL', [{ erpInvoiceItemId: 'a', deliveredQty: 8, reasonCode: 'OTHER' }])).toBe(
      'NOTE_REQUIRED',
    );
    expect(fail('PARTIAL', [{ erpInvoiceItemId: 'a', deliveredQty: 8, reasonCode: 'OTHER', note: '  ' }])).toBe(
      'NOTE_REQUIRED',
    );
    expect(
      fail('PARTIAL', [{ erpInvoiceItemId: 'a', deliveredQty: 8, reasonCode: 'OTHER', note: 'shop closed early' }]),
    ).toBeNull();
    // A full line needs no reason.
    expect(fail('DELIVERED', [{ erpInvoiceItemId: 'a', deliveredQty: 10 }])).toBeNull();
  });

  it('a line the stop does not have, or the same line twice, is LINE_UNKNOWN', () => {
    expect(fail('DELIVERED', [{ erpInvoiceItemId: 'zz', deliveredQty: 1 }])).toBe('LINE_UNKNOWN');
    expect(
      fail('DELIVERED', [
        { erpInvoiceItemId: 'a', deliveredQty: 10 },
        { erpInvoiceItemId: 'a', deliveredQty: 10 },
      ]),
    ).toBe('LINE_UNKNOWN');
  });

  it('a stop with no lines takes DELIVERED or RETURNED', () => {
    expect(checkLines([], 'DELIVERED', undefined).ok).toBe(true);
    expect(checkLines([], 'RETURNED', undefined).ok).toBe(true);
    expect(checkLines([], 'PARTIAL', undefined).ok).toBe(false);
  });

  it('each reason sets the condition of the goods', () => {
    expect(conditionOf('DAMAGED')).toBe('DAMAGED');
    expect(conditionOf('EXPIRED')).toBe('DAMAGED');
    expect(conditionOf('LOST')).toBe('DAMAGED');
    expect(conditionOf('NOT_LOADED')).toBe('GOOD');
    expect(conditionOf('CUSTOMER_REFUSED')).toBe('GOOD');
    expect(conditionOf('WRONG_ITEM')).toBe('GOOD');
    expect(conditionOf('OTHER')).toBe('GOOD');
    expect(conditionOf(null)).toBeNull();
  });
});

describe('result checks — proofs', () => {
  const up = [
    { clientRef: 'p-1', kind: 'PHOTO' as const },
    { clientRef: 'p-2', kind: 'PHOTO' as const },
    { clientRef: 's-1', kind: 'SIGNATURE' as const },
    { clientRef: 's-2', kind: 'SIGNATURE' as const },
  ];

  it('DELIVERED / PARTIAL need a photo and exactly one signature', () => {
    expect(checkProofs(true, 'DELIVERED', ['p-1', 's-1'], up)).toBeNull();
    expect(checkProofs(true, 'PARTIAL', ['p-1', 'p-2', 's-1'], up)).toBeNull();
    expect(checkProofs(true, 'DELIVERED', ['s-1'], up)).toBe('PROOF_MISSING');
    expect(checkProofs(true, 'DELIVERED', ['p-1'], up)).toBe('PROOF_MISSING');
    expect(checkProofs(true, 'DELIVERED', ['p-1', 's-1', 's-2'], up)).toBe('PROOF_MISSING');
    expect(checkProofs(true, 'DELIVERED', [], up)).toBe('PROOF_MISSING');
  });

  it('RETURNED needs a photo only', () => {
    expect(checkProofs(true, 'RETURNED', ['p-1'], up)).toBeNull();
    expect(checkProofs(true, 'RETURNED', ['s-1'], up)).toBe('PROOF_MISSING');
  });

  it('every ref must be uploaded for this stop, required or not', () => {
    expect(checkProofs(true, 'DELIVERED', ['p-1', 's-1', 'p-9'], up)).toBe('PROOF_UNKNOWN');
    expect(checkProofs(false, 'DELIVERED', ['p-9'], up)).toBe('PROOF_UNKNOWN');
  });

  it('with proofs switched off, none are needed', () => {
    expect(checkProofs(false, 'DELIVERED', [], [])).toBeNull();
    expect(checkProofs(false, 'PARTIAL', [], [])).toBeNull();
  });

  it('a ref named twice counts once', () => {
    expect(checkProofs(true, 'DELIVERED', ['p-1', 's-1', 's-1'], up)).toBeNull();
  });
});
