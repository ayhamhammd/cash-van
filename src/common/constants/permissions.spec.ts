import {
  PERM_DISCOUNT_APPROVAL,
  PERM_DISCOUNT_DIRECT,
  effectiveSalesmanPermKeys,
} from './permissions';

/**
 * Discounts are ungated by owner decision. The server check is gone, but the
 * mobile app decides whether to even render the discount input from these keys —
 * so this projection is what makes the policy reach ALREADY-INSTALLED builds.
 */
describe('effectiveSalesmanPermKeys', () => {
  it('grants direct discount to a salesman who was never given it', () => {
    expect(effectiveSalesmanPermKeys(['vouchers.return.create'])).toEqual([
      'vouchers.return.create',
      PERM_DISCOUNT_DIRECT,
    ]);
  });

  it('drops the approval key so the app stops routing discounts to a manager', () => {
    expect(effectiveSalesmanPermKeys([PERM_DISCOUNT_APPROVAL])).toEqual([
      PERM_DISCOUNT_DIRECT,
    ]);
  });

  it('strips a stale max-% cap, which the app would otherwise still honour', () => {
    expect(effectiveSalesmanPermKeys(['vouchers.discount.max:5'])).toEqual([
      PERM_DISCOUNT_DIRECT,
    ]);
  });

  it('does not duplicate the key when it is already present', () => {
    expect(effectiveSalesmanPermKeys([PERM_DISCOUNT_DIRECT])).toEqual([
      PERM_DISCOUNT_DIRECT,
    ]);
  });

  it.each([[null], [undefined], [[]]])('handles %s', (stored) => {
    expect(effectiveSalesmanPermKeys(stored as string[] | null)).toEqual([
      PERM_DISCOUNT_DIRECT,
    ]);
  });

  it('leaves unrelated permissions untouched and in order', () => {
    expect(
      effectiveSalesmanPermKeys([
        'vouchers.return.create',
        'vouchers.return.approval',
        'vouchers.priceOverride',
      ]),
    ).toEqual([
      'vouchers.return.create',
      'vouchers.return.approval',
      'vouchers.priceOverride',
      PERM_DISCOUNT_DIRECT,
    ]);
  });

  it('does not mutate the stored array (it is the persisted user record)', () => {
    const stored = [PERM_DISCOUNT_APPROVAL, 'vouchers.priceOverride'];
    effectiveSalesmanPermKeys(stored);
    expect(stored).toEqual([PERM_DISCOUNT_APPROVAL, 'vouchers.priceOverride']);
  });
});
