import { BadRequestException } from '@nestjs/common';
import { validateRules, rulesNeedAiJoin } from './segment-rules';

describe('segment-rules validateRules', () => {
  it('accepts a valid rule and defaults match to ALL', () => {
    const r = validateRules({
      conditions: [{ field: 'category', op: 'eq', value: 'retail' }],
    });
    expect(r.match).toBe('ALL');
    expect(r.conditions).toHaveLength(1);
    expect(r.conditions[0]).toEqual({ field: 'category', op: 'eq', value: 'retail' });
  });

  it('keeps ANY when asked', () => {
    expect(validateRules({ match: 'ANY', conditions: [] }).match).toBe('ANY');
  });

  it('rejects an unknown field', () => {
    expect(() =>
      validateRules({ conditions: [{ field: 'password', op: 'eq', value: 'x' }] }),
    ).toThrow(BadRequestException);
  });

  it('rejects an operator not allowed for the field type', () => {
    // gt on a text field
    expect(() =>
      validateRules({ conditions: [{ field: 'category', op: 'gt', value: 'x' }] }),
    ).toThrow(BadRequestException);
    // contains on a bool field
    expect(() =>
      validateRules({ conditions: [{ field: 'creditHold', op: 'contains', value: 'x' }] }),
    ).toThrow(BadRequestException);
  });

  it('requires a value for value-taking ops and forbids empty IN arrays', () => {
    expect(() =>
      validateRules({ conditions: [{ field: 'category', op: 'eq' }] }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateRules({ conditions: [{ field: 'category', op: 'in', value: [] }] }),
    ).toThrow(BadRequestException);
  });

  it('accepts value-less ops (is_null / not_null)', () => {
    const r = validateRules({
      conditions: [{ field: 'repId', op: 'is_null' }],
    });
    expect(r.conditions[0]).toEqual({ field: 'repId', op: 'is_null' });
  });

  it('coerces types and rejects mismatches', () => {
    expect(validateRules({ conditions: [{ field: 'creditHold', op: 'eq', value: true }] }).conditions[0].value).toBe(true);
    expect(() =>
      validateRules({ conditions: [{ field: 'creditHold', op: 'eq', value: 'yes' }] }),
    ).toThrow(BadRequestException);
    expect(validateRules({ conditions: [{ field: 'totalDebt', op: 'gt', value: '100' }] }).conditions[0].value).toBe(100);
    expect(() =>
      validateRules({ conditions: [{ field: 'totalDebt', op: 'gt', value: 'abc' }] }),
    ).toThrow(BadRequestException);
  });

  it('rejects malformed date and uuid values, and empty numbers/dates', () => {
    expect(() =>
      validateRules({ conditions: [{ field: 'createdAt', op: 'before', value: '2024-13-01' }] }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateRules({ conditions: [{ field: 'createdAt', op: 'before', value: '' }] }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateRules({ conditions: [{ field: 'regionId', op: 'eq', value: 'north' }] }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateRules({ conditions: [{ field: 'totalDebt', op: 'gt', value: '' }] }),
    ).toThrow(BadRequestException);
    // …but well-formed date + uuid pass.
    expect(
      validateRules({ conditions: [{ field: 'createdAt', op: 'after', value: '2026-01-01' }] })
        .conditions[0].value,
    ).toBe('2026-01-01');
    expect(
      validateRules({
        conditions: [
          { field: 'regionId', op: 'eq', value: '11111111-2222-3333-4444-555555555555' },
        ],
      }).conditions[0].value,
    ).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('caps the number of conditions', () => {
    const many = Array.from({ length: 21 }, () => ({ field: 'category', op: 'eq', value: 'x' }));
    expect(() => validateRules({ conditions: many })).toThrow(BadRequestException);
  });

  it('flags when an AI-profile join is needed', () => {
    expect(
      rulesNeedAiJoin(validateRules({ conditions: [{ field: 'churnRisk', op: 'eq', value: 'high_risk' }] })),
    ).toBe(true);
    expect(
      rulesNeedAiJoin(validateRules({ conditions: [{ field: 'category', op: 'eq', value: 'retail' }] })),
    ).toBe(false);
  });
});
