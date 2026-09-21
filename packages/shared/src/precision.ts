/**
 * Metric precision policy — one place that decides how many digits a number
 * keeps, at each of the three points where that question has a different answer.
 *
 *   internal   what intermediate arithmetic carries          (DECIMAL_SCALE)
 *   storage    what the persisted business value keeps       (per unit/currency)
 *   display    what a reader is shown                        (per unit)
 *
 * The distinction matters because they genuinely differ. A working-capital
 * figure is computed through a non-terminating division that needs ~28 digits of
 * headroom to stay honest, is a whole number of VND when it is written down, and
 * is read as a whole number of VND. Collapsing those three into one number
 * forces a choice between an unreadable result and a wrong one.
 *
 * WHAT THIS IS NOT: a business rule. Normalizing 2 687 699 999.9999999999999999
 * to 2 687 700 000 VND is a representation decision — the residue is an artefact
 * of decimal division, not a quantity anybody owns. Turning a demand of 8.4 units
 * into a procurement order of 9 units is a BUSINESS decision, it belongs in a
 * calculation that says so, and this module must never do it.
 */

import { DECIMAL_SCALE, round, toString as decToString, type Decimal, type RoundingMode } from './decimal.ts';
import type { QuantityUnit } from './quantity.ts';

export type PrecisionPolicy = {
  /** Digits carried through intermediate arithmetic. Always DECIMAL_SCALE. */
  readonly internalScale: number;
  /** Digits the persisted business value keeps. */
  readonly storageScale: number;
  /** Digits a reader is shown. Trailing zeros are trimmed. */
  readonly displayScale: number;
  readonly roundingMode: RoundingMode;
  /** Why this policy is what it is, for the reader who asks. */
  readonly rationale: string;
};

/**
 * Minor units per currency — how many decimal places the currency actually has.
 *
 * VND has none: there is no such thing as a fraction of a dong in a ledger, so
 * storing 2 687 700 000.0000 would be claiming a precision the currency does not
 * possess. USD has two. A currency absent from this table falls back to two,
 * which is the common case and is stated rather than assumed silently.
 */
const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = {
  VND: 0,
  JPY: 0,
  KRW: 0,
  IDR: 0,
  CLP: 0,
  ISK: 0,
  USD: 2,
  EUR: 2,
  GBP: 2,
  SGD: 2,
  AUD: 2,
  CNY: 2,
  THB: 2,
  MYR: 2,
  PHP: 2,
  INR: 2,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
};

export const DEFAULT_CURRENCY_MINOR_UNITS = 2;

/** How many decimal places this currency has. */
export function currencyMinorUnits(currency: string | null): number {
  if (!currency) return DEFAULT_CURRENCY_MINOR_UNITS;
  return CURRENCY_MINOR_UNITS[currency.toUpperCase()] ?? DEFAULT_CURRENCY_MINOR_UNITS;
}

type UnitPolicy = Omit<PrecisionPolicy, 'internalScale'>;

/**
 * Per-unit defaults.
 *
 * `units` keeps six decimals deliberately: 8.4 units is an expected value across
 * outcomes, not a shipment, and flattening it to 8 would silently convert a
 * statistical quantity into a commitment.
 */
