/**
 * Conditions on computed consequences (ADR-0022 §5).
 *
 * A threshold is a line on a value the model COMPUTED for the chosen future —
 * "CashImpact ≥ −1 000 000 000 VND" — and the comparison is exact (ADR-0016):
 * 999 999 999, 1 000 000 000 and 1 000 000 001 are three different answers,
 * with no floating-point ambiguity at the boundary.
 *
 * A value the model cannot give — BLOCKED, not modelled, ambiguous, or in
 * another currency — makes the condition UNKNOWN. UNKNOWN never passes.
 */

import { compare, decimal } from '@helm/shared';
import { canonicalNumeric } from '@helm/propagation-engine';
import type { AuthorityCondition, Comparator, ConditionCheck, ConditionOutcome, ConsequenceValue } from './types.ts';

const SYMBOL: Readonly<Record<Comparator, string>> = { GTE: '≥', GT: '>', LTE: '≤', LT: '<' };

/** Exact digits grouped in threes, with a true minus. For reading; never rounded. */
export function readableNumber(value: string): string {
  const canonical = canonicalNumeric(value);
  const negative = canonical.startsWith('-');
  const [whole, frac] = (negative ? canonical.slice(1) : canonical).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${negative ? '−' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

export function readableAmount(value: string, unit: string | null, currency: string | null): string {
  const n = readableNumber(value);
  if (unit === 'percentage') return `${n}%`;
  if (unit === 'currency') return `${n}${currency ? ` ${currency}` : ''}`;
  if (unit === 'units') return `${n} units`;
  return n;
}

export function describeCondition(c: AuthorityCondition): string {
  return `${c.label} ${SYMBOL[c.comparator]} ${readableAmount(c.threshold, c.unit, c.currency)}`;
}

function holds(comparator: Comparator, cmp: -1 | 0 | 1): boolean {
  switch (comparator) {
    case 'GTE':
      return cmp >= 0;
    case 'GT':
      return cmp > 0;
    case 'LTE':
      return cmp <= 0;
    case 'LT':
      return cmp < 0;
  }
}

/** Evaluates one condition against the consequences the evaluation read. */
export function checkCondition(condition: AuthorityCondition, consequences: readonly ConsequenceValue[]): ConditionCheck {
  const base = {
    metricKey: condition.metricKey,
    label: condition.label,
    comparator: condition.comparator,
    threshold: canonicalNumeric(condition.threshold),
    unit: condition.unit,
    currency: condition.currency,
  };
  const line = describeCondition(condition);
  const unknown = (statement: string, v: ConsequenceValue | null): ConditionCheck => ({
    ...base,
    value: v?.value ?? null,
    nodeId: v?.nodeId ?? null,
    outcome: 'UNKNOWN',
    statement: `${line}: UNKNOWN — ${statement}`,
  });

  const matches = consequences.filter((c) => c.metricKey === condition.metricKey);
  if (matches.length === 0) {
    return unknown(`${condition.metricKey} is not among the commitment's computed consequences.`, null);
  }
  const v = matches[0];
  if (v.value === null) {
    return unknown(v.reason ?? `the chosen future state has no value for ${condition.metricKey} (${v.origin ?? 'not modelled'}).`, v);
  }
  if (condition.currency && v.currency && condition.currency !== v.currency) {
    return unknown(`the value is in ${v.currency} and the line in ${condition.currency}; HELM does not convert currency.`, v);
  }
  if (condition.unit && v.unit && condition.unit !== v.unit) {
    return unknown(`the value is measured in ${v.unit} and the line in ${condition.unit}.`, v);
  }

  const cmp = compare(decimal(v.value), decimal(condition.threshold));
  const outcome: ConditionOutcome = holds(condition.comparator, cmp) ? 'PASS' : 'FAIL';
  const value = readableAmount(v.value, v.unit, v.currency);
  return {
    ...base,
    value: canonicalNumeric(v.value),
    nodeId: v.nodeId,
    outcome,
    statement:
      `${condition.label} ${value} against a line of ${SYMBOL[condition.comparator]} ` +
      `${readableAmount(condition.threshold, condition.unit, condition.currency)}: ${outcome === 'PASS' ? 'within the line' : 'beyond the line'}.`,
  };
}

export function checkConditions(
  conditions: readonly AuthorityCondition[],
  consequences: readonly ConsequenceValue[],
): ConditionCheck[] {
  return conditions.map((c) => checkCondition(c, consequences));
}

/** PASS only if every condition passes; FAIL if any fails; otherwise UNKNOWN. */
export function conditionsOutcome(checks: readonly ConditionCheck[]): ConditionOutcome {
  if (checks.some((c) => c.outcome === 'FAIL')) return 'FAIL';
  if (checks.some((c) => c.outcome === 'UNKNOWN')) return 'UNKNOWN';
  return 'PASS';
}

/**
 * Is `inner` at least as strict as `outer`? A delegation may narrow a line the
 * delegator holds; it may not widen it, and it may not drop it.
 */
export function conditionWithin(inner: AuthorityCondition, outer: AuthorityCondition): boolean {
  if (inner.metricKey !== outer.metricKey) return false;
  if ((inner.currency ?? null) !== (outer.currency ?? null) || (inner.unit ?? null) !== (outer.unit ?? null)) return false;
  const i = decimal(inner.threshold);
  const o = decimal(outer.threshold);
  const lowerBound = (c: Comparator) => c === 'GTE' || c === 'GT';
  if (lowerBound(inner.comparator) !== lowerBound(outer.comparator)) return false;
  const cmp = compare(i, o);
  if (lowerBound(outer.comparator)) {
    // outer: value ≥ o. inner must demand at least as much.
    if (cmp > 0) return true;
    if (cmp < 0) return false;
    return !(outer.comparator === 'GT' && inner.comparator === 'GTE');
  }
  if (cmp < 0) return true;
  if (cmp > 0) return false;
  return !(outer.comparator === 'LT' && inner.comparator === 'LTE');
}
