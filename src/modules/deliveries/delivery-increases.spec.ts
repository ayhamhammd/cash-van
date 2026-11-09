import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { DeliveryIncreasesService, orderNote, orderSalesman, sellsOrders } from './delivery-increases.service';
import { DismissIncreaseDto, OrderIncreaseDto } from './dto/deliveries.dto';

/** Phase-4 contract §B: the office decides an increase request. */
const REQ = '55555555-5555-4555-8555-555555555555';
const P1 = '22222222-2222-4222-8222-222222222222';
const P2 = '33333333-3333-4333-8333-333333333333';

describe('increase requests — who the order is for', () => {
  const rep = (kind: string, code: string | null = 'R1', isActive = true) => ({ kind, code, isActive }) as never;

  it("the customer's own salesman when he sells (SALES or BOTH)", () => {
    expect(orderSalesman(rep('SALES', 'S1'), rep('DELIVERY', 'D1'))).toMatchObject({ code: 'S1' });
    expect(orderSalesman(rep('BOTH', 'B1'), rep('DELIVERY', 'D1'))).toMatchObject({ code: 'B1' });
  });

  it('otherwise the delivery rep', () => {
    expect(orderSalesman(rep('DELIVERY', 'X1'), rep('DELIVERY', 'D1'))).toMatchObject({ code: 'D1' });
    expect(orderSalesman(null, rep('DELIVERY', 'D1'))).toMatchObject({ code: 'D1' });
    expect(orderSalesman(rep('SALES', null), rep('BOTH', 'D2'))).toMatchObject({ code: 'D2' });
    expect(orderSalesman(rep('SALES', 'S1', false), rep('DELIVERY', 'D1'))).toMatchObject({ code: 'D1' });
    expect(orderSalesman(null, rep('DELIVERY', null))).toBeNull();
    expect(sellsOrders(rep('DELIVERY', 'D1'))).toBe(false);
  });

  it('the voucher note says where the order came from, both languages', () => {
    expect(orderNote('INV-9')).toBe(
      'من طلب زيادة أثناء التوصيل — الفاتورة INV-9 / From a delivery increase request — invoice INV-9',
    );
    expect(orderNote('INV-9', ' call first ')).toMatch(/invoice INV-9\ncall first$/);
  });
});

