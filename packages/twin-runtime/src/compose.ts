/**
 * Composing a twin snapshot (ADR-0023 §4).
 *
 *   structure (ontology, under the lens)
 *   + value state (value graph + propagation: every layer, never merged)
 *   + constraints (the latest baseline simulation inside the boundary)
 *   + objectives (targets against actual, forecast, model and committed future)
 *   + decisions, commitments, intents, assumptions (reconstructed as of the boundary)
 *   + governance (the authority runtime's projection, inside the boundary)
 *   + attention (named rules over all of the above)
 *   = one manifest, fingerprinted.
 *
 * The composer orchestrates; it recalculates nothing. Every value it holds was
 * read through the kernel that owns it, and every item names what it read.
 */

import {
  compare,
  decimal,
  fail,
  makePeriod,
  ok,
  periodContaining,
  periodKey,
  type Result,
  type Scope,
} from '@helm/shared';
import type { GraphStore } from '@helm/graph-store';
import {
  ENGINE_VERSION,
  calculationRef,
  type CalculationRegistry,
  type CalculationStep,
  type PropagationEngine,
} from '@helm/propagation-engine';
import type { ValueGraph, ValueMetricDefinition, ValueNode } from '@helm/value-graph';
import type { ConstraintDefinition, FutureState, ScenarioRuntime } from '@helm/scenario-runtime';
import type { DecisionStore } from '@helm/decision-runtime';
import type { AuthorityRuntime, AuthorityStore } from '@helm/authority-runtime';
import { ATTENTION_RULES_VERSION, difference, snapshotAttention } from './attention.ts';
import { composeManagement } from './management.ts';
import { sensitivityOfMetric } from './sensitivity.ts';
import { classificationOf, orgPlacement, readStructure, type StructureView } from './structure.ts';
import {
  TwinErrors,
  type CompletenessReason,
  type KernelRef,
  type ManagementCategory,
  type ModelIdentity,
  type ObjectivePosition,
  type SnapshotSpec,
  type TwinCompleteness,
  type TwinItem,
  type ValueReading,
} from './types.ts';
import { memoizedValueGraph, readNode, traceCache, type ReadLayer } from './values.ts';

export const COMPOSER_VERSION = 'helm-twin-composer@1';

export type TwinSources = {
  readonly graph: GraphStore;
  readonly valueGraph: ValueGraph;
  readonly engine: PropagationEngine;
  readonly registry: CalculationRegistry;
  readonly scenarios: ScenarioRuntime;
  readonly decisions: DecisionStore;
  readonly authority: AuthorityRuntime;
  readonly authorityStore: AuthorityStore;
  /** Feasibility constraints the scenario runtime evaluates, to place them in scope. */
  readonly constraints: readonly ConstraintDefinition[];
};

export type Composition = {
  readonly items: readonly TwinItem[];
  readonly completeness: TwinCompleteness;
  readonly reasons: readonly CompletenessReason[];
  readonly sourceReferences: readonly KernelRef[];
  readonly model: ModelIdentity;
};

const ms = (t: string | null | undefined): number => (t ? Date.parse(t) : NaN);
const ref = (kind: KernelRef['kind'], id: string, pin: string | null = null, label: string | null = null): KernelRef => ({ kind, id, pin, label });
const SEVERITY: Readonly<Record<TwinCompleteness, number>> = { COMPLETE: 0, PARTIAL: 1, DEGRADED: 2, INVALID: 3 };

export function modelIdentity(registry: CalculationRegistry): ModelIdentity {
  return {
    engineVersion: ENGINE_VERSION,
    calculations: registry.all().map(calculationRef).sort(),
    attentionRules: ATTENTION_RULES_VERSION,
    composer: COMPOSER_VERSION,
  };
}

/** The default business period of a lens: the quarter its effective time falls in. */
export const defaultPeriods = (effectiveAsOf: string): string[] => [periodKey(periodContaining(effectiveAsOf, 'QUARTER'))];

