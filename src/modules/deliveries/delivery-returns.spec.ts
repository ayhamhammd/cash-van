import { DeliveryErpClient, ErpRefusedError, ErpUnavailableError } from './delivery-erp.client';
import { DeliveryReturnsService, creditNoteSummary } from './delivery-returns.service';
import { decisionNotice } from './delivery-mirror.service';
import { returnRequestView, returnValueFils, stopView } from './delivery-views';
import type { DeliveryStop } from './entities/delivery-stop.entity';
import type { DeliveryStopLine } from './entities/delivery-stop-line.entity';

/** Phase-3 contract §B: the returns routes, their ERP calls and their answers. */

const STOP = '11111111-1111-4111-8111-111111111111';

describe('returns — the value and the view', () => {
  const line = (over: Record<string, unknown>) =>
    ({
      invoicedQty: '10',
      deliveredQty: '6',
      approvedQty: null,
      billedQty: '10',
      lineTotalFils: '11600',
      unitPriceFils: '1000',
      taxRate: '16',
      ...over,
    }) as unknown as DeliveryStopLine;

  it('values what comes back at the line total, tax included, prorated over the billed quantity', () => {
    expect(returnValueFils({ returnStatus: 'PENDING' }, [line({})])).toBe(4640);
    // Already-returned quantity on the invoice does not change the price per unit.
    expect(returnValueFils({ returnStatus: 'PENDING' }, [line({ invoicedQty: '8', billedQty: '10' })])).toBe(2320);
    // An approved return is valued at what was approved.
    expect(returnValueFils({ returnStatus: 'APPROVED' }, [line({ approvedQty: '3' })])).toBe(3480);
    // No line total mirrored (an older ERP): unit price plus tax.
    expect(returnValueFils({ returnStatus: 'PENDING' }, [line({ lineTotalFils: '0' })])).toBe(4640);
    // A line delivered in full returns nothing.
    expect(returnValueFils({ returnStatus: 'PENDING' }, [line({ deliveredQty: '10' })])).toBe(0);
  });

  it('a ReturnRequest carries the run, the decision and the credit note', () => {
    const stop = {
      id: STOP,
      erpId: 'item-9',
      sequence: 1,
      status: 'PARTIAL',
      returnStatus: 'APPROVED',
      returnDecidedAt: new Date('2026-11-08T09:00:00Z'),
      returnDecidedBy: 'Office Admin',
      returnDecisionNote: 'ok',
      creditNoteErpId: 'cn-1',
      creditNoteNumber: 'CN-7',
      creditNoteTotalFils: '3480',
      creditNoteQr: 'QR',
      creditNoteJofotaraStatus: 'SUBMITTED',
      totalFils: '11600',
      taxFils: '1600',
      paidFils: '0',
      localResultRef: null,
      erpOnlyAttachments: 0,
    } as unknown as DeliveryStop;
    const lines = [line({ id: 'l1', erpInvoiceItemId: 'ii-1', approvedQty: '3' })];
    const view = stopView(stop, lines, null, 0);
    // The phone's fields.
    expect(view).toMatchObject({
      returnStatus: 'APPROVED',
      returnDecisionNote: 'ok',
      creditNoteNumber: 'CN-7',
      creditNoteQr: 'QR',
      creditNoteTotalFils: 3480,
      returnDecidedBy: 'Office Admin',
      returnDecidedAt: '2026-11-08T09:00:00.000Z',
    });
    expect(view.lines[0].approvedQty).toBe(3);
    const rr = returnRequestView(stop, view, lines, { id: 'run-l', runNumber: 'DR-1', runDate: '2026-11-08', rep: null });
    expect(rr).toMatchObject({
      run: { id: 'run-l', runNumber: 'DR-1' },
      returnValueFils: 3480,
      decidedAt: '2026-11-08T09:00:00.000Z',
      decidedBy: 'Office Admin',
      decisionNote: 'ok',
      creditNote: { number: 'CN-7', totalFils: 3480, jofotaraStatus: 'SUBMITTED', qr: 'QR' },
    });
    expect(returnRequestView({ ...stop, creditNoteErpId: null, creditNoteNumber: null } as DeliveryStop, view, lines, rr.run).creditNote).toBeNull();
  });

  it('the rep is told in Arabic and English', () => {
    expect(
      decisionNotice({ stopId: 's', invoiceNumber: 'INV-1', status: 'APPROVED', creditNoteNumber: 'CN-7', note: null }),
    ).toMatchObject({ bodyAr: 'اعتُمد مرتجع الفاتورة INV-1 (إشعار دائن CN-7)', bodyEn: 'Return for invoice INV-1 approved (credit note CN-7)' });
    expect(
      decisionNotice({ stopId: 's', invoiceNumber: 'INV-1', status: 'REJECTED', creditNoteNumber: null, note: 'no' }),
    ).toMatchObject({ titleEn: 'Return rejected', bodyEn: 'Return for invoice INV-1 rejected: no' });
  });

  it('the ERP credit note in fils', () => {
    expect(
      creditNoteSummary({ id: 'cn', number: 'CN-7', total: 3.48, taxTotal: 0.48, jofotara: { status: 'VALIDATED', qrCode: 'Q' } }),
    ).toEqual({ number: 'CN-7', totalFils: 3480, jofotaraStatus: 'VALIDATED', qr: 'Q' });
    expect(creditNoteSummary(null)).toBeNull();
  });
});