describe('increase requests — order and dismiss', () => {
  type Req = Record<string, unknown> & { id: string; status: string };

  function setup(opts: {
    status?: string;
    decisionKey?: string | null;
    customerRepKind?: string | null;
    createFails?: Error;
    noLogin?: string[];
  } = {}) {
    const req: Req = {
      id: REQ,
      status: opts.status ?? 'PENDING',
      clientRef: 'd-1',
      stopId: 'stop-1',
      runId: 'run-1',
      customerId: 'cust-1',
      repId: 'rep-d',
      invoiceNumber: 'INV-9',
      lines: [
        { productId: P1, skuCode: 'W1', nameAr: 'ماء', nameEn: 'Water', unit: 'CTN', qty: 3 },
        { productId: P2, skuCode: 'J1', nameAr: 'عصير', nameEn: null, unit: 'CTN', qty: 1 },
      ],
      orderVoucherNumber: opts.status === 'ORDERED' ? 'ORD-S1-7' : null,
      orderVoucherId: opts.status === 'ORDERED' ? 'voucher-uuid-7' : null,
      orderTotalFils: opts.status === 'ORDERED' ? '5800' : null,
      decisionKey: opts.decisionKey ?? null,
      createdAt: new Date('2026-11-08T07:00:00Z'),
    };
    const reps: Record<string, unknown> = {
      'rep-s': { id: 'rep-s', kind: opts.customerRepKind ?? 'SALES', code: 'S1', isActive: true, nameAr: 'س' },
      'rep-d': { id: 'rep-d', kind: 'DELIVERY', code: 'D1', isActive: true, nameAr: 'د' },
    };
    const locks: string[] = [];
    const ds = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes('FROM customers')) return [{ id: 'cust-1', customer_number: 'C001', rep_id: 'rep-s' }];
        if (sql.includes('SELECT name FROM users')) return [{ name: 'Office Admin' }];
        if (sql.includes('SELECT user_number FROM users')) {
          return (params[0] as string[]).filter((c) => !(opts.noLogin ?? []).includes(c)).map((c) => ({ user_number: c }));
        }
        if (sql.includes('SELECT user_id FROM reps')) return [{ user_id: `user-of-${params[0]}` }];
        if (sql.includes('FROM item_cart')) {
          return (params[0] as string[]).map((id) => ({
            id,
            item_number: id === P1 ? 'W1' : 'J1',
            name_ar: 'x',
            name_en: null,
            unit: 'PCE',
            unit_name_ar: 'قطعة',
            unit_name_en: 'piece',
          }));
        }
        if (sql.includes('FROM delivery_runs')) return [{ id: 'run-1', run_number: 'DR-1', run_date: '2026-11-08' }];
        if (sql.includes('FROM delivery_stops')) return [{ id: 'stop-1', invoice_number: 'INV-9' }];
        return [];
      },
      createQueryRunner: () => ({
        connect: async () => undefined,
        release: async () => undefined,
        query: async (sql: string) => void locks.push(sql.includes('unlock') ? 'unlock' : 'lock'),
      }),
    };
    const vouchers = {
      create: jest.fn(async () => {
        if (opts.createFails) throw opts.createFails;
        return { id: 'voucher-uuid-7', voucherNumber: 'ORD-S1-7', netTotal: '5.800' };
      }),
    };
    const pricing = { quote: jest.fn(async (productId: string) => ({ finalUnitPrice: productId === P1 ? 1250 : 2000 })) };
    const notified: Array<{ userId: string; n: Record<string, unknown> }> = [];
    const signals: unknown[] = [];
    const svc = new DeliveryIncreasesService(
      ds as never,
      { findOne: async () => req, save: async (r: Req) => Object.assign(req, r) } as never,
      { findOne: async ({ where }: { where: { id: string } }) => reps[where.id] ?? null, find: async () => Object.values(reps) } as never,
      vouchers as never,
      pricing as never,
      { customerRefs: async () => new Map([['cust-1', { id: 'cust-1', customerNumber: 'C001', name: 'Shop', placeLabel: null }]]) } as never,
      { signal: (r: unknown) => signals.push(r) } as never,
      { notifyUser: async (userId: string, n: Record<string, unknown>) => void notified.push({ userId, n }) } as never,
    );
    return { svc, req, vouchers, pricing, notified, signals, locks };
  }
  const actor = { sub: 'user-a', userNumber: 'A1' } as never;

  it("creates the ORDER through the vouchers service: the customer, his salesman, quoted prices, the note", async () => {
    const t = setup();
    const out = await t.svc.order(REQ, {}, actor, 'click-1');
    expect(t.vouchers.create).toHaveBeenCalledTimes(1);
    expect(t.vouchers.create).toHaveBeenCalledWith({
      transKind: 'ORDER',
      userCode: 'S1',
      customerNumber: 'C001',
      notes: orderNote('INV-9', undefined),
      isPosted: true,
      transactions: [
        { itemNumber: 'W1', itemName: 'Water', itemQty: '3', unitPrice: '1.250', storeNumber: 'S1' },
        { itemNumber: 'J1', itemName: 'عصير', itemQty: '1', unitPrice: '2.000', storeNumber: 'S1' },
      ],
    });
    expect(t.pricing.quote).toHaveBeenCalledWith(P1, 3, 'cust-1');
    expect(out.order).toEqual({ id: 'voucher-uuid-7', voucherNumber: 'ORD-S1-7', totalFils: 5800 });
    expect(out.request).toMatchObject({
      status: 'ORDERED',
      decidedBy: 'Office Admin',
      order: { id: 'voucher-uuid-7', voucherNumber: 'ORD-S1-7', totalFils: 5800 },
      run: { id: 'run-1', runNumber: 'DR-1' },
      stop: { id: 'stop-1', invoiceNumber: 'INV-9' },
      customer: { id: 'cust-1', customerNumber: 'C001' },
    });
    expect(t.req.decisionKey).toBe('click-1');
    // The delivery rep is told, and his phone re-pulls.
    expect(t.notified).toEqual([
      {
        userId: 'user-of-rep-d',
        n: expect.objectContaining({ kind: 'delivery.increase_ordered', bodyAr: 'طلب الزيادة للفاتورة INV-9 أُنشئ كأمر بيع ORD-S1-7' }),
      },
    ]);
    expect(t.signals).toHaveLength(1);
    expect(t.locks).toEqual(['lock', 'unlock']);
  });

  it('a customer whose salesman is a delivery rep gets the order under the delivery rep', async () => {
    const t = setup({ customerRepKind: 'DELIVERY' });
    await t.svc.order(REQ, {}, actor, 'k');
    expect((t.vouchers.create.mock.calls[0] as unknown[])[0]).toMatchObject({ userCode: 'D1' });
  });

  it("a salesman without a login is passed over (a voucher's user_code is a login)", async () => {
    const t = setup({ noLogin: ['S1'] });
    await t.svc.order(REQ, {}, actor, 'k');
    expect((t.vouchers.create.mock.calls[0] as unknown[])[0]).toMatchObject({ userCode: 'D1' });
    const none = setup({ noLogin: ['S1', 'D1'] });
    await expect(none.svc.order(REQ, {}, actor, 'k')).rejects.toMatchObject({ response: { code: 'SALESMAN_NOT_FOUND' } });
    expect(none.vouchers.create).not.toHaveBeenCalled();
  });

  it("a row stored with the placeholder 'carton' reads in the base unit, and is ordered and saved that way", async () => {
    const t = setup();
    const out = await t.svc.order(REQ, {}, actor, 'k');
    expect(out.request.lines[0]).toMatchObject({ unit: 'PCE', unitNameAr: 'قطعة', unitNameEn: 'piece', qty: 3 });
    expect((t.req.lines as Array<{ unit: string }>).map((l) => l.unit)).toEqual(['PCE', 'PCE']);
  });

  it("the office's edited lines replace the request's", async () => {
    const t = setup();
    await t.svc.order(REQ, { lines: [{ productId: P2, qty: 4 }] }, actor, 'k');
    const dto = (t.vouchers.create.mock.calls[0] as unknown[])[0] as { transactions: unknown[] };
    expect(dto.transactions).toEqual([{ itemNumber: 'J1', itemName: 'x', itemQty: '4', unitPrice: '2.000', storeNumber: 'S1' }]);
    expect(t.req.lines).toEqual([
      { productId: P2, skuCode: 'J1', nameAr: 'x', nameEn: null, unit: 'PCE', unitNameAr: 'قطعة', unitNameEn: 'piece', qty: 4 },
    ]);
  });

  it('the same Idempotency-Key again answers the same order without a second one', async () => {
    const t = setup({ status: 'ORDERED', decisionKey: 'click-1' });
    const out = await t.svc.order(REQ, {}, actor, 'click-1');
    expect(out.order).toEqual({ id: 'voucher-uuid-7', voucherNumber: 'ORD-S1-7', totalFils: 5800 });
    expect(t.vouchers.create).not.toHaveBeenCalled();
    expect(t.notified).toEqual([]);
  });

  it.each([
    ['ORDERED', 'click-2'],
    ['ORDERED', undefined],
    ['DISMISSED', 'click-1'],
  ])('409 INCREASE_ALREADY_DECIDED on a %s request (key %s)', async (status, key) => {
    const t = setup({ status, decisionKey: 'click-1' });
    const err = await t.svc.order(REQ, {}, actor, key).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'INCREASE_ALREADY_DECIDED' });
    expect(t.vouchers.create).not.toHaveBeenCalled();
    expect(t.locks).toEqual(['lock', 'unlock']);
  });

  it("the vouchers service's refusal is 422 with its code, and the request stays PENDING", async () => {
    const t = setup({ createFails: new BadRequestException('اختر العميل قبل حفظ الطلبية') });
    const err = await t.svc.order(REQ, {}, actor, 'k').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ code: 'ORDER_REJECTED' });
    expect(t.req.status).toBe('PENDING');
    const coded = setup({ createFails: new ConflictException({ code: 'CREDIT_HOLD', message: 'on hold' }) });
    expect(((await coded.svc.order(REQ, {}, actor, 'k').catch((e: unknown) => e)) as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'CREDIT_HOLD',
    });
  });

  it('dismiss records the note, tells the rep; a second decision is 409, the same key is a replay', async () => {
    const t = setup();
    const out = await t.svc.dismiss(REQ, { note: ' not now ' }, actor, 'd-key');
    expect(out.request).toMatchObject({ status: 'DISMISSED', decisionNote: 'not now', decidedBy: 'Office Admin' });
    expect(t.notified[0].n).toMatchObject({ kind: 'delivery.increase_dismissed', bodyAr: 'رُفض طلب الزيادة: not now' });
    expect((await t.svc.dismiss(REQ, { note: 'again' }, actor, 'd-key')).request.decisionNote).toBe('not now');
    expect(t.notified).toHaveLength(1);
    await expect(t.svc.dismiss(REQ, { note: 'again' }, actor, 'other')).rejects.toBeInstanceOf(ConflictException);
    await expect(t.svc.order(REQ, {}, actor, 'other')).rejects.toBeInstanceOf(ConflictException);
  });

  it('the bodies: order lines qty ≥ 1, dismiss needs a note', async () => {
    const errs = async (cls: new () => object, b: object) =>
      (await validate(plainToInstance(cls, b), { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property);
    expect(await errs(OrderIncreaseDto, {})).toEqual([]);
    expect(await errs(OrderIncreaseDto, { lines: [{ productId: P1, qty: 2 }] })).toEqual([]);
    expect(await errs(OrderIncreaseDto, { lines: [{ productId: P1, qty: 0.5 }] })).toContain('lines');
    expect(await errs(OrderIncreaseDto, { lines: [] })).toContain('lines');
    expect(await errs(DismissIncreaseDto, { note: ' ' })).toContain('note');
    expect(await errs(DismissIncreaseDto, { note: 'no stock' })).toEqual([]);
  });
});