function valueCategories(reading: ValueReading): ManagementCategory[] {
  const out: ManagementCategory[] = ['VALUE'];
  if (reading.layer === 'ACTUAL') out.push('PERFORMANCE');
  if (reading.layer === 'TARGET') out.push('OBJECTIVES');
  if (reading.dimension === 'RISK' || reading.dimension === 'RESILIENCE') out.push('RISKS');
  return out;
}

function valueItem(node: ValueNode, metric: ValueMetricDefinition, reading: ValueReading, status: TwinItem['status'], reason: string | null, keySuffix = ''): TwinItem {
  const refs: KernelRef[] = [ref('VALUE_NODE', node.id, null, node.label)];
  if (reading.observationId) refs.push(ref('OBSERVATION', reading.observationId, reading.recordedAt, reading.observationType));
  if (reading.calculationRunId) refs.push(ref('CALCULATION_RUN', reading.calculationRunId));
  if (reading.calculationStepId) refs.push(ref('CALCULATION_STEP', reading.calculationStepId, null, reading.calculation));
  return {
    key: `value:${node.id}:${reading.layer}${reading.period ? `:${reading.period}` : ''}${keySuffix}`,
    kind: 'VALUE',
    categories: valueCategories(reading),
    label: `${node.label} — ${reading.layer.toLowerCase().replaceAll('_', ' ')}`,
    subjectEntityId: node.subjectEntityId,
    layer: reading.layer,
    status,
    state: reading as unknown as Record<string, unknown>,
    refs,
    sensitivity: sensitivityOfMetric(metric.key, node.metadata?.sensitivity ?? metric.metadata?.sensitivity),
    reason,
  };
}

/** Values of a simulated future (SCENARIO or COMMITTED_FUTURE), read from the stored run — never re-run. */
async function futureItems(
  sources: TwinSources,
  scope: Scope,
  view: StructureView,
  enterprise: boolean,
  future: FutureState,
  layer: 'SCENARIO' | 'COMMITTED_FUTURE',
  expected: ReadonlySet<string>,
): Promise<Result<TwinItem[]>> {
  const out: TwinItem[] = [];
  const nodes = await sources.valueGraph.findValueNodes(scope, { limit: 100000 });
  if (!nodes.ok) return nodes;
  const byId = new Map(nodes.value.map((n) => [n.id, n]));
  const traces = traceCache(sources.engine, scope);
  for (const v of [...future.values].sort((a, b) => a.nodeId.localeCompare(b.nodeId) || periodKey(a.period).localeCompare(periodKey(b.period)))) {
    if (!enterprise && !(v.subjectEntityId && view.inScope.has(v.subjectEntityId))) continue;
    const node = byId.get(v.nodeId);
    if (!node) continue;
    const period = periodKey(v.period);
    let stepId: string | null = null;
    if (v.calculationRunId && v.observationId) {
      const steps = await traces.steps(v.calculationRunId);
      stepId = steps.find((s) => s.outputObservationId === v.observationId)?.id ?? null;
    }
    const reading: ValueReading = {
      nodeId: v.nodeId,
      metricKey: v.metricKey,
      metricName: v.metricName,
      dimension: v.dimension,
      directionality: v.directionality,
      layer,
      value: v.value,
      unit: v.unit,
      currency: v.currency,
      period,
      observationId: v.observationId,
      observationType: v.observationId ? (layer === 'SCENARIO' || future.run.stateKind === 'SCENARIO' ? 'SCENARIO' : 'DERIVED') : null,
      effectiveAt: v.period.start,
      recordedAt: future.run.completedAt,
      sourceSystem: 'helm',
      confidence: v.confidence,
      calculation: v.calculation,
      calculationRunId: v.calculationRunId,
      calculationStepId: stepId,
      origin: v.origin,
      freshness: 'NOT_APPLICABLE',
      staleInputs: [],
      expectedOutcome: expected.has(`${v.nodeId}|${period}`),
    };
    const status: TwinItem['status'] = v.origin === 'BLOCKED' ? 'BLOCKED' : v.origin === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'KNOWN';
    const item = valueItem(node, { key: v.metricKey, metadata: {} } as ValueMetricDefinition, reading, status, v.reason);
    out.push({
      ...item,
      categories: layer === 'COMMITTED_FUTURE' ? [...item.categories, 'COMMITMENTS'] : item.categories,
      refs: [...item.refs, ref('SCENARIO_RUN', future.run.id, future.run.fingerprint, future.label)],
      label: `${node.label} — ${layer === 'SCENARIO' ? future.label : 'committed future'}`,
    });
  }
  // What the future assumed, as stated by its revision's overrides — shown apart from its outcomes.
  if (future.revision) {
    const overrides = await sources.scenarios.listOverrides(scope, future.revision.id);
    if (!overrides.ok) return overrides;
    for (const o of overrides.value) {
      if (!enterprise && !(o.subjectEntityId && view.inScope.has(o.subjectEntityId))) continue;
      out.push({
        key: `override:${o.targetNodeId}:${o.period ? periodKey(o.period) : 'all'}`,
        kind: 'ASSUMPTION',
        categories: ['ASSUMPTIONS'],
        label: o.rationale,
        subjectEntityId: o.subjectEntityId,
        layer,
        status: 'KNOWN',
        state: { source: 'SCENARIO_OVERRIDE', metricKey: o.metricKey, operation: o.operation, value: o.value, unit: o.unit, currency: o.currency, provenanceKind: o.provenanceKind, confidence: o.confidence, overrideType: o.overrideType },
        refs: [ref('SCENARIO_REVISION', future.revision.id, future.revision.fingerprint), ref('VALUE_NODE', o.targetNodeId)],
        sensitivity: sensitivityOfMetric(o.metricKey),
        reason: null,
      });
    }
  }
  return ok(out);
}

