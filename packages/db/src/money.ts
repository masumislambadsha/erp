import { Decimal } from 'decimal.js';

/**
 * Money is never a JS number. This wraps decimal.js and refuses number input, number coercion
 * (`+`, `<`, `Number(m)`) and silent rounding. Amounts map to NUMERIC(19,4): at most 15 integer
 * digits and 4 decimals. Round explicitly with `round()` before writing to the database.
 *
 * Rounding mode is ROUND_HALF_UP (PLAN.md, "Rounding": per line to the minor unit).
 */
const D = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});
type D = InstanceType<typeof D>;

export const MONEY_SCALE = 4;

/** Rounding modes a currency can choose (decision D17). Half up, away from zero at a tie, is the default. */
export type RoundingMode = 'half_up' | 'half_even' | 'down' | 'up';
const MODES: Record<RoundingMode, Decimal.Rounding> = {
  half_up: Decimal.ROUND_HALF_UP,
  half_even: Decimal.ROUND_HALF_EVEN,
  down: Decimal.ROUND_DOWN,
  up: Decimal.ROUND_UP,
};
const MAX_ABS = new D('1e15'); // NUMERIC(19,4): |x| < 10^15

export type MoneyInput = string | Money;

export class Money {
  private constructor(private readonly d: D) {}

  static of(value: MoneyInput): Money {
    if (value instanceof Money) return value;
    if (typeof value !== 'string') {
      throw new TypeError('Money.of takes a string, never a number');
    }
    const s = value.trim();
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) {
      throw new TypeError(`Money.of: not a plain decimal string: ${JSON.stringify(value)}`);
    }
    return new Money(new D(s));
  }

  static zero(): Money {
    return new Money(new D(0));
  }

  static sum(values: Iterable<Money>): Money {
    let total = Money.zero();
    for (const v of values) total = total.add(v);
    return total;
  }

  add(o: MoneyInput): Money {
    return new Money(this.d.plus(Money.of(o).d));
  }
  sub(o: MoneyInput): Money {
    return new Money(this.d.minus(Money.of(o).d));
  }
  neg(): Money {
    return new Money(this.d.neg());
  }
  abs(): Money {
    return new Money(this.d.abs());
  }
  /** Multiply by a rate or quantity given as a decimal string (e.g. "0.15"); never a number. */
  mul(factor: string | Money): Money {
    return new Money(this.d.times(Money.of(factor).d));
  }
  /** Divide by a decimal string; the result keeps full precision until you `round()`. */
  div(divisor: string | Money): Money {
    const o = Money.of(divisor).d;
    if (o.isZero()) throw new RangeError('Money: division by zero');
    return new Money(this.d.div(o));
  }
  round(dp: number = MONEY_SCALE, mode: RoundingMode = 'half_up'): Money {
    return new Money(this.d.toDecimalPlaces(dp, MODES[mode]));
  }

  cmp(o: MoneyInput): -1 | 0 | 1 {
    return this.d.cmp(Money.of(o).d) as -1 | 0 | 1;
  }
  eq(o: MoneyInput): boolean {
    return this.cmp(o) === 0;
  }
  lt(o: MoneyInput): boolean {
    return this.cmp(o) < 0;
  }
  gt(o: MoneyInput): boolean {
    return this.cmp(o) > 0;
  }
  isZero(): boolean {
    return this.d.isZero();
  }
  isNegative(): boolean {
    return this.d.isNegative() && !this.d.isZero();
  }

  /** Exact string for a NUMERIC(19,4) parameter. Throws if it has more than 4 decimals or overflows. */
  toDbString(): string {
    if (this.d.decimalPlaces() > MONEY_SCALE) {
      throw new RangeError(
        `Money ${this.d.toFixed()} has more than ${MONEY_SCALE} decimals: round() first`,
      );
    }
    if (this.d.abs().gte(MAX_ABS)) {
      throw new RangeError('Money exceeds NUMERIC(19,4)');
    }
    return this.d.toFixed(MONEY_SCALE);
  }

  toString(): string {
    return this.d.toFixed();
  }
  toJSON(): string {
    return this.toString();
  }
  /** Blocks `a + b`, `a < b`, `Number(a)`: the only way to use Money is its methods. */
  valueOf(): never {
    throw new TypeError('Money is never a number: use add, sub, cmp and toString');
  }
  [Symbol.toPrimitive](hint: string): string {
    if (hint === 'string') return this.toString();
    throw new TypeError('Money is never a number: use add, sub, cmp and toString');
  }
}
