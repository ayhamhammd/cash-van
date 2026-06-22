import { OffersEngineService } from './offers-engine.service';
import type { Offer } from './entities/offer.entity';

/**
 * Pure-ish unit tests for the discount engine. Repositories are mocked so the
 * tests exercise the payment-method + static/dynamic math, not the DB.
 * Items: A = 1000 fils, B = 500 fils, both tax-free.
 */
describe('OffersEngineService', () => {
  const items = [
    { itemNumber: 'A', price: 1000, taxPercentage: '0', name: 'A', nameEn: 'A' },
    { itemNumber: 'B', price: 500, taxPercentage: '0', name: 'B', nameEn: 'B' },
  ];

  const chain = {
    where: () => chain,
    andWhere: () => chain,
    getCount: async () => 0,
  };

  function makeEngine(offers: Partial<Offer>[]): OffersEngineService {
    const full = offers.map((o, i) => ({
      id: o.id ?? `off-${i}`,
      name: o.name ?? `offer ${i}`,
      description: null,
      type: o.type ?? 'PAYMENT_METHOD_DISCOUNT',
      trigger: o.trigger ?? {},
      reward: o.reward,
      eligibility: o.eligibility ?? { customerScope: 'ALL' },
      validFrom: null,
      validTo: null,
      daysOfWeek: null,
      timeFrom: null,
      timeTo: null,
      totalRedemptionLimit: o.totalRedemptionLimit ?? null,
      perCustomerLimit: o.perCustomerLimit ?? null,
      priority: o.priority ?? 0,
      stackable: o.stackable ?? false,
      isActive: true,
      redemptionCount: o.redemptionCount ?? 0,
      createdAt: new Date('2026-01-01'),
    })) as unknown as Offer[];

    const offersRepo = { find: jest.fn().mockResolvedValue(full) } as any;
    const redemptionsRepo = { createQueryBuilder: jest.fn(() => chain) } as any;
    const itemsRepo = { find: jest.fn().mockResolvedValue(items) } as any;
    const customersRepo = { findOne: jest.fn().mockResolvedValue(null) } as any;
    const vouchersRepo = { createQueryBuilder: jest.fn(() => chain) } as any;

    return new OffersEngineService(
      offersRepo,
      redemptionsRepo,
      itemsRepo,
      customersRepo,
      vouchersRepo,
    );
  }

  const cashStatic5: Partial<Offer> = {
    type: 'PAYMENT_METHOD_DISCOUNT',
    trigger: { paymentCondition: 'CASH' },
    reward: { kind: 'LINE_PERCENT_DISCOUNT', basePercent: 5, mode: 'STATIC' },
  };

  it('applies a static % to EVERY line for a matching CASH payment', async () => {
    const engine = makeEngine([cashStatic5]);
    const res = await engine.evaluate(
      [
        { itemNumber: 'A', qty: 4 },
        { itemNumber: 'B', qty: 2 },
      ],
      { paymentMethod: 'CASH' },
    );
    const a = res.lines.find((l) => l.itemNumber === 'A')!;
    const b = res.lines.find((l) => l.itemNumber === 'B')!;
    expect(a.lineDiscountFils).toBe(200); // 4000 × 5%
    expect(b.lineDiscountFils).toBe(50); // 1000 × 5%
    expect(res.totals.lineDiscountFils).toBe(250);
    expect(res.appliedOffers).toHaveLength(1);
  });

  it('treats any non-CREDIT payment as cash, but not CREDIT', async () => {
    const engine = makeEngine([cashStatic5]);
    const cheque = await engine.evaluate([{ itemNumber: 'A', qty: 4 }], {
      paymentMethod: 'CHEQUE',
    });
    expect(cheque.appliedOffers).toHaveLength(1); // CHEQUE = cash

    const credit = await engine.evaluate([{ itemNumber: 'A', qty: 4 }], {
      paymentMethod: 'CREDIT',
    });
    expect(credit.appliedOffers).toHaveLength(0); // CREDIT excluded
  });

  it('a CREDIT offer applies only on a CREDIT payment', async () => {
    const engine = makeEngine([
      {
        type: 'PAYMENT_METHOD_DISCOUNT',
        trigger: { paymentCondition: 'CREDIT' },
        reward: { kind: 'LINE_PERCENT_DISCOUNT', basePercent: 10, mode: 'STATIC' },
      },
    ]);
    expect(
      (await engine.evaluate([{ itemNumber: 'A', qty: 1 }], { paymentMethod: 'CASH' }))
        .appliedOffers,
    ).toHaveLength(0);
    expect(
      (await engine.evaluate([{ itemNumber: 'A', qty: 1 }], { paymentMethod: 'CREDIT' }))
        .appliedOffers,
    ).toHaveLength(1);
  });

  it('respects minOrderTotal and minItemCount thresholds', async () => {
    const engine = makeEngine([
      {
        type: 'PAYMENT_METHOD_DISCOUNT',
        trigger: { paymentCondition: 'CASH', minOrderTotal: 6000, minItemCount: 5 },
        reward: { kind: 'LINE_PERCENT_DISCOUNT', basePercent: 5, mode: 'STATIC' },
      },
    ]);
    // 4×A = 4000 fils / 4 items → below both thresholds.
    expect(
      (await engine.evaluate([{ itemNumber: 'A', qty: 4 }], { paymentMethod: 'CASH' }))
        .appliedOffers,
    ).toHaveLength(0);
    // 6×A = 6000 fils / 6 items → meets both.
    expect(
      (await engine.evaluate([{ itemNumber: 'A', qty: 6 }], { paymentMethod: 'CASH' }))
        .appliedOffers,
    ).toHaveLength(1);
  });

  it('DYNAMIC discount steps up with item count and caps at maxPercent', async () => {
    const engine = makeEngine([
      {
        type: 'PAYMENT_METHOD_DISCOUNT',
        trigger: { paymentCondition: 'CASH' },
        reward: {
          kind: 'LINE_PERCENT_DISCOUNT',
          basePercent: 10,
          mode: 'DYNAMIC',
          multiplier: 0.5,
          itemsPerStep: 6,
          maxPercent: 25,
        },
      },
    ]);
    // 5 items → floor(5/6)=0 steps → 10%
    const at5 = await engine.evaluate([{ itemNumber: 'A', qty: 5 }], {
      paymentMethod: 'CASH',
    });
    expect(at5.lines[0].lineDiscountFils).toBe(500); // 5000 × 10%
    // 6 items → 1 step → 10%×1.5 = 15%
    const at6 = await engine.evaluate([{ itemNumber: 'A', qty: 6 }], {
      paymentMethod: 'CASH',
    });
    expect(at6.lines[0].lineDiscountFils).toBe(900); // 6000 × 15%
    // 30 items → 5 steps → 35% but capped at 25%
    const at30 = await engine.evaluate([{ itemNumber: 'A', qty: 30 }], {
      paymentMethod: 'CASH',
    });
    expect(at30.lines[0].lineDiscountFils).toBe(7500); // 30000 × 25% (capped)
  });

  it('a non-stackable offer ends the chain (higher priority wins alone)', async () => {
    const engine = makeEngine([
      {
        id: 'big',
        priority: 10,
        stackable: false,
        type: 'PAYMENT_METHOD_DISCOUNT',
        trigger: { paymentCondition: 'CASH' },
        reward: { kind: 'LINE_PERCENT_DISCOUNT', basePercent: 20, mode: 'STATIC' },
      },
      {
        id: 'small',
        priority: 5,
        stackable: true,
        type: 'PAYMENT_METHOD_DISCOUNT',
        trigger: { paymentCondition: 'CASH' },
        reward: { kind: 'LINE_PERCENT_DISCOUNT', basePercent: 5, mode: 'STATIC' },
      },
    ]);
    const res = await engine.evaluate([{ itemNumber: 'A', qty: 10 }], {
      paymentMethod: 'CASH',
    });
    expect(res.appliedOffers).toHaveLength(1);
    expect(res.appliedOffers[0].offerId).toBe('big');
    expect(res.totals.lineDiscountFils).toBe(2000); // 20% of 10000
  });
});