function constraintItems(future: FutureState, view: StructureView, enterprise: boolean, definitions: readonly ConstraintDefinition[]): TwinItem[] {
  const byKey = new Map<string, string>([...view.entities.values()].map((e) => [e.canonicalKey, e.id as string]));
  const subjectsOf = (d: ConstraintDefinition): string[] => {
    const keys: string[] = [];
    for (const op of [d.required, d.available]) {
      if ('metricKey' in op) keys.push(op.subject);
      else keys.push(...op.sumOf.subjects);
    }
    return keys.map((k) => byKey.get(k)).filter((x): x is string => Boolean(x));
  };
  const out: TwinItem[] = [];
  for (const c of future.constraints) {
    const def = definitions.find((d) => d.key === c.constraintKey);
    const subjects = def ? subjectsOf(def) : [];
    if (!enterprise && def && !subjects.some((id) => view.inScope.has(id))) continue;
    out.push({
      key: `constraint:${c.constraintKey}:${periodKey(c.period)}`,
      kind: 'CONSTRAINT',
      categories: ['CONSTRAINTS'],
      label: c.name,
      subjectEntityId: subjects[0] ?? null,
      layer: future.run.stateKind === 'BASELINE' ? 'MODELLED' : null,
      status: c.status === 'UNKNOWN' ? 'UNKNOWN' : 'KNOWN',
      state: {
        constraintKey: c.constraintKey,
        version: c.constraintVersion,
        kind: c.kind,
        period: periodKey(c.period),
        status: c.status,
        threshold: c.threshold,
        actual: c.actual,
        breachAmount: c.breachAmount,
        unit: c.unit,
        severity: c.severity,
        explanation: c.explanation,
        simulatedAt: future.run.fork.effectiveAsOf,
      },
      refs: [ref('SCENARIO_RUN', future.run.id, future.run.fingerprint, future.label), ref('CONSTRAINT_RESULT', `${future.run.id}:${c.constraintKey}:${periodKey(c.period)}`, c.constraintVersion)],
      sensitivity: 'GENERAL_MANAGEMENT',
      reason: c.status === 'UNKNOWN' ? c.explanation : null,
    });
  }
  return out;
}

