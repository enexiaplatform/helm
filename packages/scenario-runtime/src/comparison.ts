/**
 * Comparison of future states — the trade-off space (ADR-0019 §8).
 *
 * States differences; never resolves them. Every delta carries the origin and
 * confidence of both sides, a delta that cannot be stated says why, and a
 * movement is interpreted only through the metric's own declared
 * directionality. Nothing here adds deltas together, weights dimensions, or
 * orders the alternatives by anything but the order the caller gave.
 */

import {
  abs,
  compare as decCompare,
  decimal,
  divide,
  isZero,
  periodKey,
  round,
  samePeriod,
  subtract,
  toString as decToString,
} from '@helm/shared';
import { canonicalNumeric } from '@helm/propagation-engine';
import type { Directionality } from '@helm/value-graph';
import type {
  AssumptionDelta,
  ComparisonRow,
  DeltaDirection,
  DirectionalInterpretation,
  FutureState,
  FutureStateValue,
  ModelRef,
  ScenarioComparison,
  StateRef,
  ValueDelta,
} from './types.ts';

export const COMPARISON_STATEMENT =
  'Differences between modelled future states. HELM does not rank, score or recommend: ' +
  'each difference is shown with its origin and confidence, incomplete results are marked ' +
  'rather than filled in, and the choice between states remains a management decision.';

export type ComparedState = {
  readonly ref: StateRef;
  readonly state: FutureState;
  readonly model: ModelRef | null;
  readonly assumptionDeltas: readonly AssumptionDelta[];
};

const rowKey = (v: Pick<FutureStateValue, 'nodeId' | 'period'>) => `${v.nodeId}|${periodKey(v.period)}`;

/** What a movement means under the metric's declared directionality — and nothing more. */
export function interpret(
  directionality: Directionality,
  direction: DeltaDirection,
): DirectionalInterpretation | null {
  if (direction === 'UNRESOLVED') return null;
  if (direction === 'UNCHANGED') return 'NEUTRAL';
  switch (directionality) {
    case 'HIGHER_IS_BETTER':
      return direction === 'UP' ? 'FAVORABLE' : 'UNFAVORABLE';
    case 'LOWER_IS_BETTER':
      return direction === 'DOWN' ? 'FAVORABLE' : 'UNFAVORABLE';
    case 'NEUTRAL':
      return 'NEUTRAL';
    // A target range needs the target; a context-dependent metric needs the
    // objective. Neither is held yet, so the movement is shown, not judged.
    case 'TARGET_RANGE':
    case 'CONTEXT_DEPENDENT':
      return 'CONTEXT_DEPENDENT';
  }
}

function describeMissing(v: FutureStateValue | undefined, side: string): string {
  if (!v) return `${side} does not model this value for this period`;
  return `${side} value is ${v.origin}${v.reason ? `: ${v.reason}` : ''}`;
}

function delta(
  base: FutureStateValue | undefined,
  alt: FutureStateValue | undefined,
  ref: StateRef,
): ValueDelta {
  const any = (alt ?? base)!;
  const common = {
    nodeId: any.nodeId,
    nodeLabel: any.nodeLabel,
    metricKey: any.metricKey,
    metricName: any.metricName,
    dimension: any.dimension,
    period: any.period,
    state: ref,
    unit: any.unit,
    currency: any.currency,
    baselineConfidence: base?.confidence ?? null,
    scenarioConfidence: alt?.confidence ?? null,
    baselineOrigin: base?.origin ?? null,
    scenarioOrigin: alt?.origin ?? null,
  };
  if (!base || base.value === null || !alt || alt.value === null) {
    const reasons = [];
    if (!base || base.value === null) reasons.push(describeMissing(base, 'baseline'));
    if (!alt || alt.value === null) reasons.push(describeMissing(alt, ref.label));
    return {
      ...common,
      baseline: base?.value ?? null,
      scenario: alt?.value ?? null,
      absoluteDelta: null,
      relativeDelta: null,
      direction: 'UNRESOLVED',
      directionalInterpretation: null,
      unresolvedReason: reasons.join('; '),
    };
  }
  if (base.unit !== alt.unit || base.currency !== alt.currency) {
    return {
      ...common,
      baseline: base.value,
      scenario: alt.value,
      absoluteDelta: null,
      relativeDelta: null,
      direction: 'UNRESOLVED',
      directionalInterpretation: null,
      unresolvedReason: 'the two states state this value in different units or currencies',
    };
  }
  const b = decimal(base.value);
  const a = decimal(alt.value);
  const d = subtract(a, b);
  const cmp = decCompare(a, b);
  const direction: DeltaDirection = cmp > 0 ? 'UP' : cmp < 0 ? 'DOWN' : 'UNCHANGED';
  // A percentage's delta is already in points; a relative change of a
  // percentage ("margin fell 9.3%") is the ambiguity that sentence always has.
  const relative =
    base.unit === 'percentage' || isZero(b)
      ? null
      : canonicalNumeric(decToString(round(divide(d, abs(b)), 6)));
  return {
    ...common,
    baseline: canonicalNumeric(base.value),
    scenario: canonicalNumeric(alt.value),
    absoluteDelta: canonicalNumeric(decToString(d)),
    relativeDelta: relative,
    direction,
    directionalInterpretation: interpret(alt.directionality, direction),
    unresolvedReason: null,
  };
}

