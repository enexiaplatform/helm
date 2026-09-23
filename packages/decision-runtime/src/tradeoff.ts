/**
 * The decision trade-off space (ADR-0021 §4).
 *
 * Management does not choose between numbers; it chooses what to give up. This
 * module turns the criterion evaluations into exactly that: for each
 * alternative, what it gains relative to a reference alternative and what it
 * concedes — each line factual, each carrying the value on both sides and the
 * direction management itself declared.
 *
 * Where the direction is genuinely not decidable from what HELM holds — a
 * CONTEXT_DEPENDENT metric like working capital, or a criterion management
 * stated with no direction — the line is UNRESOLVED with the reason, not
 * quietly filed under one side.
 *
 * Dominance is stated as a fact and stops there. "B is at least as good on
 * every comparable criterion and strictly better on two" is something the
 * model can say. "Therefore choose B" is not, and never appears.
 */

import { compare as decCompare, decimal } from '@helm/shared';
import type { ScenarioComparison } from '@helm/scenario-runtime';
import type {
  AlternativeStatus,
  CriterionEvaluation,
  DecisionAlternative,
  DecisionCriterion,
  DominanceStatement,
  TradeOffColumn,
  TradeOffLine,
  TradeOffSpace,
} from './types.ts';
import { gap } from './criteria.ts';
import type { AlternativeState } from './criteria.ts';

export const TRADE_OFF_STATEMENT =
  'What each alternative gains and what it gives up, relative to the reference alternative. ' +
  'Every line is a modelled difference, not a verdict: HELM does not decide which concession ' +
  'is acceptable, and does not rank or recommend an alternative.';

/** Better, worse or the same, in the criterion\'s own declared direction. */
function orient(
  direction: DecisionCriterion['direction'],
  reference: string,
  alternative: string,
): 'GAIN' | 'CONCESSION' | 'SAME' | 'UNRESOLVED' {
  const cmp = decCompare(decimal(alternative), decimal(reference));
  if (cmp === 0) return 'SAME';
  if (direction === 'HIGHER_IS_BETTER') return cmp > 0 ? 'GAIN' : 'CONCESSION';
  if (direction === 'LOWER_IS_BETTER') return cmp < 0 ? 'GAIN' : 'CONCESSION';
  return 'UNRESOLVED';
}

