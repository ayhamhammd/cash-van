/**
 * Money representation across VanFlow:
 *   - Canonical: INTEGER fils (Jordanian minor units). 1 JOD = 1000 fils.
 *   - JoFotara payloads: '1.234' JOD strings with exactly 3 decimal places.
 *
 * Conversion happens ONLY at the JoFotara boundary. The DB and service
 * layer use fils throughout.
 */

const FILS_PER_JOD = 1000;
const MAX_SAFE_FILS = Number.MAX_SAFE_INTEGER;

/** Half-up integer rounding. Matches the spec's `Math.round(value * 1000) / 1000` semantics. */
export function roundFils(n: number): number {
  if (!Number.isFinite(n)) {
    throw new RangeError(`roundFils: non-finite input ${n}`);
  }
  const rounded = Math.round(n);
  if (Math.abs(rounded) > MAX_SAFE_FILS) {
    throw new RangeError(`roundFils: overflow at ${n}`);
  }
  return rounded === 0 ? 0 : rounded;
}

/** 1234 → '1.234'  ·  0 → '0.000'  ·  -1234 → '-1.234' */
export function filsToJod(fils: number): string {
  if (!Number.isInteger(fils)) {
    throw new TypeError(`filsToJod: expected integer fils, got ${fils}`);
  }
  const negative = fils < 0;
  const abs = Math.abs(fils);
  const whole = Math.trunc(abs / FILS_PER_JOD);
  const remainder = abs - whole * FILS_PER_JOD;
  const fractional = remainder.toString().padStart(3, '0');
  return `${negative ? '-' : ''}${whole}.${fractional}`;
}

/** '1.234' or 1.234 → 1234. Throws on bad input or overflow. */
export function jodToFils(jod: string | number): number {
  const str = typeof jod === 'number' ? jod.toString() : jod.trim();
  if (!/^-?\d+(\.\d{0,3})?$/.test(str)) {
    throw new TypeError(`jodToFils: invalid JOD value "${jod}"`);
  }
  const [whole, frac = ''] = str.split('.');
  const fracPadded = frac.padEnd(3, '0');
  const sign = whole.startsWith('-') ? -1 : 1;
  const wholeAbs = whole.replace('-', '');
  const fils = sign * (Number(wholeAbs) * FILS_PER_JOD + Number(fracPadded));
  if (!Number.isFinite(fils) || Math.abs(fils) > MAX_SAFE_FILS) {
    throw new RangeError(`jodToFils: overflow for "${jod}"`);
  }
  return fils;
}
