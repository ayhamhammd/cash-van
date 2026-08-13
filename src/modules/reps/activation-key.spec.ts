import { activationKeyFor, verifyActivationKey } from './activation-key';

/**
 * The key is the whole licence. If it can be guessed, shared between salesmen,
 * or generated without the secret, the feature is decoration.
 */
describe('activation keys', () => {
  const cfg = { secret: 'vendor-secret-value' };

  it('is stable for a code — the same seat always has the same key', () => {
    expect(activationKeyFor('101', cfg)).toBe(activationKeyFor('101', cfg));
  });

  it('formats as four readable groups', () => {
    expect(activationKeyFor('101', cfg)).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
  });

  // One key must unlock ONE seat, or a client buys one and runs ten.
  it('differs per salesman', () => {
    expect(activationKeyFor('101', cfg)).not.toBe(activationKeyFor('102', cfg));
  });

  it('cannot be produced without the right secret', () => {
    const other = { secret: 'someone-elses-guess' };
    expect(activationKeyFor('101', other)).not.toBe(activationKeyFor('101', cfg));
    expect(verifyActivationKey('101', activationKeyFor('101', other), cfg)).toBe(false);
  });

  it('accepts the key however it was typed', () => {
    const key = activationKeyFor('101', cfg);
    for (const typed of [
      key,
      key.toLowerCase(),
      key.replace(/-/g, ''),
      ` ${key} `,
      key.replace(/-/g, ' '),
    ]) {
      expect(verifyActivationKey('101', typed, cfg)).toBe(true);
    }
  });

  it('rejects a key issued for a different salesman', () => {
    expect(verifyActivationKey('102', activationKeyFor('101', cfg), cfg)).toBe(false);
  });

  it('rejects empty, short and wrong keys without throwing', () => {
    for (const typed of ['', 'X', 'AAAA-AAAA-AAAA-AAAA', '----']) {
      expect(verifyActivationKey('101', typed, cfg)).toBe(false);
    }
  });

  // The code is read off a screen and retyped; case and padding must not matter.
  it('treats the salesman code case-insensitively', () => {
    expect(activationKeyFor('s101', cfg)).toBe(activationKeyFor(' S101 ', cfg));
  });

  // No I/L/O/U: a key read down a phone line must not be ambiguous.
  it('uses an unambiguous alphabet', () => {
    for (const code of ['1', '2', '3', '101', 'ABC', 'zz9']) {
      expect(activationKeyFor(code, cfg)).not.toMatch(/[ILOU]/);
    }
  });
});
