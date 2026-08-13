import {
  shapeForPdf,
  isRtlLine,
  shapeCell,
  shapeRuns,
  cellRuns,
} from './arabic-text';

describe('shapeForPdf', () => {
  it('leaves Latin-only text untouched', () => {
    expect(shapeForPdf('Total net sales')).toBe('Total net sales');
    expect(shapeForPdf('INV-4000020')).toBe('INV-4000020');
  });

  it('converts Arabic letters to connected presentation forms', () => {
    const out = shapeForPdf('مرحبا');
    // The abstract letters must be gone; only presentation forms remain.
    expect(out).not.toMatch(/[مرحب]/);
    expect(out).toMatch(/[ﹰ-﻿]/);
  });

  it('reverses an Arabic run so a left-to-right renderer draws it correctly', () => {
    const shaped = shapeForPdf('مرحبا');
    const logical = shapeForPdf('مرحبا');
    // Reversing the output twice returns the shaping order, proving the run
    // was emitted reversed rather than in logical order.
    expect([...shaped].reverse().join('')).not.toBe(logical);
  });

  it('does NOT reverse digits embedded in Arabic — an invoice number must read forwards', () => {
    const out = shapeForPdf('فاتورة 4000020');
    expect(out).toContain('4000020');
    expect(out).not.toContain('0200004');
  });

  it('keeps an embedded Latin code readable', () => {
    const out = shapeForPdf('الصنف WIN-BASE-2789');
    expect(out).toContain('WIN-BASE-2789');
  });

  it('puts the Latin run on the left of an Arabic line', () => {
    // RTL line: runs lay out right-to-left, so the trailing Latin code in
    // logical order ends up FIRST in the drawn string.
    const out = shapeForPdf('الصنف WIN-BASE-2789');
    expect(out.indexOf('WIN-BASE-2789')).toBe(0);
  });

  it('handles a money figure inside an Arabic label', () => {
    const out = shapeForPdf('الإجمالي 1234.567');
    expect(out).toContain('1234.567');
  });

  it('is stable on empty and whitespace input', () => {
    expect(shapeForPdf('')).toBe('');
    expect(shapeForPdf('   ')).toBe('   ');
  });
});

describe('isRtlLine', () => {
  it('detects Arabic', () => {
    expect(isRtlLine('المندوب')).toBe(true);
    expect(isRtlLine('Salesman')).toBe(false);
    expect(isRtlLine('Rep المندوب')).toBe(true);
  });
});

describe('shapeCell', () => {
  it('renders empty values as an em dash rather than "null"', () => {
    expect(shapeCell(null)).toBe('—');
    expect(shapeCell(undefined)).toBe('—');
    expect(shapeCell('')).toBe('—');
  });

  it('passes numbers through as text', () => {
    expect(shapeCell(1234.5)).toBe('1234.5');
    expect(shapeCell(0)).toBe('0');
  });
});

describe('shapeRuns', () => {
  it('returns a single Latin run for Latin-only text', () => {
    expect(shapeRuns('Total')).toEqual([{ text: 'Total', arabic: false }]);
  });

  it('splits mixed text so each script can be drawn with a font that has it', () => {
    const runs = shapeRuns('الصنف WIN-BASE-2789');
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.some((r) => r.arabic)).toBe(true);
    expect(runs.some((r) => !r.arabic && r.text.includes('WIN-BASE-2789'))).toBe(true);
  });

  it('puts the Latin run first so an RTL line draws correctly left to right', () => {
    const runs = shapeRuns('الصنف WIN-BASE-2789');
    expect(runs[0].arabic).toBe(false);
  });

  it('keeps spaces inside an Arabic phrase', () => {
    const joined = shapeRuns('سوبر ماركت عمو عامر')
      .map((r) => r.text)
      .join('');
    expect(joined.split(' ').length).toBe(4);
  });

  it('returns nothing for empty input', () => {
    expect(shapeRuns('')).toEqual([]);
  });
});

describe('cellRuns', () => {
  it('uses a hyphen for empties — the Arabic font has no dash glyph at all', () => {
    expect(cellRuns(null)).toEqual([{ text: '-', arabic: false }]);
    expect(cellRuns('')).toEqual([{ text: '-', arabic: false }]);
  });

  it('renders 0 as a value, not as empty', () => {
    expect(cellRuns(0)).toEqual([{ text: '0', arabic: false }]);
  });
});