describe('returns — approve and reject', () => {
  function setup(opts: { pullFails?: boolean } = {}) {
    const stop = { id: STOP, runId: 'run-l', erpId: 'item-9', creditNoteNumber: null } as unknown as DeliveryStop;
    const erp = {
      approveReturn: jest.fn().mockResolvedValue({
        item: { id: 'item-9' },
        creditNote: { id: 'cn-1', number: 'CN-7', total: 3.48, taxTotal: 0.48, jofotara: { status: 'SUBMITTED', qrCode: 'Q' } },
      }),
      rejectReturn: jest.fn().mockResolvedValue({ item: { id: 'item-9' } }),
    };
    const mirror = {
      pullRun: opts.pullFails ? jest.fn().mockRejectedValue(new Error('ERP gone')) : jest.fn().mockResolvedValue({}),
    };
    const svc = new DeliveryReturnsService(
      { query: async () => [{ name: 'Office Admin', user_number: 'A1' }] } as never,
      { findOne: async ({ where }: { where: { id: string } }) => (where.id === STOP ? stop : null), findOneOrFail: async () => stop } as never,
      { findOne: async () => ({ id: 'run-l', erpId: 'run-1' }) } as never,
      {} as never,
      {} as never,
      { stopViews: async () => [{ id: STOP, returnStatus: 'APPROVED' }] } as never,
      erp as never,
      mirror as never,
    );
    return { svc, erp, mirror };
  }
  const actor = { sub: 'user-1', userNumber: 'A1' } as never;

  it('approves with the office user as decider and the dashboard key, maps the lines, re-reads the run', async () => {
    const t = setup();
    const out = await t.svc.approve(
      STOP,
      { note: ' fine ', lines: [{ erpInvoiceItemId: 'ii-1', qty: 3, condition: 'DAMAGED' }] },
      actor,
      'click-uuid-1',
    );
    expect(t.erp.approveReturn).toHaveBeenCalledWith(
      'item-9',
      {
        approvedBy: { id: 'user-1', name: 'Office Admin' },
        note: 'fine',
        lines: [{ invoiceItemId: 'ii-1', qty: 3, condition: 'DAMAGED' }],
      },
      'click-uuid-1',
    );
    expect(t.mirror.pullRun).toHaveBeenCalledWith('run-1');
    expect(out).toEqual({
      stop: { id: STOP, returnStatus: 'APPROVED' },
      creditNote: { number: 'CN-7', totalFils: 3480, jofotaraStatus: 'SUBMITTED', qr: 'Q' },
    });
  });

  it('a plain approve sends no lines; a missing key is minted', async () => {
    const t = setup();
    await t.svc.approve(STOP, {}, actor);
    const [, body, key] = t.erp.approveReturn.mock.calls[0];
    expect(body).toEqual({ approvedBy: { id: 'user-1', name: 'Office Admin' } });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects with the note and the decider', async () => {
    const t = setup();
    expect(await t.svc.reject(STOP, { note: ' customer kept it ' }, actor, 'k-2')).toEqual({
      stop: { id: STOP, returnStatus: 'APPROVED' },
    });
    expect(t.erp.rejectReturn).toHaveBeenCalledWith(
      'item-9',
      { rejectedBy: { id: 'user-1', name: 'Office Admin' }, note: 'customer kept it' },
      'k-2',
    );
  });

  it('a decision the ERP made is not undone by a failed re-read', async () => {
    const t = setup({ pullFails: true });
    await expect(t.svc.approve(STOP, {}, actor, 'k')).resolves.toMatchObject({ creditNote: { number: 'CN-7' } });
  });

  it('404 STOP_NOT_FOUND before calling the ERP', async () => {
    const t = setup();
    await expect(t.svc.approve('22222222-2222-4222-8222-222222222222', {}, actor)).rejects.toMatchObject({
      response: { code: 'STOP_NOT_FOUND' },
    });
    expect(t.erp.approveReturn).not.toHaveBeenCalled();
  });
});

