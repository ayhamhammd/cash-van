import { OffersEngineService } from './offers-engine.service';
import type { Offer } from './entities/offer.entity';

/**
 * Pure-ish unit tests for the discount engine. Repositories are mocked so the
 * tests exercise the math/stacking, not the DB.
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
      type: o.type,
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

  it('ITEM_QTY_DISCOUNT applies a percent discount to the trigger line', async () => {
    const engine = makeEngine([
      {
        type: 'ITEM_QTY_DISCOUNT',
        trigger: { itemNumber: 'A', minQty: 3 },
        reward: { kind: 'DISCOUNT', discountType: 'PERCENT', value: 10, appliesTo: 'TRIGGER_ITEM' },
      },
    ]);

    const res = await engine.evaluate([{ itemNumber: 'A', qty: 5 }]);

    expect(res.totals.subtotalFils).toBe(5000);
    expect(res.lines[0].lineDiscountFils).toBe(500);
    expect(res.totals.grandTotalFils).toBe(4500);
    expect(res.appliedOffers).toHaveLength(1);
  });

  it('does not apply ITEM_QTY_DISCOUNT below the min qty', async () => {
    const engine = makeEngine([
      {
        type: 'ITEM_QTY_DISCOUNT',
        trigger: { itemNumber: 'A', minQty: 6 },
        reward: { kind: 'DISCOUNT', discountType: 'PERCENT', value: 10, appliesTo: 'TRIGGER_ITEM' },
      },
    ]);

    const res = await engine.evaluate([{ itemNumber: 'A', qty: 5 }]);

    expect(res.appliedOffers).toHaveLength(0);
    expect(res.totals.grandTotalFils).toBe(5000);
  });

  it('BUY_X_GET_Y_FREE grants free lines in multiples', async () => {
    const engine = makeEngine([
      {
        type: 'BUY_X_GET_Y_FREE',
        trigger: { itemNumber: 'A', qty: 6 },
        reward: { kind: 'FREE_ITEM', items: [{ itemNumber: 'B', qty: 1 }] },
      },
    ]);

    const res = await engine.evaluate([{ itemNumber: 'A', qty: 12 }]);

    expect(res.freeLines).toHaveLength(1);
    expect(res.freeLines[0]).toMatchObject({ itemNumber: 'B', qty: 2, unitPriceFils: 500 });
    // Free lines don't change the cart grand total (they net to zero on the invoice).
    expect(res.totals.grandTotalFils).toBe(12000);
  });

  it('BASKET_THRESHOLD applies a fixed invoice discount', async () => {
    const engine = makeEngine([
      {
        type: 'BASKET_THRESHOLD',
        trigger: { itemNumbers: ['A', 'B'], minItemCount: 5 },
        reward: { kind: 'DISCOUNT', discountType: 'VALUE', value: 1000, appliesTo: 'INVOICE' },
      },
    ]);

    const res = await engine.evaluate([
      { itemNumber: 'A', qty: 3 },
      { itemNumber: 'B', qty: 3 },
    ]);

    expect(res.invoiceDiscountFils).toBe(1000);
    expect(res.totals.subtotalFils).toBe(4500);
    expect(res.totals.grandTotalFils).toBe(3500);
  });

  it('a non-stackable offer ends the chain (higher priority wins alone)', async () => {
    const engine = makeEngine([
      {
        id: 'big',
        priority: 10,
        stackable: false,
        type: 'ITEM_QTY_DISCOUNT',
        trigger: { itemNumber: 'A', minQty: 1 },
        reward: { kind: 'DISCOUNT', discountType: 'PERCENT', value: 20, appliesTo: 'TRIGGER_ITEM' },
      },
      {
        id: 'small',
        priority: 5,
        stackable: true,
        type: 'ITEM_QTY_DISCOUNT',
        trigger: { itemNumber: 'A', minQty: 1 },
        reward: { kind: 'DISCOUNT', discountType: 'PERCENT', value: 5, appliesTo: 'TRIGGER_ITEM' },
      },
    ]);

    const res = await engine.evaluate([{ itemNumber: 'A', qty: 10 }]);

    expect(res.appliedOffers).toHaveLength(1);
    expect(res.appliedOffers[0].offerId).toBe('big');
    expect(res.totals.lineDiscountFils).toBe(2000); // 20% of 10000, small offer skipped
  });
});
