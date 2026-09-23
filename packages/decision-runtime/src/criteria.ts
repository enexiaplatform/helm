/**
 * Criterion evaluation (ADR-0021 §3).
 *
 * States how each alternative stands against each criterion management wrote
 * down. Every result is a fact about a stated line — "30.517% against a target
 * of 35%" — never a judgement about the alternative as a whole, never a rank,
 * and never a number that combines criteria. A criterion HELM cannot evaluate
 * says UNKNOWN and why, rather than defaulting to pass.
 *
 * Qualitative criteria are read from authored assessments only. If nobody has
 * assessed one, the result is NOT_ASSESSED; HELM does not have opinions about
 * strategic relationships.
 */

import {
  abs,
  compare as decCompare,
  decimal,
  divide,
  isZero,
  multiply,
  periodKey,
  subtract,
  toString as decToString,
  type Period,
} from '@helm/shared';
import { canonicalNumeric } from '@helm/propagation-engine';
import type { FutureState, FutureStateValue } from '@helm/scenario-runtime';
import type {
  CriterionAssessment,
  CriterionEvaluation,
  DecisionAlternative,
  DecisionCriterion,
  ManagementWeighting,
  WeightedContribution,
  WeightedView,
} from './types.ts';

export const WEIGHTED_VIEW_STATEMENT =
  'This weighting is management\'s own: the method, the weights and the rationale were ' +
  'authored by a named person. HELM computes the arithmetic they specified and holds no ' +
  'view about whether it is the right one.';

/** The value a criterion reads, chosen by metric and — where it matters — by subject. */
export function pickCriterionValue(
  state: FutureState,
  criterion: DecisionCriterion,
  period?: Period,
): FutureStateValue | undefined {
  const wantedPeriod = period ? periodKey(period) : null;
  const matches = state.values.filter(
    (v) =>
      v.metricKey === criterion.metricKey &&
      (wantedPeriod === null || periodKey(v.period) === wantedPeriod),
  );
  if (matches.length === 0) return undefined;
  if (criterion.subjectHint) {
    const hinted = matches.find((v) => v.nodeLabel.includes(criterion.subjectHint!));
    if (hinted) return hinted;
  }
  return matches[0];
}

function describe(
  criterion: DecisionCriterion,
  outcome: CriterionEvaluation['outcome'],
  value: string | null,
  reason: string | null,
): string {
  const line = criterion.threshold === null ? '' : ` against ${criterion.threshold}`;
  switch (outcome) {
    case 'SATISFIED':
      return `${criterion.name}: ${value}${line} — the stated requirement holds.`;
    case 'VIOLATED':
      return `${criterion.name}: ${value}${line} — the stated requirement does not hold.`;
    case 'MEETS_TARGET':
      return `${criterion.name}: ${value}${line} — meets the target.`;
    case 'MISSES_TARGET':
      return `${criterion.name}: ${value}${line} — below the target.`;
    case 'STATED':
      return `${criterion.name}: ${value}. A preference, so the value is stated and not judged.`;
    case 'ASSESSED':
      return `${criterion.name}: assessed by a person, with a rationale.`;
    case 'NOT_ASSESSED':
      return `${criterion.name}: no one has assessed this yet. HELM does not rate it for them.`;
    default:
      return `${criterion.name}: cannot be evaluated — ${reason ?? 'no value is available'}.`;
  }
}

/** Does `value` clear `threshold` in the criterion's declared direction? */
function clears(value: string, threshold: string, direction: DecisionCriterion['direction']): boolean {
  const cmp = decCompare(decimal(value), decimal(threshold));
  if (direction === 'LOWER_IS_BETTER') return cmp <= 0;
  if (direction === 'HIGHER_IS_BETTER') return cmp >= 0;
  return cmp === 0;
}

export type AlternativeState = {
  readonly alternative: DecisionAlternative;
  /** Null when the alternative is UNMODELLED or its run is missing. */
  readonly state: FutureState | null;
};