describe('returns — the ERP call and its refusals', () => {
  function client(reply: { ok: boolean; status: number; data: unknown } | Error) {
    const http = {
      send: jest.fn(async () => {
        if (reply instanceof Error) throw reply;
        return reply;
      }),
    };
    const settings = { getErpConfig: async () => ({ enabled: true, baseUrl: 'http://erp', apiKey: 'k' }) };
    return { c: new DeliveryErpClient(http as never, settings as never), http };
  }
  const body = { approvedBy: { id: 'u', name: 'n' } };

  it('posts to delivery-returns/{item}/approve with the Idempotency-Key and unwraps item + credit note', async () => {
    const { c, http } = client({
      ok: true,
      status: 200,
      data: { success: true, data: { item: { id: 'item-9', returnStatus: 'APPROVED' }, creditNote: { id: 'cn', number: 'CN-7' } } },
    });
    const out = await c.approveReturn('item-9', body, 'key-1');
    expect(http.send).toHaveBeenCalledWith('POST', 'delivery-returns/item-9/approve', { body, idempotencyKey: 'key-1' });
    expect(out.item?.id).toBe('item-9');
    expect(out.creditNote?.number).toBe('CN-7');
  });

  it.each([
    [409, 'RETURN_ALREADY_DECIDED'],
    [422, 'NOTHING_TO_RETURN'],
    [422, 'QTY_OUT_OF_RANGE'],
    [422, 'NO_DAMAGED_WAREHOUSE'],
    [404, 'NOT_FOUND'],
    [400, 'VALIDATION_ERROR'],
  ])('passes %s %s through with its code', async (status, code) => {
    const { c } = client({ ok: false, status, data: { success: false, error: { code, message: 'x' } } });
    const err = await c.approveReturn('item-9', body, 'k').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErpRefusedError);
    expect((err as ErpRefusedError).getStatus()).toBe(status);
    expect((err as ErpRefusedError).getResponse()).toMatchObject({ code });
  });

  it('an unreachable ERP is 503 ERP_UNAVAILABLE', async () => {
    const { c } = client(new TypeError('fetch failed'));
    const err = await c.rejectReturn('item-9', { rejectedBy: { id: 'u', name: 'n' }, note: 'x' }, 'k').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErpUnavailableError);
    expect((err as ErpUnavailableError).getResponse()).toMatchObject({ code: 'ERP_UNAVAILABLE' });
  });
});

describe('returns — the bodies', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { plainToInstance } = require('class-transformer');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { validate } = require('class-validator');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dto = require('./dto/deliveries.dto');
  const errs = async (cls: unknown, b: object) =>
    ((await validate(plainToInstance(cls, b), { whitelist: true, forbidNonWhitelisted: true })) as Array<{ property: string }>).map(
      (e) => e.property,
    );

  it('reject needs a note that is not blank', async () => {
    expect(await errs(dto.RejectReturnDto, { note: 'kept it' })).toEqual([]);
    expect(await errs(dto.RejectReturnDto, { note: '   ' })).toContain('note');
    expect(await errs(dto.RejectReturnDto, {})).toContain('note');
  });

  it('approve lines need a quantity ≥ 0 and GOOD or DAMAGED', async () => {
    expect(await errs(dto.ApproveReturnDto, {})).toEqual([]);
    expect(await errs(dto.ApproveReturnDto, { lines: [{ erpInvoiceItemId: 'ii', qty: 2, condition: 'GOOD' }] })).toEqual([]);
    expect(await errs(dto.ApproveReturnDto, { lines: [{ erpInvoiceItemId: 'ii', qty: -1, condition: 'GOOD' }] })).toContain('lines');
    expect(await errs(dto.ApproveReturnDto, { lines: [{ erpInvoiceItemId: 'ii', qty: 1, condition: 'BROKEN' }] })).toContain('lines');
  });

  it('the queue takes PENDING, DECIDED or ALL', async () => {
    expect(await errs(dto.ListReturnsQuery, { status: 'DECIDED' })).toEqual([]);
    expect(await errs(dto.ListReturnsQuery, { status: 'APPROVED' })).toContain('status');
  });
});
