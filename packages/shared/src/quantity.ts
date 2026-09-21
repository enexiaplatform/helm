/**
 * Quantity — a decimal that carries its unit, so `4.2B VND + 4 units` cannot be
 * written (ADR-0016 §"Units travel with values").
 *
 * This is unit CHECKING, not unit algebra. HELM does not derive that
 * `currency ÷ (currency/unit) = unit`. Instead it offers operations whose
 * *names* state the dimensional intent and whose signatures validate the
 * inputs. That is §16's "enough unit semantics for canonical business
 * calculations", taken literally.
 *
 * Every operation returns a Result: a dimensional mistake is a domain error a
 * caller must handle, not an exception.
 */

import {
  type Decimal,
  HUNDRED,
  ZERO,
  add,
  divide,
  multiply,
  subtract,
  max as decMax,
  min as decMin,
  isZero,
  toString as decToString,
} from './decimal.ts';
import { fail, ok, type Result } from './result.ts';

/**
 * The unit vocabulary, mirroring the value graph's. Duplicated here rather than
 * imported because `@helm/shared` sits below `@helm/value-graph` — the
 * dependency must not invert. `verify:calculations` asserts the two agree.
 */
export const quantityUnits = [
  'currency',
  'percentage',
  'ratio',
  'units',
  'count',
  'days',
  'hours',
  'capacity',
  'score',
  'index',
] as const;
export type QuantityUnit = (typeof quantityUnits)[number];

export type Quantity = {
  readonly amount: Decimal;
  readonly unit: QuantityUnit;
  /** Required when unit is 'currency', null otherwise. */
  readonly currency: string | null;
};

export const QuantityErrors = {
  UNIT_MISMATCH: 'calculation.unit_mismatch',
  CURRENCY_MISMATCH: 'calculation.currency_mismatch',
  FX_RATE_REQUIRED: 'calculation.fx_rate_required',
  MISSING_CURRENCY: 'calculation.missing_currency',
  DIVIDE_BY_ZERO: 'calculation.divide_by_zero',
} as const;

export function quantity(
  amount: Decimal,
  unit: QuantityUnit,
  currency: string | null = null,
): Result<Quantity> {
  if (unit === 'currency' && !currency) {
    return fail(
      QuantityErrors.MISSING_CURRENCY,
      'A currency quantity must carry its currency — a bare number is not an amount.',
    );
  }
  if (unit !== 'currency' && currency) {
    return fail(
      QuantityErrors.UNIT_MISMATCH,
      `A ${unit} quantity must not carry a currency.`,
      { unit, currency },
    );
  }
  return ok({ amount, unit, currency });
}

