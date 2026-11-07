import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Money } from '../src/money.js';

const amount = fc
  .tuple(fc.integer({ min: -999_999_999, max: 999_999_999 }), fc.integer({ min: 0, max: 9999 }))
  .map(([i, f]) => Money.of(`${i}.${String(f).padStart(4, '0')}`));

describe('Money', () => {
  it('is exact where floats are not', () => {
    expect(Money.of('0.1').add('0.2').eq('0.3')).toBe(true);
    expect(Money.of('0.1').add('0.2').toString()).toBe('0.3');
  });

  it('refuses numbers in every form', () => {
    // @ts-expect-error numbers are not accepted
    expect(() => Money.of(1.5)).toThrow(TypeError);
    // @ts-expect-error numbers are not accepted
    expect(() => Money.of(1).add(2)).toThrow(TypeError);
    expect(() => Money.of('1e3x')).toThrow(TypeError);
    expect(() => Money.of('NaN')).toThrow(TypeError);
    expect(() => Money.of('Infinity')).toThrow(TypeError);
    expect(() => Money.of('')).toThrow(TypeError);
  });

  it('cannot be coerced to a number', () => {
    const m = Money.of('5');
    expect(() => +(m as unknown as number)).toThrow(TypeError);
    expect(() => (m as unknown as number) < 1).toThrow(TypeError);
    expect(() => Number(m)).toThrow(TypeError);
    expect(`${m}`).toBe('5');
  });

  it('serializes to JSON as a string', () => {
    expect(JSON.stringify({ a: Money.of('12.50') })).toBe('{"a":"12.5"}');
  });

  it('writes NUMERIC(19,4) strings and refuses silent rounding', () => {
    expect(Money.of('12.5').toDbString()).toBe('12.5000');
    expect(() => Money.of('1.23456').toDbString()).toThrow(RangeError);
    expect(Money.of('1.23456').round().toDbString()).toBe('1.2346');
    expect(() => Money.of('1000000000000000').toDbString()).toThrow(RangeError);
    expect(Money.of('999999999999999.9999').toDbString()).toBe('999999999999999.9999');
  });

  it('rounds half up, away from zero, to the requested places', () => {
    expect(Money.of('2.5').round(0).toString()).toBe('3');
    expect(Money.of('-2.5').round(0).toString()).toBe('-3');
    expect(Money.of('1.00005').round(4).toString()).toBe('1.0001');
  });

  it.each([
    ['half_up', ['1.005', '1.01'], ['1.015', '1.02'], ['-1.005', '-1.01'], ['2.004', '2.00']],
    ['half_even', ['1.005', '1.00'], ['1.015', '1.02'], ['-1.005', '-1.00'], ['2.006', '2.01']],
    ['down', ['1.009', '1.00'], ['-1.009', '-1.00'], ['1.000', '1.00']],
    ['up', ['1.001', '1.01'], ['-1.001', '-1.01'], ['1.000', '1.00']],
  ] as const)('rounds to the minor unit in mode %s (D17)', (mode, ...cases) => {
    for (const c of cases as readonly (readonly [string, string])[]) {
      expect(Money.of(c[0]).round(2, mode).toString()).toBe(Money.of(c[1]).toString());
    }
  });

  it('multiplies by a rate without drift', () => {
    expect(Money.of('1000').mul('0.15').toString()).toBe('150');
    expect(Money.of('19.99').mul('3').toString()).toBe('59.97');
  });

  it('refuses division by zero', () => {
    expect(() => Money.of('1').div('0')).toThrow(RangeError);
  });

  it('sums, compares and signs', () => {
    expect(Money.sum([Money.of('1.10'), Money.of('2.20'), Money.of('-3.30')]).isZero()).toBe(true);
    expect(Money.of('-0').isNegative()).toBe(false);
    expect(Money.of('2').gt('1')).toBe(true);
    expect(Money.of('1').lt('1.0001')).toBe(true);
  });

  describe('properties', () => {
    it('addition commutes and associates', () => {
      fc.assert(
        fc.property(amount, amount, amount, (a, b, c) => {
          expect(a.add(b).eq(b.add(a))).toBe(true);
          expect(
            a
              .add(b)
              .add(c)
              .eq(a.add(b.add(c))),
          ).toBe(true);
        }),
        { numRuns: 1000 },
      );
    });
    it('a + b - b returns a, and a - a is zero', () => {
      fc.assert(
        fc.property(amount, amount, (a, b) => {
          expect(a.add(b).sub(b).eq(a)).toBe(true);
          expect(a.sub(a).isZero()).toBe(true);
        }),
        { numRuns: 1000 },
      );
    });
    it('round-trips through its database string', () => {
      fc.assert(
        fc.property(amount, (a) => {
          expect(Money.of(a.toDbString()).eq(a)).toBe(true);
        }),
        { numRuns: 1000 },
      );
    });
  });
});