export function evaluateCriteria(
  criteria: readonly DecisionCriterion[],
  alternatives: readonly AlternativeState[],
  assessments: readonly CriterionAssessment[],
  period?: Period,
): CriterionEvaluation[] {
  const out: CriterionEvaluation[] = [];
  for (const criterion of criteria) {
    for (const { alternative, state } of alternatives) {
      const base = {
        criterionId: criterion.id,
        criterionKey: criterion.key,
        criterionName: criterion.name,
        style: criterion.style,
        alternativeId: alternative.id,
        alternativeLabel: alternative.label,
        threshold: criterion.threshold,
        unit: criterion.unit,
      };

      if (criterion.style === 'QUALITATIVE') {
        const assessment =
          assessments.find((a) => a.criterionId === criterion.id && a.alternativeId === alternative.id) ?? null;
        const outcome = assessment ? ('ASSESSED' as const) : ('NOT_ASSESSED' as const);
        out.push({
          ...base,
          outcome,
          value: null,
          currency: null,
          origin: null,
          confidence: null,
          nodeId: null,
          period: null,
          assessment,
          explanation: assessment
            ? `${criterion.name}: ${assessment.rating.replaceAll('_', ' ').toLowerCase()} — ${assessment.rationale} (${assessment.author.label})`
            : describe(criterion, outcome, null, null),
        });
        continue;
      }

      if (state === null) {
        out.push({
          ...base,
          outcome: 'UNKNOWN',
          value: null,
          currency: null,
          origin: null,
          confidence: null,
          nodeId: null,
          period: null,
          assessment: null,
          explanation: describe(
            criterion,
            'UNKNOWN',
            null,
            alternative.status === 'UNMODELLED'
              ? `${alternative.label} has no modelled future state`
              : 'the alternative has no completed simulation',
          ),
        });
        continue;
      }

      const v = criterion.metricKey ? pickCriterionValue(state, criterion, period) : undefined;
      if (!v || v.value === null) {
        const reason = !v
          ? `no ${criterion.metricKey ?? 'value'} is modelled in this future state`
          : `${criterion.metricKey} is ${v.origin}${v.reason ? `: ${v.reason}` : ''}`;
        out.push({
          ...base,
          outcome: 'UNKNOWN',
          value: null,
          currency: v?.currency ?? null,
          origin: v?.origin ?? null,
          confidence: v?.confidence ?? null,
          nodeId: v?.nodeId ?? null,
          period: v?.period ?? null,
          assessment: null,
          explanation: describe(criterion, 'UNKNOWN', null, reason),
        });
        continue;
      }

      const value = canonicalNumeric(v.value);
      let outcome: CriterionEvaluation['outcome'];
      if (criterion.threshold === null || criterion.style === 'PREFERENCE' || criterion.style === 'OPTIONAL_WEIGHTED') {
        outcome = 'STATED';
      } else if (criterion.style === 'HARD_CONSTRAINT') {
        outcome = clears(value, criterion.threshold, criterion.direction) ? 'SATISFIED' : 'VIOLATED';
      } else {
        outcome = clears(value, criterion.threshold, criterion.direction) ? 'MEETS_TARGET' : 'MISSES_TARGET';
      }
      out.push({
        ...base,
        outcome,
        value,
        currency: v.currency,
        origin: v.origin,
        confidence: v.confidence,
        nodeId: v.nodeId,
        period: v.period,
        assessment: null,
        explanation: describe(criterion, outcome, `${value}${v.unit === 'percentage' ? '%' : ''}`, null),
      });
    }
  }
  return out;
}

/**
 * The weighted view — computed ONLY from a management-declared weighting.
 *
 * Normalization is deliberately the simplest defensible thing: each weighted
 * criterion's values are scaled to [0, 1] across the alternatives that have
 * one, oriented by the criterion's declared direction. Anything cleverer would
 * be HELM inventing a method, and the whole point is that the method is
 * management's. An alternative missing any weighted value is marked incomplete
 * rather than being given a zero.
 */
export function weightedView(
  weighting: ManagementWeighting,
  criteria: readonly DecisionCriterion[],
  alternatives: readonly AlternativeState[],
  evaluations: readonly CriterionEvaluation[],
): WeightedView {
  const weighted = criteria.filter((c) => c.style === 'OPTIONAL_WEIGHTED' && c.weight !== null);
  const perAlternative = alternatives.map(({ alternative }) => {
    const contributions: WeightedContribution[] = [];
    let total = decimal('0');
    let incomplete = weighted.length === 0;
    for (const c of weighted) {
      const mine = evaluations.find((e) => e.criterionId === c.id && e.alternativeId === alternative.id);
      const values = evaluations
        .filter((e) => e.criterionId === c.id && e.value !== null)
        .map((e) => decimal(e.value!));
      if (!mine || mine.value === null || values.length === 0) {
        contributions.push({
          criterionId: c.id,
          criterionName: c.name,
          weight: c.weight!,
          normalizedValue: null,
          contribution: null,
          note: 'no value for this alternative',
        });
        incomplete = true;
        continue;
      }
      let lo = values[0];
      let hi = values[0];
      for (const d of values) {
        if (decCompare(d, lo) < 0) lo = d;
        if (decCompare(d, hi) > 0) hi = d;
      }
      const span = subtract(hi, lo);
      const raw = subtract(decimal(mine.value), lo);
      const scaled = isZero(span) ? decimal('1') : divide(raw, span);
      const oriented = c.direction === 'LOWER_IS_BETTER' ? subtract(decimal('1'), scaled) : scaled;
      const contribution = multiply(oriented, decimal(c.weight!));
      total = decimal(decToString(subtract(total, multiply(decimal('-1'), contribution))));
      contributions.push({
        criterionId: c.id,
        criterionName: c.name,
        weight: c.weight!,
        normalizedValue: canonicalNumeric(decToString(oriented)),
        contribution: canonicalNumeric(decToString(contribution)),
        note: isZero(span) ? 'every alternative has the same value here' : null,
      });
    }
    return {
      alternativeId: alternative.id,
      alternativeLabel: alternative.label,
      contributions,
      total: incomplete ? null : canonicalNumeric(decToString(total)),
      incomplete,
    };
  });
  return { weighting, perAlternative, statement: WEIGHTED_VIEW_STATEMENT };
}

/** Exposed for the trade-off module: the absolute gap between two exact decimals. */
export function gap(a: string, b: string): string {
  return canonicalNumeric(decToString(abs(subtract(decimal(a), decimal(b)))));
}
