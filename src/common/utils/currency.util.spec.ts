import { filsToJod, jodToFils, roundFils } from './currency.util';

describe('currency.util', () => {
  describe('filsToJod', () => {
    it('formats whole JOD', () => {
      expect(filsToJod(1000)).toBe('1.000');
      expect(filsToJod(0)).toBe('0.000');
    });

    it('formats fractional fils', () => {
      expect(filsToJod(1234)).toBe('1.234');
      expect(filsToJod(57)).toBe('0.057');
      expect(filsToJod(7)).toBe('0.007');
    });

    it('formats negative values (credit notes)', () => {
      expect(filsToJod(-1234)).toBe('-1.234');
      expect(filsToJod(-57)).toBe('-0.057');
    });

    it('rejects non-integer input', () => {
      expect(() => filsToJod(1.5)).toThrow(TypeError);
    });
  });

  describe('jodToFils', () => {
    it('parses integer and fractional JOD', () => {
      expect(jodToFils('1.234')).toBe(1234);
      expect(jodToFils('0.057')).toBe(57);
      expect(jodToFils('100')).toBe(100_000);
      expect(jodToFils('100.5')).toBe(100_500);
    });

    it('parses negative values', () => {
      expect(jodToFils('-1.234')).toBe(-1234);
    });

    it('accepts numeric input', () => {
      expect(jodToFils(1.234)).toBe(1234);
    });

    it('rejects malformed input', () => {
      expect(() => jodToFils('abc')).toThrow(TypeError);
      expect(() => jodToFils('1.23456')).toThrow(TypeError);
    });

    it('roundtrips', () => {
      for (const fils of [0, 1, 999, 1000, 1234, -1234, 1_000_000_000]) {
        expect(jodToFils(filsToJod(fils))).toBe(fils);
      }
    });
  });

  describe('roundFils', () => {
    it('rounds half-up', () => {
      expect(roundFils(0.4)).toBe(0);
      expect(roundFils(0.5)).toBe(1);
      expect(roundFils(0.6)).toBe(1);
      expect(roundFils(1.5)).toBe(2);
      expect(roundFils(-1.5)).toBe(-1); // Math.round half-up toward +∞
    });

    it('preserves zero', () => {
      expect(roundFils(0)).toBe(0);
      expect(roundFils(-0)).toBe(0); // safeZero behavior
    });

    it('rejects non-finite', () => {
      expect(() => roundFils(NaN)).toThrow(RangeError);
      expect(() => roundFils(Infinity)).toThrow(RangeError);
    });
  });
});