/** Constructor for cases where the unit is known valid; throws on misuse. */
export function mustQuantity(
  amount: Decimal,
  unit: QuantityUnit,
  currency: string | null = null,
): Quantity {
  const r = quantity(amount, unit, currency);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

// ------------------------------------------------------------- compatibility

function sameDimension(a: Quantity, b: Quantity, op: string): Result<true> {
  if (a.unit !== b.unit) {
    return fail(
      QuantityErrors.UNIT_MISMATCH,
      `Cannot ${op} a ${a.unit} and a ${b.unit}. ` +
        'These measure different things; the model is asking for an operation that has no meaning.',
      { left: a.unit, right: b.unit, operation: op },
    );
  }
  if (a.unit === 'currency' && a.currency !== b.currency) {
    // Deliberately a distinct, actionable error: HELM does not invent rates.
    return fail(
      QuantityErrors.FX_RATE_REQUIRED,
      `Cannot ${op} ${a.currency} and ${b.currency}: no exchange rate is available. ` +
        'HELM does not invent FX rates.',
      { left: a.currency, right: b.currency, operation: op },
    );
  }
  return ok(true);
}

// --------------------------------------------------------------- operations

/** Same unit, same currency → same unit. */
export function sum(a: Quantity, b: Quantity): Result<Quantity> {
  const c = sameDimension(a, b, 'add');
  if (!c.ok) return c;
  return ok({ amount: add(a.amount, b.amount), unit: a.unit, currency: a.currency });
}

/** Same unit, same currency → same unit. */
export function difference(a: Quantity, b: Quantity): Result<Quantity> {
  const c = sameDimension(a, b, 'subtract');
  if (!c.ok) return c;
  return ok({ amount: subtract(a.amount, b.amount), unit: a.unit, currency: a.currency });
}

/**
 * quantity × ratio → same unit. The only legitimate multiplication in the
 * value model: scaling something by a dimensionless proportion.
 */
export function scaleByRatio(q: Quantity, factor: Quantity): Result<Quantity> {
  if (factor.unit !== 'ratio') {
    return fail(
      QuantityErrors.UNIT_MISMATCH,
      `Scaling requires a ratio (0..1), not a ${factor.unit}. ` +
        (factor.unit === 'percentage'
          ? 'A percentage is 0..100 — scaling by 70 instead of 0.7 would be a hundredfold error.'
          : ''),
      { factorUnit: factor.unit },
    );
  }
  return ok({ amount: multiply(q.amount, factor.amount), unit: q.unit, currency: q.currency });
}

/**
 * quantity × count → same unit. Multiplying a per-unit price by a quantity of
 * units, or a per-day rate by days.
 */
export function scaleByCount(perUnit: Quantity, count: Quantity): Result<Quantity> {
  if (count.unit !== 'units' && count.unit !== 'count') {
    return fail(
      QuantityErrors.UNIT_MISMATCH,
      `Expected a unit count to scale by, got a ${count.unit}.`,
      { countUnit: count.unit },
    );
  }
  return ok({
    amount: multiply(perUnit.amount, count.amount),
    unit: perUnit.unit,
    currency: perUnit.currency,
  });
}

/** same unit ÷ same unit → ratio (0..1 scale, unbounded above). */
export function ratioOf(numerator: Quantity, denominator: Quantity): Result<Quantity> {
  const c = sameDimension(numerator, denominator, 'divide');
  if (!c.ok) return c;
  if (isZero(denominator.amount)) {
    return fail(QuantityErrors.DIVIDE_BY_ZERO, 'Cannot compute a ratio against zero.');
  }
  return ok({ amount: divide(numerator.amount, denominator.amount), unit: 'ratio', currency: null });
}

/** same unit ÷ same unit × 100 → percentage. */
export function percentageOf(numerator: Quantity, denominator: Quantity): Result<Quantity> {
  const r = ratioOf(numerator, denominator);
  if (!r.ok) return r;
  return ok({
    // HUNDRED, not a literal scaled by a hard-coded exponent: a constant that
    // silently encodes DECIMAL_SCALE breaks the moment the scale changes.
    amount: multiply(r.value.amount, HUNDRED),
    unit: 'percentage',
    currency: null,
  });
}

/**
 * total currency ÷ currency-per-unit → units.
 *
 * Named for what it means: "how many units does this amount buy?". HELM does
 * not model `currency/unit` as a compound unit; the operation's name and this
 * comment are the dimensional contract.
 */
export function unitsPurchasable(total: Quantity, pricePerUnit: Quantity): Result<Quantity> {
  if (total.unit !== 'currency' || pricePerUnit.unit !== 'currency') {
    return fail(
      QuantityErrors.UNIT_MISMATCH,
      `unitsPurchasable requires two currency amounts, got ${total.unit} and ${pricePerUnit.unit}.`,
    );
  }
  if (total.currency !== pricePerUnit.currency) {
    return fail(
      QuantityErrors.FX_RATE_REQUIRED,
      `Cannot divide ${total.currency} by ${pricePerUnit.currency}: no exchange rate is available.`,
      { left: total.currency, right: pricePerUnit.currency },
    );
  }
  if (isZero(pricePerUnit.amount)) {
    return fail(QuantityErrors.DIVIDE_BY_ZERO, 'Unit price is zero.');
  }
  return ok({
    amount: divide(total.amount, pricePerUnit.amount),
    unit: 'units',
    currency: null,
  });
}

/** Floors at zero. Used where a negative result has no business meaning. */
export function atLeastZero(q: Quantity): Quantity {
  return { ...q, amount: decMax(q.amount, ZERO) };
}

export function maxOf(a: Quantity, b: Quantity): Result<Quantity> {
  const c = sameDimension(a, b, 'compare');
  if (!c.ok) return c;
  return ok({ amount: decMax(a.amount, b.amount), unit: a.unit, currency: a.currency });
}

export function minOf(a: Quantity, b: Quantity): Result<Quantity> {
  const c = sameDimension(a, b, 'compare');
  if (!c.ok) return c;
  return ok({ amount: decMin(a.amount, b.amount), unit: a.unit, currency: a.currency });
}

/** Human-readable, unit-bearing. A bare number never appears. */
export function formatQuantity(q: Quantity): string {
  const n = decToString(q.amount);
  switch (q.unit) {
    case 'currency':
      return `${n} ${q.currency}`;
    case 'percentage':
      return `${n}%`;
    case 'units':
    case 'count':
      return `${n} units`;
    case 'days':
      return `${n} days`;
    case 'hours':
      return `${n} h`;
    default:
      return n;
  }
}