function lineFor(
  criterion: DecisionCriterion,
  ref: CriterionEvaluation | undefined,
  alt: CriterionEvaluation | undefined,
): TradeOffLine {
  const common = {
    criterionId: criterion.id,
    label: criterion.name,
    metricKey: criterion.metricKey,
    unit: criterion.unit ?? alt?.unit ?? ref?.unit ?? null,
    currency: alt?.currency ?? ref?.currency ?? null,
    directionality: criterion.direction,
  };

  // Qualitative criteria compare authored assessments, not numbers.
  if (criterion.style === 'QUALITATIVE') {
    const r = ref?.assessment?.rating ?? null;
    const a = alt?.assessment?.rating ?? null;
    if (r === null || a === null) {
      return {
        ...common,
        referenceValue: r,
        alternativeValue: a,
        delta: null,
        kind: 'UNRESOLVED',
        note: 'not assessed on both sides — HELM does not rate a qualitative criterion itself',
      };
    }
    const order = ['STRONG_CONCERN', 'CONCERN', 'NEUTRAL', 'SUPPORT', 'STRONG_SUPPORT'];
    const d = order.indexOf(a) - order.indexOf(r);
    return {
      ...common,
      referenceValue: r,
      alternativeValue: a,
      delta: d === 0 ? null : String(d),
      kind: d === 0 ? 'SAME' : d > 0 ? 'GAIN' : 'CONCESSION',
      note: alt?.assessment ? `${alt.assessment.rationale} (${alt.assessment.author.label})` : null,
    };
  }

  if (!ref || !alt || ref.value === null || alt.value === null) {
    const why = [
      !ref || ref.value === null ? `reference: ${ref?.explanation ?? 'no evaluation'}` : null,
      !alt || alt.value === null ? `alternative: ${alt?.explanation ?? 'no evaluation'}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    return {
      ...common,
      referenceValue: ref?.value ?? null,
      alternativeValue: alt?.value ?? null,
      delta: null,
      kind: 'UNRESOLVED',
      note: why,
    };
  }

  const kind = orient(criterion.direction, ref.value, alt.value);
  return {
    ...common,
    referenceValue: ref.value,
    alternativeValue: alt.value,
    delta: gap(alt.value, ref.value),
    kind,
    note:
      kind === 'UNRESOLVED'
        ? 'the criterion states no direction, so whether this movement is a gain depends on the objective'
        : null,
  };
}

export function buildTradeOffSpace(input: {
  decisionId: string;
  revisionId: string;
  criteria: readonly DecisionCriterion[];
  alternatives: readonly AlternativeState[];
  evaluations: readonly CriterionEvaluation[];
  comparison: ScenarioComparison | null;
  referenceAlternativeId?: string | null;
  completenessOf: (a: DecisionAlternative) => TradeOffColumn['completeness'];
}): TradeOffSpace {
  const modelled = input.alternatives.filter((a) => a.alternative.status === 'MODELLED');
  const reference =
    input.alternatives.find((a) => a.alternative.id === input.referenceAlternativeId)?.alternative ??
    modelled[0]?.alternative ??
    input.alternatives[0]?.alternative ??
    null;

  const evalOf = (criterionId: string, alternativeId: string) =>
    input.evaluations.find((e) => e.criterionId === criterionId && e.alternativeId === alternativeId);

  const columns: TradeOffColumn[] = input.alternatives.map(({ alternative }) => {
    const lines = reference
      ? input.criteria.map((c) => lineFor(c, evalOf(c.id, reference.id), evalOf(c.id, alternative.id)))
      : [];
    return {
      alternativeId: alternative.id,
      alternativeLabel: alternative.label,
      status: alternative.status as AlternativeStatus,
      completeness: input.completenessOf(alternative),
      gains: lines.filter((l) => l.kind === 'GAIN'),
      concessions: lines.filter((l) => l.kind === 'CONCESSION'),
      unresolved: lines.filter((l) => l.kind === 'UNRESOLVED'),
    };
  });

  return {
    decisionId: input.decisionId,
    revisionId: input.revisionId,
    referenceAlternativeId: reference?.id ?? null,
    columns,
    dominance: statedDominance(input.criteria, input.alternatives, input.evaluations),
    comparability: input.comparison?.comparability ?? [],
    statement: TRADE_OFF_STATEMENT,
  };
}

/**
 * Factual dominance over the criteria that can be evaluated for BOTH
 * alternatives. It names the criteria it used and the ones it could not, so a
 * reader can see how much the statement is worth. It is not a ranking: every
 * pair is reported independently, and nothing is ordered.
 */
export function statedDominance(
  criteria: readonly DecisionCriterion[],
  alternatives: readonly AlternativeState[],
  evaluations: readonly CriterionEvaluation[],
): DominanceStatement[] {
  const out: DominanceStatement[] = [];
  const comparable = criteria.filter((c) => c.direction !== 'NONE');
  const evalOf = (criterionId: string, alternativeId: string) =>
    evaluations.find((e) => e.criterionId === criterionId && e.alternativeId === alternativeId);

  for (const x of alternatives) {
    for (const y of alternatives) {
      if (x.alternative.id === y.alternative.id) continue;
      const better: string[] = [];
      const equal: string[] = [];
      const notComparable: string[] = [];
      let worseSomewhere = false;
      for (const c of comparable) {
        const ex = evalOf(c.id, x.alternative.id);
        const ey = evalOf(c.id, y.alternative.id);
        const vx = c.style === 'QUALITATIVE' ? ex?.assessment?.rating ?? null : ex?.value ?? null;
        const vy = c.style === 'QUALITATIVE' ? ey?.assessment?.rating ?? null : ey?.value ?? null;
        if (vx === null || vy === null) {
          notComparable.push(c.name);
          continue;
        }
        const kind =
          c.style === 'QUALITATIVE'
            ? (() => {
                const order = ['STRONG_CONCERN', 'CONCERN', 'NEUTRAL', 'SUPPORT', 'STRONG_SUPPORT'];
                const d = order.indexOf(vx) - order.indexOf(vy);
                return d === 0 ? 'SAME' : d > 0 ? 'GAIN' : 'CONCESSION';
              })()
            : orient(c.direction, vy, vx);
        if (kind === 'GAIN') better.push(c.name);
        else if (kind === 'SAME') equal.push(c.name);
        else worseSomewhere = true;
      }
      if (worseSomewhere || better.length === 0) continue;
      out.push({
        alternativeId: x.alternative.id,
        overAlternativeId: y.alternative.id,
        betterOn: better,
        equalOn: equal,
        notComparableOn: notComparable,
        statement:
          `Under the current model, ${x.alternative.label} is better than ${y.alternative.label} on ` +
          `${better.join(', ')}` +
          (equal.length > 0 ? ` and equal on ${equal.join(', ')}` : '') +
          (notComparable.length > 0
            ? `. ${notComparable.join(', ')} could not be compared, so this is a statement about the rest.`
            : '.') +
          ' Whether that settles the decision is management\'s call, not the model\'s.',
      });
    }
  }
  return out;
}