function objectiveItems(values: readonly TwinItem[]): TwinItem[] {
  const out: TwinItem[] = [];
  const st = (i: TwinItem) => i.state as unknown as ValueReading;
  for (const t of values.filter((i) => i.kind === 'VALUE' && i.layer === 'TARGET' && i.status === 'KNOWN')) {
    const target = st(t);
    const same = (layer: string) =>
      values.find((i) => i.kind === 'VALUE' && i.layer === layer && i.status === 'KNOWN' && st(i).nodeId === target.nodeId && (st(i).period === target.period || st(i).period === null || target.period === null));
    const actual = same('ACTUAL');
    const modelled = same('MODELLED');
    const forecast = same('FORECAST');
    const committed = values.find(
      (i) => i.kind === 'VALUE' && i.layer === 'COMMITTED_FUTURE' && i.status === 'KNOWN' && (i.state.nodeId as string) === target.nodeId,
    );
    const current = actual ?? modelled ?? null;
    const currentValue = current ? String(st(current).value) : null;
    const variance = currentValue !== null && target.value !== null ? difference(currentValue, target.value) : null;
    const meets = (delta: string): boolean | null => {
      const sign = compare(decimal(delta), decimal('0'));
      if (target.directionality === 'HIGHER_IS_BETTER') return sign >= 0;
      if (target.directionality === 'LOWER_IS_BETTER') return sign <= 0;
      return null;
    };
    const forecastGap = forecast && target.value !== null ? difference(String(st(forecast).value), target.value) : null;
    let position: ObjectivePosition = 'NOT_ASSESSABLE';
    if (variance !== null && meets(variance) !== null) position = meets(variance) ? 'MEETS_TARGET' : 'SHORT_OF_TARGET';
    else if (forecastGap !== null && meets(forecastGap) !== null) position = meets(forecastGap) ? 'FORECAST_MEETS_TARGET' : 'FORECAST_SHORT_OF_TARGET';
    const label = t.label.replace(/ — target$/, '');
    out.push({
      key: `objective:${target.nodeId}${target.period ? `:${target.period}` : ''}`,
      kind: 'OBJECTIVE',
      categories: ['OBJECTIVES', 'PERFORMANCE'],
      label,
      subjectEntityId: t.subjectEntityId,
      layer: null,
      status: 'KNOWN',
      state: {
        nodeId: target.nodeId,
        metricKey: target.metricKey,
        label,
        unit: target.unit,
        currency: target.currency,
        period: target.period,
        directionality: target.directionality,
        target: target.value,
        actual: actual ? st(actual).value : null,
        forecast: forecast ? st(forecast).value : null,
        modelled: modelled ? st(modelled).value : null,
        committedFuture: committed ? (committed.state.value as string | null) : null,
        current: currentValue,
        currentLayer: current ? st(current).layer : null,
        varianceToTarget: variance,
        forecastToTarget: forecastGap,
        position,
      },
      refs: [ref('TWIN_ITEM', t.key), ...(current ? [ref('TWIN_ITEM', current.key)] : []), ...(forecast ? [ref('TWIN_ITEM', forecast.key)] : []), ...(committed ? [ref('TWIN_ITEM', committed.key)] : []), ...t.refs.slice(0, 1)],
      sensitivity: t.sensitivity,
      reason: position === 'NOT_ASSESSABLE' ? 'no current reading, or a direction HELM does not judge' : null,
    });
  }
  return out;
}

/** When a node has claims only about periods the snapshot does not read, say which. */
async function otherPeriodClaims(vg: ValueGraph, scope: Scope, nodeId: string, spec: SnapshotSpec): Promise<string | null> {
  const all = await vg.getObservations(scope, { nodeId, scenarioEntityId: null, limit: 200 });
  if (!all.ok) return null;
  const T = ms(spec.lens.recordedThrough);
  const periods = new Set<string>();
  for (const o of all.value) {
    if (ms(o.recordedAt) > T || !o.periodStart || !o.periodEnd) continue;
    const p = makePeriod(o.periodStart, o.periodEnd, 'CUSTOM');
    const match = ['QUARTER', 'YEAR', 'MONTH'].map((g) => makePeriod(o.periodStart!, o.periodEnd!, g as 'QUARTER')).find((x) => x.ok);
    periods.add(match && match.ok ? periodKey(match.value) : p.ok ? periodKey(p.value) : `${o.periodStart}..${o.periodEnd}`);
  }
  const outside = [...periods].filter((p) => !spec.periods.includes(p)).sort();
  return outside.length > 0 ? `claims exist for ${outside.join(', ')}, not for ${spec.periods.join(', ')} — a claim about one period does not answer another` : null;
}

