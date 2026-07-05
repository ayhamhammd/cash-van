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

  function makeEngine(
    offers: Partial<Offer>[],
    taxCalcMethod: 'INCLUSIVE' | 'EXCLUSIVE' = 'EXCLUSIVE',
    itemList: typeof items = items,
  ): OffersEngineService {
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
    const itemsRepo = { find: jest.fn().mockResolvedValue(itemList) } as any;
    const customersRepo = { findOne: jest.fn().mockResolvedValue(null) } as any;
    const vouchersRepo = { createQueryBuilder: jest.fn(() => chain) } as any;
    const settingsRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 1, taxCalcMethod }),
    } as any;

    return new OffersEngineService(
      offersRepo,
      redemptionsRepo,
      itemsRepo,
      customersRepo,
      vouchersRepo,
      settingsRepo,
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

  it('honours the company tax mode: INCLUSIVE extracts tax, EXCLUSIVE adds it on top', async () => {
    // One unit at 1150 fils, 15% tax.
    const taxed = [
      { itemNumber: 'A', price: 1150, taxPercentage: '15', name: 'A', nameEn: 'A' },
    ];
    const line = [{ itemNumber: 'A', qty: 1 }];

    // INCLUSIVE: 1150 already includes tax → net stays 1150, tax extracted = 150.
    const inc = await makeEngine([], 'INCLUSIVE', taxed).evaluate(line, {});
    expect(inc.totals.taxFils).toBe(150);
    expect(inc.totals.grandTotalFils).toBe(1150);

    // EXCLUSIVE: tax added on top → 1150 + round(172.5)=173.
    const exc = await makeEngine([], 'EXCLUSIVE', taxed).evaluate(line, {});
    expect(exc.totals.taxFils).toBe(173);
    expect(exc.totals.grandTotalFils).toBe(1323);
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

  it('DYNAMIC anchors the base at minItemCount — base rate at the threshold, +step above', async () => {
    const engine = makeEngine([
      {
        type: 'PAYMENT_METHOD_DISCOUNT',
        trigger: { paymentCondition: 'CASH', minItemCount: 10 },
        reward: {
          kind: 'LINE_PERCENT_DISCOUNT',
          basePercent: 3,
          mode: 'DYNAMIC',
          multiplier: 1,
          itemsPerStep: 10,
        },
      },
    ]);
    const pct = async (q: number) =>
      (await engine.evaluate([{ itemNumber: 'A', qty: q }], { paymentMethod: 'CASH' }))
        .lines[0]?.lineDiscountFils ?? 0;
    expect(await pct(10)).toBe(300); // 10 items = threshold → base 3% (NOT 6%)
    expect(await pct(19)).toBe(570); // still in the first block → 3%
    expect(await pct(20)).toBe(1200); // 1 step above → 6%
    expect(await pct(30)).toBe(2700); // 2 steps above → 9%
  });

  /* ----------------------- ITEM_QTY_REWARD ------------------------------ */

  it('ITEM_QTY_REWARD gift surfaces a choice and resolves the rep picks to free lines', async () => {
    const offer: Partial<Offer> = {
      type: 'ITEM_QTY_REWARD',
      trigger: { itemNumbers: ['A'] },
      reward: { kind: 'GIFT', giftItems: ['B'], itemsPerGift: 10 },
    };
    // 22× A → floor(22/10) = 2 gifts; no picks yet → only a choice is surfaced.
    const choiceOnly = await makeEngine([offer]).evaluate([
      { itemNumber: 'A', qty: 22 },
    ]);
    expect(choiceOnly.appliedOffers[0]?.freeItemChoice).toEqual({
      choices: ['B'],
      qty: 2,
    });
    expect(choiceOnly.freeLines).toHaveLength(0);

    // With the rep's pick, B is resolved as a free line (capped at freeQty=2).
    const picked = await makeEngine([offer]).evaluate(
      [{ itemNumber: 'A', qty: 22 }],
      { chosenFreeItems: ['B', 'B', 'B'] },
    );
    expect(picked.freeLines).toEqual([
      { itemNumber: 'B', qty: 1, unitPriceFils: 500, offerId: picked.appliedOffers[0]!.offerId },
      { itemNumber: 'B', qty: 1, unitPriceFils: 500, offerId: picked.appliedOffers[0]!.offerId },
    ]);
  });

  it('ITEM_QTY_REWARD gift = 1 per itemsPerGift bought, capped, none below the first', async () => {
    const offer: Partial<Offer> = {
      type: 'ITEM_QTY_REWARD',
      trigger: { itemNumbers: ['A'] },
      reward: { kind: 'GIFT', giftItems: ['B'], itemsPerGift: 10, maxFreeQty: 5 },
    };
    const free = async (q: number) =>
      (await makeEngine([offer]).evaluate([{ itemNumber: 'A', qty: q }]))
        .appliedOffers[0]?.freeItemChoice?.qty;
    expect(await free(14)).toBe(1); // floor(14/10)
    expect(await free(20)).toBe(2);
    expect(await free(1000)).toBe(5); // floor(1000/10)=100 capped at 5
    expect(
      (await makeEngine([offer]).evaluate([{ itemNumber: 'A', qty: 9 }]))
        .appliedOffers,
    ).toHaveLength(0); // below itemsPerGift → nothing
  });

  it('ITEM_QTY_REWARD gift grants giftsPerStep gifts per step (buy 10 → 3)', async () => {
    const offer: Partial<Offer> = {
      type: 'ITEM_QTY_REWARD',
      trigger: { itemNumbers: ['A'] },
      reward: { kind: 'GIFT', giftItems: ['B', 'C'], itemsPerGift: 10, giftsPerStep: 3 },
    };
    const free = async (q: number) =>
      (await makeEngine([offer]).evaluate([{ itemNumber: 'A', qty: q }]))
        .appliedOffers[0]?.freeItemChoice?.qty;
    expect(await free(10)).toBe(3); // 1 step × 3
    expect(await free(20)).toBe(6); // 2 steps × 3
    expect(await free(9)).toBeUndefined(); // below the first step → no offer
  });

  it('ITEM_QTY_REWARD gift respects maxFreeQty with giftsPerStep', async () => {
    const offer: Partial<Offer> = {
      type: 'ITEM_QTY_REWARD',
      trigger: { itemNumbers: ['A'] },
      reward: { kind: 'GIFT', giftItems: ['B'], itemsPerGift: 10, giftsPerStep: 3, maxFreeQty: 3 },
    };
    const free = async (q: number) =>
      (await makeEngine([offer]).evaluate([{ itemNumber: 'A', qty: q }]))
        .appliedOffers[0]?.freeItemChoice?.qty;
    expect(await free(10)).toBe(3); // 3, at cap
    expect(await free(50)).toBe(3); // 5 steps × 3 = 15, capped at 3
  });

  it('ITEM_QTY_REWARD discount applies % to the selected items only, above minQty', async () => {
    const offer: Partial<Offer> = {
      type: 'ITEM_QTY_REWARD',
      trigger: { itemNumbers: ['A'] },
      reward: { kind: 'ITEM_PERCENT_DISCOUNT', minQty: 12, basePercent: 10, mode: 'STATIC' },
    };
    // 12× A (12000) + 5× B (untouched). A line gets 10% = 1200; B gets 0.
    const res = await makeEngine([offer]).evaluate([
      { itemNumber: 'A', qty: 12 },
      { itemNumber: 'B', qty: 5 },
    ]);
    expect(res.lines.find((l) => l.itemNumber === 'A')!.lineDiscountFils).toBe(1200);
    expect(res.lines.find((l) => l.itemNumber === 'B')!.lineDiscountFils).toBe(0);
    // 11× A → below minQty → nothing.
    expect(
      (await makeEngine([offer]).evaluate([{ itemNumber: 'A', qty: 11 }])).appliedOffers,
    ).toHaveLength(0);
  });

  it('ITEM_QTY_REWARD counts the COMBINED qty of selected items', async () => {
    const offer: Partial<Offer> = {
      type: 'ITEM_QTY_REWARD',
      trigger: { itemNumbers: ['A', 'B'] },
      reward: { kind: 'ITEM_PERCENT_DISCOUNT', minQty: 10, basePercent: 10, mode: 'STATIC' },
    };
    // 6× A + 5× B = 11 ≥ 10 → both A and B lines discounted 10%.
    const res = await makeEngine([offer]).evaluate([
      { itemNumber: 'A', qty: 6 },
      { itemNumber: 'B', qty: 5 },
    ]);
    expect(res.lines.find((l) => l.itemNumber === 'A')!.lineDiscountFils).toBe(600);
    expect(res.lines.find((l) => l.itemNumber === 'B')!.lineDiscountFils).toBe(250);
  });

  it('ITEM_AMOUNT_DISCOUNT takes a flat amount off EACH UNIT of the selected items, above minQty', async () => {
    const offer: Partial<Offer> = {
      type: 'ITEM_QTY_REWARD',
      trigger: { itemNumbers: ['A'] },
      reward: { kind: 'ITEM_AMOUNT_DISCOUNT', minQty: 12, baseAmountFils: 200, mode: 'STATIC' },
    };
    // 12× A → 200 off each unit → 2400; B untouched.
    const res = await makeEngine([offer]).evaluate([
      { itemNumber: 'A', qty: 12 },
      { itemNumber: 'B', qty: 5 },
    ]);
    expect(res.lines.find((l) => l.itemNumber === 'A')!.lineDiscountFils).toBe(2400);
    expect(res.lines.find((l) => l.itemNumber === 'B')!.lineDiscountFils).toBe(0);
    // 11× A → below minQty → nothing.
    expect(
      (await makeEngine([offer]).evaluate([{ itemNumber: 'A', qty: 11 }])).appliedOffers,
    ).toHaveLength(0);
  });

  it('ITEM_AMOUNT_DISCOUNT clamps the per-line discount to the line gross', async () => {
    const offer: Partial<Offer> = {
      type: 'ITEM_QTY_REWARD',
      trigger: { itemNumbers: ['A'] },
      // 2000 off each unit, but A is only 1000 → never below zero.
      reward: { kind: 'ITEM_AMOUNT_DISCOUNT', minQty: 1, baseAmountFils: 2000, mode: 'STATIC' },
    };
    const res = await makeEngine([offer]).evaluate([{ itemNumber: 'A', qty: 3 }]);
    expect(res.lines[0].lineDiscountFils).toBe(3000); // gross, not 6000
    expect(res.lines[0].lineNetFils).toBe(0);
  });

  it('ITEM_AMOUNT_DISCOUNT DYNAMIC steps the per-unit amount and caps at maxAmountFils', async () => {
    const offer: Partial<Offer> = {
      type: 'ITEM_QTY_REWARD',
      trigger: { itemNumbers: ['A'] },
      reward: {
        kind: 'ITEM_AMOUNT_DISCOUNT',
        minQty: 12,
        baseAmountFils: 100,
        mode: 'DYNAMIC',
        multiplier: 0.5,
        itemsPerStep: 6,
        maxAmountFils: 250,
      },
    };
    const disc = async (q: number) =>
      (await makeEngine([offer]).evaluate([{ itemNumber: 'A', qty: q }])).lines[0]?.lineDiscountFils ?? 0;
    expect(await disc(12)).toBe(1200); // threshold → 100/unit × 12
    expect(await disc(18)).toBe(2700); // 1 step → 150/unit × 18
    expect(await disc(60)).toBe(15000); // 8 steps → 500 capped at 250/unit × 60
  });

  it('an amount and a percent item offer on the same item → the higher fils wins', async () => {
    const engine = makeEngine([
      {
        id: 'amt',
        type: 'ITEM_QTY_REWARD',
        trigger: { itemNumbers: ['A'] },
        reward: { kind: 'ITEM_AMOUNT_DISCOUNT', minQty: 1, baseAmountFils: 300, mode: 'STATIC' },
      },
      {
        id: 'pct',
        type: 'ITEM_QTY_REWARD',
        trigger: { itemNumbers: ['A'] },
        reward: { kind: 'ITEM_PERCENT_DISCOUNT', minQty: 1, basePercent: 10, mode: 'STATIC' },
      },
    ]);
    // A = 1000: 300/unit (amount) beats 100/unit (10%).
    const res = await engine.evaluate([{ itemNumber: 'A', qty: 4 }]);
    expect(res.lines[0].lineDiscountFils).toBe(1200); // 300 × 4
    expect(res.appliedOffers.map((o) => o.offerId)).toEqual(['amt']);
  });

  /* ------------------- PAYMENT_METHOD_DISCOUNT (amount) ------------------ */

  it('LINE_AMOUNT_DISCOUNT takes a fixed amount off EACH UNIT on every line for a matching CASH payment', async () => {
    const engine = makeEngine([
      {
        type: 'PAYMENT_METHOD_DISCOUNT',
        trigger: { paymentCondition: 'CASH' },
        reward: { kind: 'LINE_AMOUNT_DISCOUNT', baseAmountFils: 300, mode: 'STATIC' },
      },
    ]);
    // 300 off each UNIT → × line qty, on every line.
    const res = await engine.evaluate(
      [
        { itemNumber: 'A', qty: 4 },
        { itemNumber: 'B', qty: 2 },
      ],
      { paymentMethod: 'CASH' },
    );
    expect(res.lines.find((l) => l.itemNumber === 'A')!.lineDiscountFils).toBe(1200); // 300 × 4
    expect(res.lines.find((l) => l.itemNumber === 'B')!.lineDiscountFils).toBe(600); // 300 × 2
    expect(res.totals.lineDiscountFils).toBe(1800);
  });

  it('LINE_AMOUNT_DISCOUNT clamps the per-line discount to the line gross', async () => {
    const engine = makeEngine([
      {
        type: 'PAYMENT_METHOD_DISCOUNT',
        trigger: { paymentCondition: 'CASH' },
        reward: { kind: 'LINE_AMOUNT_DISCOUNT', baseAmountFils: 2000, mode: 'STATIC' },
      },
    ]);
    // 2000/unit × 1 exceeds each line's gross → clamped. A gross = 1000, B gross = 500.
    const res = await engine.evaluate(
      [
        { itemNumber: 'A', qty: 1 },
        { itemNumber: 'B', qty: 1 },
      ],
      { paymentMethod: 'CASH' },
    );
    expect(res.lines.find((l) => l.itemNumber === 'A')!.lineDiscountFils).toBe(1000);
    expect(res.lines.find((l) => l.itemNumber === 'B')!.lineDiscountFils).toBe(500);
  });

  it('LINE_AMOUNT_DISCOUNT DYNAMIC steps the per-unit amount and caps at maxAmountFils', async () => {
    const engine = makeEngine([
      {
        type: 'PAYMENT_METHOD_DISCOUNT',
        trigger: { paymentCondition: 'CASH', minItemCount: 6 },
        reward: {
          kind: 'LINE_AMOUNT_DISCOUNT',
          baseAmountFils: 100,
          mode: 'DYNAMIC',
          multiplier: 0.5,
          itemsPerStep: 6,
          maxAmountFils: 250,
        },
      },
    ]);
    // Per-unit amount steps with item count, then × line qty (A unit = 1000, no clamp).
    const disc = async (q: number) =>
      (await engine.evaluate([{ itemNumber: 'A', qty: q }], { paymentMethod: 'CASH' }))
        .lines[0]?.lineDiscountFils ?? 0;
    expect(await disc(6)).toBe(600); // per-unit 100 × 6 units
    expect(await disc(12)).toBe(1800); // 1 step → per-unit 150 × 12 units
    expect(await disc(60)).toBe(15000); // per-unit capped 250 × 60 units
  });

  it('per line, the higher fils wins between a percent and a per-unit amount payment offer', async () => {
    const engine = makeEngine([
      {
        id: 'pct10',
        type: 'PAYMENT_METHOD_DISCOUNT',
        trigger: { paymentCondition: 'CASH' },
        reward: { kind: 'LINE_PERCENT_DISCOUNT', basePercent: 10, mode: 'STATIC' },
      },
      {
        id: 'amt80',
        type: 'PAYMENT_METHOD_DISCOUNT',
        trigger: { paymentCondition: 'CASH' },
        reward: { kind: 'LINE_AMOUNT_DISCOUNT', baseAmountFils: 80, mode: 'STATIC' },
      },
    ]);
    // A qty4 gross 4000: 10% = 400 beats amount 80×4 = 320. B qty1 gross 500: amount 80 beats 10% = 50.
    const res = await engine.evaluate(
      [
        { itemNumber: 'A', qty: 4 },
        { itemNumber: 'B', qty: 1 },
      ],
      { paymentMethod: 'CASH' },
    );
    expect(res.lines.find((l) => l.itemNumber === 'A')!.lineDiscountFils).toBe(400);
    expect(res.lines.find((l) => l.itemNumber === 'B')!.lineDiscountFils).toBe(80);
    expect(res.appliedOffers.map((o) => o.offerId).sort()).toEqual(['amt80', 'pct10']);
  });

  /* ---------------- conflict resolution (max within, sum across) ---------- */

  it('two payment-method offers conflict → only the HIGHEST % applies', async () => {
    const engine = makeEngine([
      {
        id: 'big',
        type: 'PAYMENT_METHOD_DISCOUNT',
        trigger: { paymentCondition: 'CASH' },
        reward: { kind: 'LINE_PERCENT_DISCOUNT', basePercent: 20, mode: 'STATIC' },
      },
      {
        id: 'small',
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
    expect(res.totals.lineDiscountFils).toBe(2000); // 20% of 10000, the 5% is dropped
  });

  it('two item offers on the same item → only the HIGHEST % applies', async () => {
    const engine = makeEngine([
      {
        id: 'i8',
        type: 'ITEM_QTY_REWARD',
        trigger: { itemNumbers: ['A'] },
        reward: { kind: 'ITEM_PERCENT_DISCOUNT', minQty: 1, basePercent: 8, mode: 'STATIC' },
      },
      {
        id: 'i3',
        type: 'ITEM_QTY_REWARD',
        trigger: { itemNumbers: ['A'] },
        reward: { kind: 'ITEM_PERCENT_DISCOUNT', minQty: 1, basePercent: 3, mode: 'STATIC' },
      },
    ]);
    const res = await engine.evaluate([{ itemNumber: 'A', qty: 10 }]);
    expect(res.lines[0].lineDiscountFils).toBe(800); // 8% of 10000, not 11%
    expect(res.appliedOffers.map((o) => o.offerId)).toEqual(['i8']);
  });

  it('payment-method + item discount on the same line ADD together', async () => {
    const engine = makeEngine([
      {
        id: 'pay10',
        type: 'PAYMENT_METHOD_DISCOUNT',
        trigger: { paymentCondition: 'CASH' },
        reward: { kind: 'LINE_PERCENT_DISCOUNT', basePercent: 10, mode: 'STATIC' },
      },
      {
        id: 'item5',
        type: 'ITEM_QTY_REWARD',
        trigger: { itemNumbers: ['A'] },
        reward: { kind: 'ITEM_PERCENT_DISCOUNT', minQty: 1, basePercent: 5, mode: 'STATIC' },
      },
    ]);
    // A is covered by both (10% + 5% = 15%); B only by payment (10%).
    const res = await engine.evaluate(
      [
        { itemNumber: 'A', qty: 10 },
        { itemNumber: 'B', qty: 10 },
      ],
      { paymentMethod: 'CASH' },
    );
    expect(res.lines.find((l) => l.itemNumber === 'A')!.lineDiscountFils).toBe(1500); // 15% of 10000
    expect(res.lines.find((l) => l.itemNumber === 'B')!.lineDiscountFils).toBe(500); // 10% of 5000
    expect(res.appliedOffers.map((o) => o.offerId).sort()).toEqual(['item5', 'pay10']);
    // Per-line attribution: A carries both contributing offers; B only the payment one.
    const aLine = res.lines.find((l) => l.itemNumber === 'A')!;
    expect(aLine.offers.map((o) => ({ offerId: o.offerId, pct: o.pct, discountFils: o.discountFils })).sort((x, y) => x.offerId.localeCompare(y.offerId))).toEqual([
      { offerId: 'item5', pct: 5, discountFils: 500 },
      { offerId: 'pay10', pct: 10, discountFils: 1000 },
    ]);
    expect(res.lines.find((l) => l.itemNumber === 'B')!.offers).toEqual([
      { offerId: 'pay10', name: expect.any(String), pct: 10, discountFils: 500 },
    ]);
  });
});
