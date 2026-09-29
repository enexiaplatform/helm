/**
 * Value state under a two-time lens.
 *
 * One value node is read once per layer — ACTUAL, FORECAST, ESTIMATE, ASSUMED,
 * TARGET and MODELLED — through the propagation engine's own observation
 * selector, so the twin and a calculation run can never disagree about which
 * observation "is" the value at a lens. The layers are never merged: what
 * Finance reported, what the model derived and what the target says are three
 * items, side by side.
 *
 * A MODELLED reading names the calculation step that produced it, and says
 * whether it is STALE: whether any source input anywhere upstream of it in
 * its run has been superseded by an observation HELM knew of by the boundary.
 * Staleness is never "fixed" by recomputing — the model value is reported as
 * it was computed, with the fact that its inputs moved.
 */

import {
  ok,
  parsePeriodKey,
  periodKey,
  type Period,
  type Result,
  type Scope,
} from '@helm/shared';
import {
  canonicalNumeric,
  policyOrder,
  selectObservation,
  type CalculationRun,
  type CalculationStep,
  type PropagationEngine,
} from '@helm/propagation-engine';
import type { ObservationType, ValueGraph, ValueMetricDefinition, ValueNode, ValueObservation } from '@helm/value-graph';
import type { StateLayer, TwinLens, ValueReading } from './types.ts';

export const LAYER_OBSERVATION: Readonly<Record<'ACTUAL' | 'FORECAST' | 'ESTIMATE' | 'ASSUMED' | 'TARGET' | 'MODELLED', ObservationType>> = {
  ACTUAL: 'ACTUAL',
  FORECAST: 'FORECAST',
  ESTIMATE: 'ESTIMATE',
  ASSUMED: 'ASSUMPTION',
  TARGET: 'TARGET',
  MODELLED: 'DERIVED',
};

export type ReadLayer = keyof typeof LAYER_OBSERVATION;

/** A per-composition cache over the value graph, so one snapshot reads each node's history once. */
export function memoizedValueGraph(vg: ValueGraph): ValueGraph {
  const cache = new Map<string, ReturnType<ValueGraph['getObservations']>>();
  return {
    ...vg,
    getObservations(scope, query) {
      const key = JSON.stringify([scope.orgId, query]);
      if (!cache.has(key)) cache.set(key, vg.getObservations(scope, query));
      return cache.get(key)!;
    },
  };
}

export const exactOf = (o: ValueObservation): string => {
  const exact = o.metadata?.exactValue;
  return canonicalNumeric(typeof exact === 'string' ? exact : String(o.numericValue ?? ''));
};

export type NodeReading =
  | { readonly status: 'KNOWN'; readonly reading: ValueReading; readonly periodKey: string | null }
  | { readonly status: 'UNKNOWN' | 'BLOCKED'; readonly reading: ValueReading; readonly periodKey: string | null; readonly reason: string };

export type TraceCache = {
  run(runId: string): Promise<CalculationRun | null>;
  steps(runId: string): Promise<readonly CalculationStep[]>;
};

export function traceCache(engine: PropagationEngine, scope: Scope): TraceCache {
  const runs = new Map<string, Promise<CalculationRun | null>>();
  const traces = new Map<string, Promise<readonly CalculationStep[]>>();
  return {
    run(runId) {
      if (!runs.has(runId)) runs.set(runId, engine.getRun(scope, runId).then((r) => (r.ok ? r.value : null)));
      return runs.get(runId)!;
    },
    steps(runId) {
      if (!traces.has(runId)) traces.set(runId, engine.getTrace(scope, runId).then((r) => (r.ok ? r.value : [])));
      return traces.get(runId)!;
    },
  };
}

function emptyReading(node: ValueNode, metric: ValueMetricDefinition, layer: StateLayer): ValueReading {
  return {
    nodeId: node.id,
    metricKey: metric.key,
    metricName: metric.name,
    dimension: metric.dimension,
    directionality: metric.directionality,
    layer,
    value: null,
    unit: metric.unitType,
    currency: metric.defaultCurrency,
    period: null,
    observationId: null,
    observationType: null,
    effectiveAt: null,
    recordedAt: null,
    sourceSystem: null,
    confidence: null,
    calculation: null,
    calculationRunId: null,
    calculationStepId: null,
    origin: null,
    freshness: 'NOT_APPLICABLE',
    staleInputs: [],
    expectedOutcome: false,
  };
}

/**
 * Which source inputs of `step`, anywhere upstream in its run, a later
 * observation known by the boundary has superseded.
 */