export async function composeSnapshot(sources: TwinSources, scope: Scope, spec: SnapshotSpec): Promise<Result<Composition>> {
  const E = ms(spec.lens.effectiveAsOf);
  const T = ms(spec.lens.recordedThrough);
  const model = modelIdentity(sources.registry);
  if (Number.isNaN(E) || Number.isNaN(T)) return fail(TwinErrors.INVALID_INPUT, 'A snapshot needs an explicit effectiveAsOf and recordedThrough.');
  if (spec.periods.length === 0) return fail(TwinErrors.INVALID_INPUT, 'A snapshot reads value state for at least one business period.');

  const reasons: CompletenessReason[] = [];
  const sourceRefs: KernelRef[] = [];
  const items: TwinItem[] = [];
  const enterprise = spec.scope.kind === 'ENTERPRISE';
  const vg = memoizedValueGraph(sources.valueGraph);

  const view = await readStructure(sources.graph, scope, spec.lens, spec.scope);
  if (!view.ok) {
    if (view.error.code !== TwinErrors.SCOPE_UNRESOLVED) return view;
    return ok({
      items: [],
      completeness: 'INVALID',
      reasons: [{ code: 'SCOPE_UNRESOLVED', severity: 'INVALID', message: view.error.message, itemKey: null }],
      sourceReferences: [],
      model,
    });
  }
  const v = view.value;

  // ------------------------------------------------------------- structure
  for (const [id, membership] of [...v.inScope.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const e = v.entities.get(id)!;
    const cls = e.entityTypeKey === 'Customer' ? classificationOf(v, e.id) : null;
    items.push({
      key: `entity:${e.id}`,
      kind: 'ENTITY',
      categories: e.entityTypeKey === 'Objective' ? ['STRUCTURE', 'OBJECTIVES'] : e.entityTypeKey === 'Risk' ? ['STRUCTURE', 'RISKS'] : e.entityTypeKey === 'Constraint' ? ['STRUCTURE', 'CONSTRAINTS'] : ['STRUCTURE'],
      label: e.name,
      subjectEntityId: e.id,
      layer: null,
      status: 'KNOWN',
      state: {
        name: e.name,
        entityTypeKey: e.entityTypeKey,
        canonicalKey: e.canonicalKey,
        version: e.version,
        validFrom: e.validFrom,
        membership,
        attributes: e.attributes,
        placement: orgPlacement(v, e.id),
        ...(e.entityTypeKey === 'Customer' ? { classification: cls?.classification ?? null } : {}),
      },
      refs: [ref('ENTITY_VERSION', e.id, `v${e.version}`, e.name), ...(cls ? [ref('RELATIONSHIP', cls.relationshipId, null, cls.classification)] : [])],
      sensitivity: 'GENERAL_MANAGEMENT',
      reason: null,
    });
    if (e.entityTypeKey === 'Customer' && !cls) {
      reasons.push({ code: 'UNCLASSIFIED_CUSTOMER', severity: 'DEGRADED', message: `${e.name} carries no account classification at this lens.`, itemKey: `entity:${e.id}` });
    }
  }
  for (const r of v.relationships) {
    if (!(v.inScope.has(r.sourceEntityId) && v.inScope.has(r.targetEntityId))) continue;
    const from = v.entities.get(r.sourceEntityId)!;
    const to = v.entities.get(r.targetEntityId)!;
    items.push({
      key: `rel:${r.id}`,
      kind: 'RELATIONSHIP',
      categories: ['STRUCTURE'],
      label: `${from.name} ${r.relationshipTypeKey.replaceAll('_', ' ').toLowerCase()} ${to.name}`,
      subjectEntityId: r.sourceEntityId,
      layer: null,
      status: 'KNOWN',
      state: { type: r.relationshipTypeKey, sourceEntityId: r.sourceEntityId, targetEntityId: r.targetEntityId, weight: r.weight, validFrom: r.validFrom },
      refs: [ref('RELATIONSHIP', r.id, r.ingestedAt, r.relationshipTypeKey)],
      sensitivity: 'GENERAL_MANAGEMENT',
      reason: null,
    });
  }

  // ----------------------------------------------------------------- values
  const metrics = await sources.valueGraph.findMetricDefinitions(scope, { includeInactive: true });
  if (!metrics.ok) return metrics;
  const metricByKey = new Map(metrics.value.map((m) => [m.key, m]));
  const nodes = await sources.valueGraph.findValueNodes(scope, { limit: 100000 });
  if (!nodes.ok) return nodes;
  const nodesInScope = nodes.value
    .filter((n) => ms(n.createdAt) <= T)
    .filter((n) => (n.subjectEntityId ? v.inScope.has(n.subjectEntityId) : enterprise))
    .sort((a, b) => a.id.localeCompare(b.id));

  const runs = await sources.scenarios.listRuns(scope, {});
  if (!runs.ok) return runs;
  const completedByT = runs.value.filter((r) => r.completedAt !== null && ms(r.completedAt) <= T && (r.status === 'COMPLETED' || r.status === 'PARTIAL'));

  if (spec.kind === 'CURRENT' || spec.kind === 'HISTORICAL' || spec.kind === 'EXPECTED') {
    // The latest baseline simulation inside both lenses: what the model says the baseline is.
    const baseline = completedByT
      .filter((r) => r.stateKind === 'BASELINE' && ms(r.fork.effectiveAsOf) <= E)
      .sort((a, b) => ms(a.completedAt) - ms(b.completedAt) || a.id.localeCompare(b.id))
      .pop();
    const blocked = new Map<string, CalculationStep>();
    let baselineState: FutureState | null = null;
    if (baseline) {
      const fs = await sources.scenarios.getFutureState(scope, baseline.id);
      if (!fs.ok) return fs;
      baselineState = fs.value;
      sourceRefs.push(ref('SCENARIO_RUN', baseline.id, baseline.fingerprint, 'baseline'));
      for (const pr of baseline.periodRuns) {
        const steps = await sources.engine.getTrace(scope, pr.calculationRunId);
        if (!steps.ok) return steps;
        for (const s of steps.value) if (s.status === 'BLOCKED' || s.status === 'FAILED') blocked.set(s.outputNodeId, s);
      }
    }

    const layers: readonly ReadLayer[] = spec.kind === 'EXPECTED' ? ['FORECAST', 'MODELLED', 'TARGET'] : ['ACTUAL', 'FORECAST', 'ESTIMATE', 'ASSUMED', 'TARGET', 'MODELLED'];
    const traces = traceCache(sources.engine, scope);
    const valueItems: TwinItem[] = [];
    for (const node of nodesInScope) {
      const metric = metricByKey.get(node.metricKey);
      if (!metric) continue;
      const readings = await readNode(vg, traces, scope, spec.lens, node, metric, layers, spec.periods, blocked);
      if (!readings.ok) return readings;
      const otherPeriods = readings.value.length === 0 ? await otherPeriodClaims(vg, scope, node.id, spec) : null;
      if (readings.value.length === 0) {
        valueItems.push(
          valueItem(
            node,
            metric,
            { ...({} as ValueReading), nodeId: node.id, metricKey: metric.key, metricName: metric.name, dimension: metric.dimension, directionality: metric.directionality, layer: 'ACTUAL', value: null, unit: metric.unitType, currency: metric.defaultCurrency, period: null, observationId: null, observationType: null, effectiveAt: null, recordedAt: null, sourceSystem: null, confidence: null, calculation: null, calculationRunId: null, calculationStepId: null, origin: null, freshness: 'NOT_APPLICABLE', staleInputs: [], expectedOutcome: false },
            'UNAVAILABLE',
            otherPeriods ?? 'nothing in the source world or the model speaks to this value under this lens',
            ':none',
          ),
        );
        reasons.push({ code: otherPeriods ? 'OTHER_PERIOD_ONLY' : 'NO_READING', severity: 'PARTIAL', message: `${node.label}: ${otherPeriods ?? 'no reading under this lens'}.`, itemKey: `value:${node.id}:ACTUAL:none` });
        continue;
      }
      for (const r of readings.value) {
        if (r.status === 'KNOWN') {
          const item = valueItem(node, metric, r.reading, 'KNOWN', null);
          valueItems.push(item);
          if (r.reading.freshness === 'STALE') {
            reasons.push({ code: 'MODEL_STALE', severity: 'DEGRADED', message: `${node.label}: the model value predates inputs HELM knew of — ${r.reading.staleInputs.join('; ')}.`, itemKey: item.key });
          }
          if (r.reading.calculationRunId) sourceRefs.push(ref('CALCULATION_RUN', r.reading.calculationRunId));
        } else {
          const item = valueItem(node, metric, r.reading, r.status, r.reason, ':unresolved');
          valueItems.push(item);
          reasons.push({ code: r.status === 'BLOCKED' ? 'MODEL_BLOCKED' : 'VALUE_UNKNOWN', severity: 'PARTIAL', message: `${node.label} (${r.reading.layer.toLowerCase()}): ${r.reason}`, itemKey: item.key });
        }
      }
    }
    items.push(...valueItems);
    if (baselineState) items.push(...constraintItems(baselineState, v, enterprise, sources.constraints));
  }

  let onlyDecisionId: string | null = null;
  if (spec.kind === 'SCENARIO') {
    if (!spec.scenarioRunId) return fail(TwinErrors.INVALID_INPUT, 'A SCENARIO snapshot names the scenario run it describes.');
    const run = runs.value.find((r) => r.id === spec.scenarioRunId);
    if (!run) return fail(TwinErrors.NOT_FOUND, `Scenario run ${spec.scenarioRunId} not found.`);
    if (!completedByT.some((r) => r.id === run.id)) {
      return ok({ items: [], completeness: 'INVALID', reasons: [{ code: 'RUN_NOT_KNOWN', severity: 'INVALID', message: 'The scenario run had not completed by the knowledge boundary.', itemKey: null }], sourceReferences: [], model });
    }
    const future = await sources.scenarios.getFutureState(scope, run.id);
    if (!future.ok) return future;
    const values = await futureItems(sources, scope, v, enterprise, future.value, 'SCENARIO', new Set());
    if (!values.ok) return values;
    items.push(...values.value, ...constraintItems(future.value, v, enterprise, sources.constraints));
    sourceRefs.push(ref('SCENARIO_RUN', run.id, run.fingerprint, future.value.label));
    if (future.value.completeness !== 'COMPLETE') {
      reasons.push({ code: 'FUTURE_INCOMPLETE', severity: future.value.completeness === 'INVALID' ? 'INVALID' : 'PARTIAL', message: `The simulated future is ${future.value.completeness}.`, itemKey: null });
    }
  }

  if (spec.kind === 'COMMITTED_FUTURE') {
    if (!spec.commitmentId) return fail(TwinErrors.INVALID_INPUT, 'A COMMITTED_FUTURE snapshot names the commitment it describes.');
    const commitment = await sources.decisions.getCommitment(scope, spec.commitmentId);
    if (!commitment.ok) return commitment;
    if (!commitment.value) return fail(TwinErrors.NOT_FOUND, `Commitment ${spec.commitmentId} not found.`);
    const c = commitment.value;
    if (ms(c.committedAt) > T) {
      return ok({ items: [], completeness: 'INVALID', reasons: [{ code: 'COMMITMENT_NOT_KNOWN', severity: 'INVALID', message: 'The commitment had not been made by the knowledge boundary.', itemKey: null }], sourceReferences: [], model });
    }
    // The run is the one the commitment's frozen manifest names — not whatever runs today.
    const snapshot = await sources.decisions.getSnapshot(scope, c.snapshotId);
    if (!snapshot.ok) return snapshot;
    const chosen = snapshot.value?.alternatives.find((a) => a.chosen);
    if (!chosen?.scenarioRunId) {
      return ok({ items: [], completeness: 'INVALID', reasons: [{ code: 'NO_COMMITTED_RUN', severity: 'INVALID', message: 'The chosen alternative has no simulated future to describe.', itemKey: null }], sourceReferences: [], model });
    }
    const future = await sources.scenarios.getFutureState(scope, chosen.scenarioRunId);
    if (!future.ok) return future;
    if (future.value.run.fingerprint !== chosen.scenarioFingerprint) {
      reasons.push({ code: 'COMMITTED_RUN_DIVERGES', severity: 'INVALID', message: 'The stored run no longer carries the fingerprint the commitment froze.', itemKey: null });
    }
    const expected = new Set(c.expectedOutcomes.filter((e) => e.nodeId && e.period).map((e) => `${e.nodeId}|${periodKey(e.period!)}`));
    const values = await futureItems(sources, scope, v, enterprise, future.value, 'COMMITTED_FUTURE', expected);
    if (!values.ok) return values;
    items.push(...values.value, ...constraintItems(future.value, v, enterprise, sources.constraints));
    sourceRefs.push(ref('SCENARIO_RUN', future.value.run.id, future.value.run.fingerprint, 'committed future'), ref('COMMITMENT_SNAPSHOT', snapshot.value!.id, snapshot.value!.fingerprint));
    if (future.value.completeness !== 'COMPLETE') {
      reasons.push({ code: 'FUTURE_INCOMPLETE', severity: future.value.completeness === 'INVALID' ? 'INVALID' : 'PARTIAL', message: `The committed future is ${future.value.completeness}: some positions were not computed, and they are shown as such.`, itemKey: null });
    }
    onlyDecisionId = c.decisionId;
  }

  // ------------------------------------------------------------- management
  const management = await composeManagement(sources, scope, {
    lens: spec.lens,
    view: v,
    enterprise,
    onlyDecisionId,
    expectedValues: spec.kind === 'CURRENT' || spec.kind === 'HISTORICAL',
  });
  if (!management.ok) return management;
  items.push(...management.value.items);
  reasons.push(...management.value.reasons);
  sourceRefs.push(...management.value.sourceRefs);

  // Objectives read every value layer, the committed future included.
  if (spec.kind === 'CURRENT' || spec.kind === 'HISTORICAL' || spec.kind === 'EXPECTED') items.push(...objectiveItems(items));

  // Attention last: named rules over everything above.
  items.push(...snapshotAttention(items, spec.lens.effectiveAsOf));

  // One item per key; a collision is a composer defect, never silently resolved.
  const seen = new Map<string, TwinItem>();
  for (const i of items) {
    if (seen.has(i.key)) return fail(TwinErrors.INVALID_INPUT, `Twin composition produced two items with key ${i.key}.`);
    seen.set(i.key, i);
  }
  if (items.length === 0) reasons.push({ code: 'EMPTY', severity: 'INVALID', message: 'Nothing in this scope exists at this lens.', itemKey: null });

  const worst = reasons.reduce<TwinCompleteness>((w, r) => (SEVERITY[r.severity] > SEVERITY[w] ? r.severity : w), 'COMPLETE');
  const uniqueRefs = new Map(sourceRefs.map((r) => [`${r.kind}:${r.id}`, r]));
  return ok({
    items: [...items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    completeness: worst,
    reasons: reasons.sort((a, b) => a.code.localeCompare(b.code) || (a.itemKey ?? '').localeCompare(b.itemKey ?? '')),
    sourceReferences: [...uniqueRefs.values()].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
    model,
  });
}
