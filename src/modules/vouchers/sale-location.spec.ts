import { saleLocationOf } from './vouchers.service';

/**
 * The rep's position is stored as a PAIR or not at all.
 *
 * Storing one half would put a marker on the equator or the prime meridian — a
 * confident-looking point in the Gulf of Guinea — which is worse than no point,
 * because nothing about it looks like missing data.
 *
 * Coordinate ranges are CreateVoucherDto's job (@Min/@Max); this only decides
 * pair-or-nothing.
 */
describe('saleLocationOf', () => {
  it('keeps a complete fix', () => {
    expect(saleLocationOf({ repLat: 31.951569, repLng: 35.923963 })).toEqual({
      saleLat: 31.951569,
      saleLng: 35.923963,
    });
  });

  it('keeps a genuine zero — 0,0 is a coordinate, not a missing value', () => {
    expect(saleLocationOf({ repLat: 0, repLng: 0 })).toEqual({
      saleLat: 0,
      saleLng: 0,
    });
  });

  it.each([
    ['lat only', { repLat: 31.95 }],
    ['lng only', { repLng: 35.92 }],
    ['neither', {}],
    ['null pair', { repLat: null, repLng: null }],
    ['half null', { repLat: 31.95, repLng: null }],
    ['NaN', { repLat: Number.NaN, repLng: 35.92 }],
    ['Infinity', { repLat: 31.95, repLng: Number.POSITIVE_INFINITY }],
  ])('drops a partial or unusable fix (%s)', (_label, dto) => {
    expect(saleLocationOf(dto)).toEqual({ saleLat: null, saleLng: null });
  });
});
