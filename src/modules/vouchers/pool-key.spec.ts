import { poolKey, POOL_KEY_SEP } from './vouchers.service';

/**
 * The stock-pool key has to survive a trip to Postgres.
 *
 * It is used twice: to aggregate demand per pool in memory, and as the argument to
 * `pg_advisory_xact_lock(hashtextextended($1, 0))`, where it travels as a bind
 * parameter. It was built with NUL as the field separator, and Postgres `text`
 * cannot represent a NUL byte, so the query was rejected outright with
 *
 *   invalid byte sequence for encoding "UTF8": 0x00
 *
 * The lock is taken BEFORE the stock check, so this failed the whole POST for every
 * voucher drawing on a van store — and the handset outbox retries forever with
 * nothing the rep can see, so offline sales simply stopped arriving.
 *
 * These are cheap assertions about a one-line helper, and they exist because the
 * bug was invisible in review: a NUL escape reads like any other separator.
 */
describe('poolKey', () => {
  const NUL = '\u0000';
  /** The Arabic base-unit code, as it arrives on a real line. */
  const BASE_UNIT = '\u062d\u0628\u0629';

  it('never contains a NUL, which Postgres text cannot carry', () => {
    // The shape of the payload that first failed: van store, numeric item number,
    // Arabic base-unit code.
    expect(poolKey('1', '132', BASE_UNIT)).not.toContain(NUL);
  });

  it('has no NUL even when a field is missing', () => {
    // The BASE unit has no item_units row, so stockUnitCode arrives empty or
    // undefined. Empty fields still have to produce a legal key.
    expect(poolKey('1', '132', '')).not.toContain(NUL);
    expect(poolKey('1', '132', undefined)).not.toContain(NUL);
    expect(poolKey(null, undefined, '')).not.toContain(NUL);
  });

  it('keeps different pools apart', () => {
    // Two units of one item in one store are different goods drawing on different
    // pools — red and blue — and must not collide on a single lock.
    expect(poolKey('1', '132', 'RED')).not.toEqual(poolKey('1', '132', 'BLUE'));
    expect(poolKey('1', '132', '')).not.toEqual(poolKey('2', '132', ''));
  });

  it('cannot let adjacent fields run together and alias two pools', () => {
    // The whole reason for a control-character separator: ('12', '3') and
    // ('1', '23') must not both render as "123".
    expect(poolKey('12', '3')).not.toEqual(poolKey('1', '23'));
  });

  it('is stable, so concurrent transactions contend on the same key', () => {
    expect(poolKey('1', '132', BASE_UNIT)).toEqual(poolKey('1', '132', BASE_UNIT));
  });

  it('separates with Unit Separator rather than NUL', () => {
    expect(POOL_KEY_SEP).toBe('\u001f');
    expect(poolKey('a', 'b')).toBe(`a${POOL_KEY_SEP}b`);
  });
});