const sameFork = (a: FutureState, b: FutureState) =>
  new Date(a.run.fork.effectiveAsOf).getTime() === new Date(b.run.fork.effectiveAsOf).getTime() &&
  new Date(a.run.fork.recordedThrough).getTime() === new Date(b.run.fork.recordedThrough).getTime() &&
  a.run.fork.policy === b.run.fork.policy;

const samePeriods = (a: FutureState, b: FutureState) =>
  a.run.periods.length === b.run.periods.length &&
  a.run.periods.every((p) => b.run.periods.some((q) => samePeriod(p, q)));

const sameModel = (a: ModelRef | null, b: ModelRef | null) =>
  a !== null &&
  b !== null &&
  a.engineVersion === b.engineVersion &&
  a.calculations.join(',') === b.calculations.join(',');

export function compareStates(
  baseline: ComparedState,
  alternatives: readonly ComparedState[],
): ScenarioComparison {
  const all = [baseline, ...alternatives];

  // Rows: every (value node, period) any state speaks to, in a stable order.
  const meta = new Map<string, FutureStateValue>();
  for (const s of all) for (const v of s.state.values) if (!meta.has(rowKey(v))) meta.set(rowKey(v), v);
  const keys = [...meta.keys()].sort((x, y) => {
    const a = meta.get(x)!;
    const b = meta.get(y)!;
    return (
      a.dimension.localeCompare(b.dimension) ||
      a.metricName.localeCompare(b.metricName) ||
      a.nodeLabel.localeCompare(b.nodeLabel) ||
      periodKey(a.period).localeCompare(periodKey(b.period))
    );
  });
  const lookup = (s: ComparedState) => new Map(s.state.values.map((v) => [rowKey(v), v]));
  const lookups = all.map(lookup);

  const rows: ComparisonRow[] = keys.map((k) => {
    const m = meta.get(k)!;
    return {
      nodeId: m.nodeId,
      nodeLabel: m.nodeLabel,
      metricKey: m.metricKey,
      metricName: m.metricName,
      dimension: m.dimension,
      directionality: m.directionality,
      period: m.period,
      cells: all.map((s, i) => {
        const v = lookups[i].get(k);
        return {
          state: s.ref,
          value: v?.value ?? null,
          origin: v?.origin ?? null,
          confidence: v?.confidence ?? null,
          reason: v?.reason ?? null,
        };
      }),
    };
  });

  const metricDeltas: ValueDelta[] = [];
  alternatives.forEach((alt, j) => {
    const altLookup = lookups[j + 1];
    for (const k of keys) {
      const base = lookups[0].get(k);
      const other = altLookup.get(k);
      // A row only some third state speaks to (another alternative's extra
      // period) is not a difference between these two.
      if (!base && !other) continue;
      metricDeltas.push(delta(base, other, alt.ref));
    }
  });

  const dimensionDeltas: ScenarioComparison['dimensionDeltas'][number][] = [];
  for (const alt of alternatives) {
    const mine = metricDeltas.filter((d) => d.state.runId === alt.ref.runId);
    for (const dimension of [...new Set(mine.map((d) => d.dimension))].sort()) {
      dimensionDeltas.push({ state: alt.ref, dimension, deltas: mine.filter((d) => d.dimension === dimension) });
    }
  }

  const unresolvedMetrics = metricDeltas
    .filter((d) => d.direction === 'UNRESOLVED')
    .map((d) => ({
      state: d.state,
      nodeId: d.nodeId,
      metricKey: d.metricKey,
      period: d.period,
      reason: d.unresolvedReason ?? 'unresolved',
    }));

  const comparability = alternatives.map((alt) => {
    const warnings: string[] = [];
    const f = sameFork(baseline.state, alt.state);
    const p = samePeriods(baseline.state, alt.state);
    const m = sameModel(baseline.model, alt.model);
    if (!f) {
      warnings.push(
        `simulated at a different boundary (recorded through ${alt.state.run.fork.recordedThrough} ` +
          `vs ${baseline.state.run.fork.recordedThrough}): differences mix the scenario's effect ` +
          'with what was learned in between',
      );
    }
    if (!p) {
      warnings.push(
        'models different periods: values for a period only one state models are unresolved, ' +
          'never compared across periods',
      );
    }
    if (!m) warnings.push('uses a different model version: differences may come from the model');
    return { state: alt.ref, sameFork: f, samePeriods: p, sameModel: m, warnings };
  });

  return {
    baseline: baseline.ref,
    alternatives: alternatives.map((a) => a.ref),
    rows,
    metricDeltas,
    dimensionDeltas,
    assumptionDeltas: alternatives.flatMap((a) => a.assumptionDeltas),
    unresolvedMetrics,
    constraints: all.map((s) => ({ state: s.ref, results: s.state.constraints })),
    completeness: all.map((s) => ({ state: s.ref, completeness: s.state.completeness })),
    comparability,
    statement: COMPARISON_STATEMENT,
  };
}
