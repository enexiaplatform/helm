/**
 * Exact decimal arithmetic — see ADR-0016.
 *
 * A value is a `bigint` of `value × 10^SCALE`. This exists because the very
 * first calculation in HELM's canonical model breaks in binary floating point:
 *
 *     4_200_000_000 * 0.7   // 2940000000.0000005 as a JS number
 *     decimal:              // 2940000000 exactly
 *
 * Float error is also path-dependent, which would quietly break the replay and
 * reproducibility guarantees this phase exists to provide.
 *
 * Pure: no I/O, no ambient state, no dependency.
 */

/** Internal precision. Business values need far fewer; ratios need headroom. */
export const DECIMAL_SCALE = 12;
const SCALE_FACTOR = 10n ** BigInt(DECIMAL_SCALE);

declare const decimalBrand: unique symbol;

export type Decimal = {
  readonly [decimalBrand]: 'Decimal';
  /** value × 10^DECIMAL_SCALE */
  readonly raw: bigint;
};

export type RoundingMode = 'half-up' | 'half-even' | 'down' | 'up';

const make = (raw: bigint): Decimal => ({ raw }) as Decimal;

// ------------------------------------------------------------ construction

/**
 * Parses a decimal from a string, integer or JS number.
 *
 * A JS number is accepted because observations arrive that way, but it is the
 * lossy entry point: `fromNumber(0.1)` is exactly 0.1 only because we round to
 * DECIMAL_SCALE. Prefer strings wherever the source provides one.
 */
export function decimal(value: string | number | bigint): Decimal {
  if (typeof value === 'bigint') return make(value * SCALE_FACTOR);
  const text = typeof value === 'number' ? numberToPlainString(value) : value.trim();
  return make(parseToRaw(text));
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) {
    throw new RangeError(`decimal() requires a finite number, got ${n}`);
  }
  // Exponential notation ("4.2e+9") would defeat the string parser.
  if (!/e/i.test(String(n))) return String(n);
  return n.toFixed(DECIMAL_SCALE);
}

function parseToRaw(text: string): bigint {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) {
    throw new SyntaxError(`Not a decimal: "${text}"`);
  }
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = m[2] === '' ? 0n : BigInt(m[2]);
  const fracText = m[3] ?? '';

  // Round-half-up at the point of truncation rather than dropping digits.
  const kept = fracText.slice(0, DECIMAL_SCALE).padEnd(DECIMAL_SCALE, '0');
  const frac = kept === '' ? 0n : BigInt(kept);
  let raw = whole * SCALE_FACTOR + frac;
  const nextDigit = fracText[DECIMAL_SCALE];
  if (nextDigit !== undefined && Number(nextDigit) >= 5) raw += 1n;
  return sign * raw;
}

export const ZERO: Decimal = make(0n);
export const ONE: Decimal = make(SCALE_FACTOR);
export const HUNDRED: Decimal = make(100n * SCALE_FACTOR);

// -------------------------------------------------------------- arithmetic

export const add = (a: Decimal, b: Decimal): Decimal => make(a.raw + b.raw);
export const subtract = (a: Decimal, b: Decimal): Decimal => make(a.raw - b.raw);
export const negate = (a: Decimal): Decimal => make(-a.raw);
export const abs = (a: Decimal): Decimal => make(a.raw < 0n ? -a.raw : a.raw);

/** Rounds a raw value that has been scaled up by `divisor`, half-up. */
function divideRaw(numerator: bigint, divisor: bigint, mode: RoundingMode): bigint {
  if (divisor === 0n) throw new RangeError('decimal division by zero');
  const negative = numerator < 0n !== divisor < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = divisor < 0n ? -divisor : divisor;
  const q = n / d;
  const r = n % d;
  if (r === 0n) return negative ? -q : q;

  let bump = 0n;
  switch (mode) {
    case 'down':
      bump = 0n;
      break;
    case 'up':
      bump = 1n;
      break;
    case 'half-even': {
      const twice = r * 2n;
      if (twice > d) bump = 1n;
      else if (twice === d) bump = q % 2n === 0n ? 0n : 1n;
      break;
    }
    case 'half-up':
    default: {
      const twice = r * 2n;
      bump = twice >= d ? 1n : 0n;
      break;
    }
  }
  const result = q + bump;
  return negative ? -result : result;
}

export function multiply(a: Decimal, b: Decimal, mode: RoundingMode = 'half-up'): Decimal {
  return make(divideRaw(a.raw * b.raw, SCALE_FACTOR, mode));
}

export function divide(a: Decimal, b: Decimal, mode: RoundingMode = 'half-up'): Decimal {
  if (b.raw === 0n) throw new RangeError('decimal division by zero');
  return make(divideRaw(a.raw * SCALE_FACTOR, b.raw, mode));
}

// -------------------------------------------------------------- comparison

export const compare = (a: Decimal, b: Decimal): -1 | 0 | 1 =>
  a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0;

export const equals = (a: Decimal, b: Decimal): boolean => a.raw === b.raw;
export const lessThan = (a: Decimal, b: Decimal): boolean => a.raw < b.raw;
export const greaterThan = (a: Decimal, b: Decimal): boolean => a.raw > b.raw;
export const isZero = (a: Decimal): boolean => a.raw === 0n;
export const isNegative = (a: Decimal): boolean => a.raw < 0n;
export const max = (a: Decimal, b: Decimal): Decimal => (a.raw >= b.raw ? a : b);
export const min = (a: Decimal, b: Decimal): Decimal => (a.raw <= b.raw ? a : b);

export function sumAll(values: readonly Decimal[]): Decimal {
  let acc = 0n;
  for (const v of values) acc += v.raw;
  return make(acc);
}

// ----------------------------------------------------------------- rounding

/** Rounds to `places` decimal places. Used at boundaries, never inside formulas. */
export function round(a: Decimal, places: number, mode: RoundingMode = 'half-up'): Decimal {
  if (places < 0 || places > DECIMAL_SCALE) {
    throw new RangeError(`round() places must be 0..${DECIMAL_SCALE}, got ${places}`);
  }
  const factor = 10n ** BigInt(DECIMAL_SCALE - places);
  if (factor === 1n) return a;
  return make(divideRaw(a.raw, factor, mode) * factor);
}

// ------------------------------------------------------------ presentation

/** Canonical exact string. This is the storage and comparison representation. */
export function toString(a: Decimal): string {
  const negative = a.raw < 0n;
  const v = negative ? -a.raw : a.raw;
  const whole = v / SCALE_FACTOR;
  const frac = (v % SCALE_FACTOR).toString().padStart(DECIMAL_SCALE, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * Lossy exit to a JS number, for display and for interoperating with Phase 2's
 * observation representation. NEVER use inside a calculation — `verify:calculations`
 * asserts that no calculation implementation calls it.
 */
export function toNumber(a: Decimal): number {
  return Number(toString(a));
}

export const isDecimal = (v: unknown): v is Decimal =>
  typeof v === 'object' && v !== null && typeof (v as { raw?: unknown }).raw === 'bigint';