const UNIT_POLICY: Readonly<Record<QuantityUnit, UnitPolicy>> = {
  currency: {
    // Overridden per currency by policyFor(); this is the fallback.
    storageScale: DEFAULT_CURRENCY_MINOR_UNITS,
    displayScale: DEFAULT_CURRENCY_MINOR_UNITS,
    roundingMode: 'half-even',
    rationale:
      'Money is stored at the minor unit the currency actually has. Half-even ' +
      'because repeated half-up rounding of many amounts biases a total upward.',
  },
  percentage: {
    storageScale: 4,
    displayScale: 2,
    roundingMode: 'half-up',
    rationale:
      'Four stored decimals keep a basis point distinguishable; two are shown, ' +
      'because 33.24% is what a manager reads and 33.2381% is not.',
  },
  ratio: {
    storageScale: 6,
    displayScale: 4,
    roundingMode: 'half-up',
    rationale: 'A ratio is 0..1, so it needs more decimals than a percentage to carry the same information.',
  },
  units: {
    storageScale: 6,
    displayScale: 4,
    roundingMode: 'half-up',
    rationale:
      'Fractional on purpose. An expected demand of 8.4 units is a statistical ' +
      'quantity; rounding it to a whole number is a procurement decision and ' +
      'belongs in a calculation that declares itself as one.',
  },
  count: {
    storageScale: 0,
    displayScale: 0,
    roundingMode: 'half-up',
    rationale: 'A count of things is a whole number by definition.',
  },
  days: {
    storageScale: 2,
    displayScale: 1,
    roundingMode: 'half-up',
    rationale: 'Lead times are quoted in days and fractions of a day matter to a plan.',
  },
  hours: {
    storageScale: 2,
    displayScale: 1,
    roundingMode: 'half-up',
    rationale: 'Same reasoning as days, at a finer grain.',
  },
  capacity: {
    storageScale: 4,
    displayScale: 2,
    roundingMode: 'half-up',
    rationale: 'Capacity is a rate-like quantity; four decimals avoid compounding error in utilisation.',
  },
  score: {
    storageScale: 2,
    displayScale: 0,
    roundingMode: 'half-up',
    rationale: 'A 0-100 judgement score carries no meaningful sub-point precision.',
  },
  index: {
    storageScale: 4,
    displayScale: 2,
    roundingMode: 'half-up',
    rationale: 'An index is relative, so it keeps more decimals than the thing it indexes.',
  },
};

/**
 * A metric may override the unit default — a metric registry entry can carry
 * `precision: { storageScale, displayScale, roundingMode }` in its metadata.
 */
export type PrecisionOverride = Readonly<Partial<Omit<PrecisionPolicy, 'internalScale' | 'rationale'>>>;

/** The policy for a value of this unit and currency, with optional override. */
export function policyFor(
  unit: QuantityUnit,
  currency: string | null = null,
  override?: PrecisionOverride,
): PrecisionPolicy {
  const base = UNIT_POLICY[unit];
  const scale =
    unit === 'currency' ? currencyMinorUnits(currency) : base.storageScale;
  const display = unit === 'currency' ? scale : base.displayScale;
  return {
    internalScale: DECIMAL_SCALE,
    storageScale: override?.storageScale ?? scale,
    displayScale: override?.displayScale ?? display,
    roundingMode: override?.roundingMode ?? base.roundingMode,
    rationale: base.rationale,
  };
}

/** Reads a precision override out of a metric's metadata, if it declares one. */
export function overrideFromMetadata(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
): PrecisionOverride | undefined {
  const raw = metadata?.precision;
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  const out: {
    storageScale?: number;
    displayScale?: number;
    roundingMode?: RoundingMode;
  } = {};
  if (typeof p.storageScale === 'number') out.storageScale = p.storageScale;
  if (typeof p.displayScale === 'number') out.displayScale = p.displayScale;
  if (typeof p.roundingMode === 'string') out.roundingMode = p.roundingMode as RoundingMode;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The business-normalized form of a raw computation.
 *
 * `raw` is what the arithmetic produced and is kept in the trace; `normalized`
 * is what gets written down as the business value. Keeping both is what lets a
 * reader see that 2 687 700 000 is a rounding of 2 687 699 999.99999999999999999
 * and not a number HELM made up.
 */
export type Normalized = {
  readonly raw: Decimal;
  readonly normalized: Decimal;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly policy: PrecisionPolicy;
  /** True when normalization actually moved the value. */
  readonly adjusted: boolean;
};

export function normalize(value: Decimal, policy: PrecisionPolicy): Normalized {
  const normalized = round(value, policy.storageScale, policy.roundingMode);
  const rawText = decToString(value);
  const normalizedText = decToString(normalized);
  return {
    raw: value,
    normalized,
    rawText,
    normalizedText,
    policy,
    adjusted: rawText !== normalizedText,
  };
}

/** Display form: rounded to the display scale, trailing zeros trimmed. */
export function forDisplay(value: Decimal, policy: PrecisionPolicy): string {
  return decToString(round(value, policy.displayScale, policy.roundingMode));
}