async function staleInputsOf(
  vg: ValueGraph,
  scope: Scope,
  lens: TwinLens,
  run: CalculationRun,
  steps: readonly CalculationStep[],
  step: CalculationStep,
): Promise<string[]> {
  const producer = new Map<string, CalculationStep>();
  for (const s of steps) if (s.outputObservationId) producer.set(s.outputObservationId, s);
  const visited = new Set<string>();
  const stale: string[] = [];
  const order = policyOrder[run.context.preference];
  const period: Period | null = run.context.period;
  const lensDates = { effectiveAsOf: new Date(lens.effectiveAsOf), recordedThrough: new Date(lens.recordedThrough) };
  const visit = async (s: CalculationStep): Promise<void> => {
    if (visited.has(s.id)) return;
    visited.add(s.id);
    for (const t of s.inputs) {
      const parts = t.components ?? [{ nodeId: t.nodeId, observationId: t.observationId, boundTo: t.boundTo, override: t.override }];
      for (const p of parts) {
        if (p.boundTo === 'RUN_OUTPUT') {
          const up = producer.get(p.observationId);
          if (up) await visit(up);
          continue;
        }
        if (p.boundTo !== 'SOURCE_OBSERVATION') continue;
        const now = await selectObservation(vg, scope, p.nodeId, order, lensDates, null, period);
        if (now.ok && now.value && now.value.id !== p.observationId) {
          stale.push(`${t.name} (${t.metricKey}): ${canonicalNumeric(t.value)} → ${exactOf(now.value)}, ${now.value.observationType} recorded ${now.value.recordedAt}`);
        }
      }
    }
  };
  await visit(step);
  return [...new Set(stale)].sort();
}

/**
 * Every reading one node has under the lens, for the given layers and periods.
 * Point-in-time claims answer every period once; period claims answer their own.
 */
export async function readNode(
  vg: ValueGraph,
  traces: TraceCache,
  scope: Scope,
  lens: TwinLens,
  node: ValueNode,
  metric: ValueMetricDefinition,
  layers: readonly ReadLayer[],
  periods: readonly string[],
  blocked: ReadonlyMap<string, CalculationStep>,
): Promise<Result<NodeReading[]>> {
  const out: NodeReading[] = [];
  const lensDates = { effectiveAsOf: new Date(lens.effectiveAsOf), recordedThrough: new Date(lens.recordedThrough) };
  for (const layer of layers) {
    const seen = new Set<string>();
    const failures: string[] = [];
    for (const key of periods) {
      const parsed = parsePeriodKey(key);
      const period = parsed.ok ? parsed.value : null;
      const selected = await selectObservation(vg, scope, node.id, [LAYER_OBSERVATION[layer]], lensDates, null, period);
      if (!selected.ok) {
        // A claim about a different period is not an error for this layer; an ambiguity is.
        if (selected.error.code !== 'calculation.time_context_mismatch') failures.push(selected.error.message);
        continue;
      }
      const o = selected.value;
      if (!o || seen.has(o.id)) continue;
      seen.add(o.id);
      const claimPeriod = o.periodStart ? key : null;
      let reading: ValueReading = {
        ...emptyReading(node, metric, layer),
        value: exactOf(o),
        unit: o.unitType,
        currency: o.currency,
        period: claimPeriod,
        observationId: o.id,
        observationType: o.observationType,
        effectiveAt: o.effectiveAt ?? o.periodStart,
        recordedAt: o.recordedAt,
        sourceSystem: o.sourceSystem,
        confidence: o.confidence,
      };
      if (layer === 'MODELLED') {
        const calc = typeof o.metadata?.derivedByCalculation === 'string' ? o.metadata.derivedByCalculation : null;
        const runId = typeof o.metadata?.calculationRunId === 'string' ? o.metadata.calculationRunId : null;
        let stepId: string | null = null;
        let staleInputs: string[] = [];
        if (runId) {
          const [run, steps] = await Promise.all([traces.run(runId), traces.steps(runId)]);
          const step = steps.find((s) => s.outputObservationId === o.id) ?? null;
          stepId = step?.id ?? null;
          if (run && step) staleInputs = await staleInputsOf(vg, scope, lens, run, steps, step);
        }
        reading = {
          ...reading,
          calculation: calc,
          calculationRunId: runId,
          calculationStepId: stepId,
          freshness: staleInputs.length > 0 ? 'STALE' : 'CLEAN',
          staleInputs,
        };
      }
      out.push({ status: 'KNOWN', reading, periodKey: claimPeriod });
    }
    if (failures.length > 0 && seen.size === 0) {
      out.push({
        status: 'UNKNOWN',
        reading: emptyReading(node, metric, layer),
        periodKey: null,
        reason: [...new Set(failures)].join(' '),
      });
    }
    // The latest baseline run could not compute this node: say so, never estimate.
    if (layer === 'MODELLED' && seen.size === 0 && blocked.has(node.id)) {
      const step = blocked.get(node.id)!;
      out.push({
        status: 'BLOCKED',
        reading: { ...emptyReading(node, metric, layer), calculation: `${step.calculationKey}@${step.calculationVersion}`, calculationRunId: step.runId, calculationStepId: step.id },
        periodKey: null,
        reason: `${step.status}: ${step.errorMessage ?? step.errorCode ?? 'the model could not compute it'}`,
      });
    }
  }
  return ok(out);
}

export const periodKeyOf = (p: Period): string => periodKey(p);
