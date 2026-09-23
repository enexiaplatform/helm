/**
 * The Scenario Runtime (ADR-0019).
 *
 *   Scenario → resolve baseline + overrides → build calculation context →
 *   Value Propagation Engine → scenario outputs → Future State
 *
 * There is no scenario calculator here. Every number a scenario produces is
 * produced by the Phase 3 engine, through the same resolver, the same lenses
 * and the same trace; the runtime's job is to say WHICH world the engine runs
 * against (a fork point and a period), WHAT differs in it (an overlay of
 * explicit overrides), and to read the result back as a coherent state.
 *
 * Three properties it protects:
 *
 *   ISOLATION        overrides reach the engine only as an overlay for one
 *                    run; outputs are tagged with the scenario's own entity;
 *                    nothing is written into the baseline, and no persisted
 *                    scenario output is ever read back as an input.
 *   REPRODUCIBILITY  a sealed revision fixes the overrides, the fork point
 *                    (both lenses), the periods and the model; replay re-runs
 *                    exactly that, and the fingerprint says so.
 *   HONESTY          what the model cannot compute is BLOCKED, not estimated;
 *                    what the scenario states but no calculation reads is
 *                    shown as stated, not propagated; nothing is ranked.
 */

import {
  comparePeriods,
  decimal,
  fail,
  makePeriod,
  ok,
  periodKey,
  samePeriod,
  sumAll,
  toString as decToString,
  type Clock,
  type EntityId,
  type Period,
  type Result,
  type Scope,
} from '@helm/shared';
import { canonicalKey } from '@helm/ontology';
import type { GraphStore } from '@helm/graph-store';
import {
  ENGINE_VERSION,
  calculationRef,
  canonicalNumeric,
  policyOrder,
  selectObservation,
  type CalculationRegistry,
  type CalculationStep,
  type Explanation,
  type PropagationEngine,
  type TracedInput,
} from '@helm/propagation-engine';
import {
  unitBounds,
  type ValueGraph,
  type ValueMetricDefinition,
  type ValueNode,
} from '@helm/value-graph';
import { scenarioFingerprint } from './fingerprint.ts';
import { effectiveOverrides, toOverlay, type RevisionLink } from './overlay.ts';
import { constraintSubjects, evaluateConstraints } from './constraints.ts';
import { compareStates, type ComparedState } from './comparison.ts';
import type {
  CreateScenarioInput,
  ScenarioExecution,
  ScenarioRuntime,
  ScenarioStore,
} from './port.ts';
import {
  MAX_INHERITANCE_DEPTH,
  ScenarioErrors,
  overrideProvenanceKinds,
  overrideTypes,
  type AssumptionDelta,
  type Completeness,
  type ConstraintDefinition,
  type ForkPoint,
  type FutureState,
  type FutureStateValue,
  type ModelRef,
  type Scenario,
  type ScenarioOverride,
  type ScenarioRevision,
  type ScenarioRun,
  type StateRef,
  type ValidationIssue,
  type ValidationReport,
} from './types.ts';

export type ScenarioRuntimeOptions = {
  engine: PropagationEngine;
  /** The model the engine executes; its identity is part of every fingerprint. */
  registry: CalculationRegistry;
  valueGraph: ValueGraph;
  graphStore: GraphStore;
  store: ScenarioStore;
  /** Injected, never ambient: a fork point's default is "now", and now must be reproducible in tests. */
  clock: Clock;
  constraints?: readonly ConstraintDefinition[];
  /**
   * Metric keys every future state shows even where no calculation touches
   * them — service level, risk scores — so a reader sees them carried over
   * from the baseline rather than silently absent.
   */
  stateFrame?: readonly string[];
};

const KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TERMINAL = new Set(['ARCHIVED', 'INVALIDATED']);

export function createScenarioRuntime(opts: ScenarioRuntimeOptions): ScenarioRuntime {
  const { engine, registry, valueGraph, graphStore, store, clock } = opts;
  const constraints = opts.constraints ?? [];
  const stateFrame = opts.stateFrame ?? [];

  // ------------------------------------------------------------ helpers

  function currentModel(): ModelRef {
    return {
      engineVersion: ENGINE_VERSION,
      calculations: registry.active().map(calculationRef).sort(),
    };
  }

  const sameModel = (a: ModelRef | null, b: ModelRef) =>
    a !== null && a.engineVersion === b.engineVersion && a.calculations.join(',') === b.calculations.join(',');

  function checkFork(fork: ForkPoint): Result<ForkPoint> {
    const eff = new Date(fork.effectiveAsOf);
    const rec = new Date(fork.recordedThrough);
    if (Number.isNaN(eff.getTime()) || Number.isNaN(rec.getTime())) {
      return fail(ScenarioErrors.INVALID_INPUT, 'A fork point needs valid effectiveAsOf and recordedThrough instants.');
    }
    if (!['SOURCE_TRUTH', 'ACTUALS_FIRST', 'ASSUMPTION_ONLY'].includes(fork.policy)) {
      return fail(
        ScenarioErrors.INVALID_INPUT,
        `A fork reads the baseline world, so its policy must be a source policy, not "${fork.policy}".`,
      );
    }
    // A boundary in the future would let the scenario learn things as time
    // passes — precisely the silent knowledge gain a fork point exists to stop.
    if (rec.getTime() > clock.now().getTime()) {
      return fail(
        ScenarioErrors.INVALID_INPUT,
        'recordedThrough cannot be in the future: a scenario may only know what was known.',
      );
    }
    return ok({
      effectiveAsOf: eff.toISOString(),
      recordedThrough: rec.toISOString(),
      policy: fork.policy,
    });
  }

  function checkPeriods(periods: readonly Period[]): Result<Period[]> {
    if (periods.length === 0) {
      return fail(ScenarioErrors.INVALID_INPUT, 'State at least one business period to simulate.');
    }
    const out: Period[] = [];
    for (const p of periods) {
      const made = makePeriod(p.start, p.end, p.grain);
      if (!made.ok) return fail(ScenarioErrors.INVALID_INPUT, made.error.message);
      if (out.some((q) => samePeriod(q, made.value))) {
        return fail(ScenarioErrors.INVALID_INPUT, `Period ${periodKey(made.value)} is listed twice.`);
      }
      out.push(made.value);
    }
    return ok(out.sort(comparePeriods));
  }

  async function latestRevision(scope: Scope, scenarioId: string): Promise<Result<ScenarioRevision | null>> {
    const all = await store.listRevisions(scope, scenarioId);
    if (!all.ok) return all;
    return ok(all.value.length > 0 ? all.value[all.value.length - 1] : null);
  }

  async function latestSealed(scope: Scope, scenarioId: string): Promise<Result<ScenarioRevision | null>> {
    const all = await store.listRevisions(scope, scenarioId);
    if (!all.ok) return all;
    const sealed = all.value.filter((r) => r.state === 'SEALED');
    return ok(sealed.length > 0 ? sealed[sealed.length - 1] : null);
  }

  async function mustScenario(scope: Scope, id: string): Promise<Result<Scenario>> {
    const s = await store.getScenario(scope, id);
    if (!s.ok) return s;
    if (!s.value) return fail(ScenarioErrors.NOT_FOUND, `Scenario ${id} not found.`);
    return ok(s.value);
  }

  async function mustRevision(scope: Scope, id: string): Promise<Result<ScenarioRevision>> {
    const r = await store.getRevision(scope, id);
    if (!r.ok) return r;
    if (!r.value) return fail(ScenarioErrors.NOT_FOUND, `Revision ${id} not found.`);
    return ok(r.value);
  }

  /** The inheritance chain of a revision, oldest ancestor first. Bounded. */
  async function chainFor(scope: Scope, revision: ScenarioRevision): Promise<Result<RevisionLink[]>> {
    const links: RevisionLink[] = [];
    let current: ScenarioRevision | null = revision;
    let depth = 0;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.id)) {
        return fail(ScenarioErrors.INVALID_INPUT, 'The inheritance chain revisits a revision.');
      }
      seen.add(current.id);
      if (depth > MAX_INHERITANCE_DEPTH) {
        return fail(
          ScenarioErrors.INHERITANCE_TOO_DEEP,
          `A scenario may inherit through at most ${MAX_INHERITANCE_DEPTH} ancestors.`,
        );
      }
      const overrides = await store.listOverrides(scope, current.id);
      if (!overrides.ok) return overrides;
      links.unshift({ scenarioId: current.scenarioId, revisionId: current.id, overrides: overrides.value });
      if (!current.parentRevisionId) break;
      const parent = await store.getRevision(scope, current.parentRevisionId);
      if (!parent.ok) return parent;
      if (!parent.value) return fail(ScenarioErrors.NOT_FOUND, 'A pinned parent revision is missing.');
      if (parent.value.state !== 'SEALED') {
        return fail(ScenarioErrors.PARENT_NOT_SEALED, 'A child may only inherit from a sealed revision.');
      }
      current = parent.value;
      depth += 1;
    }
    return ok(links);
  }

  /** The value nodes the model computes in these periods. Overrides may not name them. */
  async function computedNodes(scope: Scope, fork: ForkPoint, periods: readonly Period[]): Promise<Result<Set<string>>> {
    const ids = new Set<string>();
    for (const period of periods) {
      const plan = await engine.planPropagation(scope, {
        effectiveAsOf: new Date(fork.effectiveAsOf),
        recordedThrough: new Date(fork.recordedThrough),
        period,
      });
      if (!plan.ok) return plan;
      for (const n of plan.value.nodes) ids.add(n.outputNodeId);
    }
    return ok(ids);
  }

  async function nodeAndMetric(
    scope: Scope,
    nodeId: string,
    cache: Map<string, { node: ValueNode; metric: ValueMetricDefinition } | null>,
  ): Promise<Result<{ node: ValueNode; metric: ValueMetricDefinition } | null>> {
    if (cache.has(nodeId)) return ok(cache.get(nodeId)!);
    const node = await valueGraph.getValueNode(scope, nodeId);
    if (!node.ok) return node;
    if (!node.value) {
      cache.set(nodeId, null);
      return ok(null);
    }
    const metric = await valueGraph.getMetricDefinition(scope, node.value.metricKey);
    if (!metric.ok) return metric;
    const hit = metric.value ? { node: node.value, metric: metric.value } : null;
    cache.set(nodeId, hit);
    return ok(hit);
  }

  async function copyOverrides(scope: Scope, from: ScenarioRevision, to: ScenarioRevision): Promise<Result<void>> {
    const existing = await store.listOverrides(scope, from.id);
    if (!existing.ok) return existing;
    for (const o of existing.value) {
      const copied = await store.addOverride(scope, {
        scenarioId: to.scenarioId,
        revisionId: to.id,
        overrideType: o.overrideType,
        targetNodeId: o.targetNodeId,
        metricKey: o.metricKey,
        subjectEntityId: o.subjectEntityId,
        operation: o.operation,
        value: o.value,
        unit: o.unit,
        currency: o.currency,
        period: o.period,
        provenanceKind: o.provenanceKind,
        sourceSystem: o.sourceSystem,
        rationale: o.rationale,
        confidence: o.confidence,
        createdBy: o.createdBy,
      });
      if (!copied.ok) return copied;
    }
    return ok(undefined);
  }

  const refOf = (run: ScenarioRun, scenario: Scenario | null, revision: ScenarioRevision | null): StateRef => ({
    runId: run.id,
    stateKind: run.stateKind,
    scenarioId: scenario?.id ?? null,
    scenarioKey: scenario?.key ?? null,
    revisionId: revision?.id ?? null,
    label: scenario ? `${scenario.name} (r${revision?.revisionNumber ?? '?'})` : 'Baseline',
  });

  // ------------------------------------------------------------ validation

  async function validateRevision(scope: Scope, revision: ScenarioRevision): Promise<Result<ValidationReport>> {
    const issues: ValidationIssue[] = [];
    const scenario = await mustScenario(scope, revision.scenarioId);
    if (!scenario.ok) return scenario;
    if (TERMINAL.has(scenario.value.status)) {
      issues.push({
        severity: 'ERROR',
        code: ScenarioErrors.NOT_EXECUTABLE,
        message: `The scenario is ${scenario.value.status}; it can be read and compared, not executed.`,
      });
    }

    const chain = await chainFor(scope, revision);
    if (!chain.ok) {
      issues.push({ severity: 'ERROR', code: chain.error.code, message: chain.error.message });
    }
    const links = chain.ok ? chain.value : [];
    const computed = await computedNodes(scope, revision.fork, revision.periods);
    if (!computed.ok) return computed;
    const cache = new Map<string, { node: ValueNode; metric: ValueMetricDefinition } | null>();

    for (const link of links) {
      const own = link.revisionId === revision.id;
      for (const o of link.overrides) {
        const nm = await nodeAndMetric(scope, o.targetNodeId, cache);
        if (!nm.ok) return nm;
        if (!nm.value) {
          issues.push({
            severity: 'ERROR',
            code: ScenarioErrors.OVERRIDE_INVALID,
            message: `Override ${o.id} names value node ${o.targetNodeId}, which does not exist in this organization.`,
            overrideId: o.id,
          });
          continue;
        }
        if (computed.value.has(o.targetNodeId)) {
          issues.push({
            severity: 'ERROR',
            code: ScenarioErrors.OVERRIDE_TARGETS_COMPUTED_NODE,
            message:
              `${own ? '' : 'Inherited override '}${o.id} sets ${nm.value.node.label}, which the model ` +
              'computes. Override its inputs; the outcome is derived.',
            overrideId: o.id,
            nodeId: o.targetNodeId,
          });
        }
        if (own && registry.findByInputMetric(o.metricKey).length === 0) {
          issues.push({
            severity: 'WARNING',
            code: 'scenario.inert_override',
            message:
              `No calculation in the model reads ${o.metricKey}, so ${nm.value.node.label} = ` +
              `${o.value} is stated in this scenario but moves nothing downstream.`,
            overrideId: o.id,
            nodeId: o.targetNodeId,
          });
        }
      }
    }

    const effective = revision.periods.map((period) => ({
      period,
      overrides: links.length > 0 ? effectiveOverrides(links, period) : [],
    }));
    for (const { period, overrides } of effective) {
      for (const e of overrides) {
        if (e.inheritedFromScenarioId) {
          issues.push({
            severity: 'INFO',
            code: 'scenario.inherited_override',
            message: `${periodKey(period)}: ${e.override.metricKey} = ${e.override.value} is inherited.`,
            overrideId: e.override.id,
          });
        }
        for (const s of e.shadowed) {
          issues.push({
            severity: 'INFO',
            code: 'scenario.shadowed_override',
            message:
              `${periodKey(period)}: override ${e.override.id} shadows ancestor override ${s.id} ` +
              `(${s.operation} ${s.value} → ${e.override.operation} ${e.override.value}).`,
            overrideId: e.override.id,
          });
        }
      }
    }

    const fingerprint = scenarioFingerprint({
      orgId: scope.orgId,
      fork: revision.fork,
      periods: revision.periods,
      model: revision.modelRef ?? currentModel(),
      effective,
    });
    return ok({
      revisionId: revision.id,
      valid: !issues.some((i) => i.severity === 'ERROR'),
      issues,
      effective,
      fingerprint,
    });
  }

  async function seal(scope: Scope, revision: ScenarioRevision): Promise<Result<ScenarioRevision>> {
    const report = await validateRevision(scope, revision);
    if (!report.ok) return report;
    if (!report.value.valid) {
      return fail(
        ScenarioErrors.VALIDATION_FAILED,
        report.value.issues.filter((i) => i.severity === 'ERROR').map((i) => i.message).join(' '),
        { issues: report.value.issues },
      );
    }
    const model = currentModel();
    const fingerprint = scenarioFingerprint({
      orgId: scope.orgId,
      fork: revision.fork,
      periods: revision.periods,
      model,
      effective: report.value.effective,
    });
    return store.sealRevision(scope, revision.id, { modelRef: model, fingerprint });
  }

  // ------------------------------------------------------------ simulation

  async function simulate(
    scope: Scope,
    input: {
      scenario: Scenario | null;
      revision: ScenarioRevision | null;
      fork: ForkPoint;
      periods: readonly Period[];
      fingerprint: string;
      modelRef: ModelRef;
      kind: 'EXECUTE' | 'REPLAY';
      replayOfRunId: string | null;
      notes: string | null;
    },
  ): Promise<Result<ScenarioExecution>> {
    const { scenario, revision, fork } = input;
    let run = await store.createRun(scope, {
      stateKind: scenario ? 'SCENARIO' : 'BASELINE',
      scenarioId: scenario?.id ?? null,
      revisionId: revision?.id ?? null,
      kind: input.kind,
      replayOfRunId: input.replayOfRunId,
      fork,
      periods: input.periods,
      fingerprint: input.fingerprint,
      modelRef: input.modelRef,
      createdBy: scope.actorId,
      notes: input.notes,
    });
    if (!run.ok) return run;

    let links: RevisionLink[] = [];
    if (revision) {
      const chain = await chainFor(scope, revision);
      if (!chain.ok) return chain;
      links = chain.value;
    }

    const statuses: string[] = [];
    for (const period of input.periods) {
      const overlay =
        scenario && revision
          ? toOverlay(effectiveOverrides(links, period), scenario.id, revision.id)
          : null;
      const res = await engine.execute(scope, {
        effectiveAsOf: new Date(fork.effectiveAsOf),
        recordedThrough: new Date(fork.recordedThrough),
        preference: fork.policy,
        period,
        overlay,
        scenarioEntityId: scenario?.scenarioEntityId ?? null,
        scenarioRevisionId: revision?.id ?? null,
        triggerType: scenario ? 'SCENARIO' : 'MANUAL',
        notes:
          (scenario ? `scenario ${scenario.key} r${revision?.revisionNumber}` : 'baseline state') +
          ` · ${periodKey(period)}` +
          (input.kind === 'REPLAY' ? ` · replay of ${input.replayOfRunId}` : ''),
      });
      if (!res.ok) {
        statuses.push('FAILED');
        continue;
      }
      statuses.push(res.value.run.status);
      const attached = await store.attachPeriodRun(scope, run.value.id, {
        period,
        calculationRunId: res.value.run.id,
      });
      if (!attached.ok) return attached;
      run = attached;
    }

    const completeness: Completeness = statuses.every((s) => s === 'COMPLETED')
      ? 'COMPLETE'
      : statuses.every((s) => s === 'FAILED')
        ? 'INVALID'
        : 'PARTIAL';
    const completed = await store.completeRun(scope, run.value.id, {
      status: completeness === 'COMPLETE' ? 'COMPLETED' : completeness === 'PARTIAL' ? 'PARTIAL' : 'FAILED',
      completeness,
    });
    if (!completed.ok) return completed;

    const state = await buildFutureState(scope, completed.value);
    if (!state.ok) return state;
    const recorded = await store.recordConstraintResults(scope, completed.value.id, state.value.constraints);
    if (!recorded.ok) return recorded;
    return ok({ run: completed.value, futureState: state.value });
  }

  // ---------------------------------------------------------- future state

  async function buildFutureState(scope: Scope, run: ScenarioRun): Promise<Result<FutureState>> {
    let scenario: Scenario | null = null;
    let revision: ScenarioRevision | null = null;
    let links: RevisionLink[] = [];
    if (run.stateKind === 'SCENARIO' && run.scenarioId && run.revisionId) {
      const s = await mustScenario(scope, run.scenarioId);
      if (!s.ok) return s;
      scenario = s.value;
      const r = await mustRevision(scope, run.revisionId);
      if (!r.ok) return r;
      revision = r.value;
      const chain = await chainFor(scope, revision);
      if (!chain.ok) return chain;
      links = chain.value;
    }
    const overridesById = new Map<string, ScenarioOverride>();
    for (const l of links) for (const o of l.overrides) overridesById.set(o.id, o);

    const cache = new Map<string, { node: ValueNode; metric: ValueMetricDefinition } | null>();
    const values: FutureStateValue[] = [];
    const seen = new Set<string>();
    const lens = { effectiveAsOf: new Date(run.fork.effectiveAsOf), recordedThrough: new Date(run.fork.recordedThrough) };

    const push = async (
      nodeId: string,
      period: Period,
      make: (nm: { node: ValueNode; metric: ValueMetricDefinition }) => Omit<
        FutureStateValue,
        'nodeId' | 'nodeLabel' | 'metricKey' | 'metricName' | 'dimension' | 'directionality' | 'subjectEntityId' | 'period'
      >,
    ): Promise<Result<void>> => {
      const key = `${nodeId}|${periodKey(period)}`;
      if (seen.has(key)) return ok(undefined);
      const nm = await nodeAndMetric(scope, nodeId, cache);
      if (!nm.ok) return nm;
      if (!nm.value) return ok(undefined);
      seen.add(key);
      values.push({
        nodeId,
        nodeLabel: nm.value.node.label,
        metricKey: nm.value.node.metricKey,
        metricName: nm.value.metric.name,
        dimension: nm.value.metric.dimension,
        directionality: nm.value.metric.directionality,
        subjectEntityId: nm.value.node.subjectEntityId,
        period,
        ...make(nm.value),
      });
      return ok(undefined);
    };

    /** A source read under this state's boundary, for values no step touched. */
    const readSource = async (nm: { node: ValueNode; metric: ValueMetricDefinition }, period: Period) => {
      const periodic = nm.metric.timeBehavior === 'PERIOD' || nm.metric.timeBehavior === 'CUMULATIVE';
      return selectObservation(
        valueGraph,
        scope,
        nm.node.id,
        policyOrder[run.fork.policy],
        lens,
        null,
        periodic && nm.node.timeHorizon !== 'current' ? period : null,
      );
    };

    for (const pr of run.periodRuns) {
      const period = pr.period;
      const trace = await engine.getTrace(scope, pr.calculationRunId);
      if (!trace.ok) return trace;
      const consumedOverrides = new Set<string>();

      // 1. Every computed node: its value, or why there is none.
      for (const step of trace.value) {
        const r = await push(step.outputNodeId, period, () => stepValue(step, pr.calculationRunId));
        if (!r.ok) return r;
      }

      // 2. Every input a step actually used: inherited source values and
      //    applied overrides, exactly as the engine bound them.
      for (const step of trace.value) {
        for (const input of step.inputs) {
          for (const part of partsOf(input)) {
            if (part.boundTo === 'RUN_OUTPUT') continue;
            if (part.override) {
              consumedOverrides.add(part.override.overrideId);
              const o = overridesById.get(part.override.overrideId);
              // What the override replaced. An ADD recorded it in the trace; for
              // a SET it is read here, under the same boundary, so the reader
              // sees "4 → 12" and not an unexplained 12.
              let replaced = part.override.baseline?.value ?? null;
              if (replaced === null) {
                const nm = await nodeAndMetric(scope, part.nodeId, cache);
                if (!nm.ok) return nm;
                if (nm.value) {
                  const base = await readSource(nm.value, period);
                  if (base.ok && base.value) replaced = canonicalNumeric(exactOf(base.value));
                }
              }
              const r = await push(part.nodeId, period, () => ({
                origin: 'OVERRIDDEN',
                value: canonicalNumeric(part.value),
                unit: input.unit,
                currency: input.currency,
                confidence: o?.confidence ?? input.confidence,
                observationId: null,
                calculationRunId: pr.calculationRunId,
                calculation: null,
                stepStatus: null,
                reason: null,
                override: {
                  overrideId: part.override!.overrideId,
                  operation: part.override!.operation,
                  overrideValue: part.override!.value,
                  baselineValue: replaced,
                  provenanceKind: part.override!.provenanceKind,
                  rationale: o?.rationale ?? '',
                  inheritedFromScenarioId: part.override!.inheritedFromScenarioId,
                  shadowedOverrideIds: part.override!.shadowedOverrideIds,
                  consumed: true,
                },
              }));
              if (!r.ok) return r;
            } else {
              const obs = await observationConfidence(scope, part.nodeId, part.observationId);
              const r = await push(part.nodeId, period, () => ({
                origin: 'INHERITED',
                value: canonicalNumeric(part.value),
                unit: input.unit,
                currency: input.currency,
                confidence: obs,
                observationId: part.observationId,
                calculationRunId: pr.calculationRunId,
                calculation: null,
                stepStatus: null,
                reason: null,
                override: null,
              }));
              if (!r.ok) return r;
            }
          }
        }
      }

      // 3. Overrides no calculation read: stated in the scenario, propagated nowhere.
      if (links.length > 0) {
        for (const e of effectiveOverrides(links, period)) {
          if (consumedOverrides.has(e.override.id)) continue;
          const nm = await nodeAndMetric(scope, e.override.targetNodeId, cache);
          if (!nm.ok) return nm;
          if (!nm.value) continue;
          let baselineValue: string | null = null;
          const base = await readSource(nm.value, period);
          if (base.ok && base.value) baselineValue = canonicalNumeric(exactOf(base.value));
          const stated =
            e.override.operation === 'SET'
              ? canonicalNumeric(e.override.value)
              : baselineValue === null
                ? null
                : canonicalNumeric(decToString(sumAll([decimal(baselineValue), decimal(e.override.value)])));
          const r = await push(e.override.targetNodeId, period, () => ({
            origin: stated === null ? 'BLOCKED' : 'OVERRIDDEN',
            value: stated,
            unit: e.override.unit,
            currency: e.override.currency,
            confidence: e.override.confidence,
            observationId: null,
            calculationRunId: null,
            calculation: null,
            stepStatus: null,
            reason:
              stated === null
                ? 'the override adjusts a baseline value that does not exist under this boundary'
                : null,
            override: {
              overrideId: e.override.id,
              operation: e.override.operation,
              overrideValue: canonicalNumeric(e.override.value),
              baselineValue,
              provenanceKind: e.override.provenanceKind,
              rationale: e.override.rationale,
              inheritedFromScenarioId: e.inheritedFromScenarioId,
              shadowedOverrideIds: e.shadowed.map((s) => s.id),
              consumed: false,
            },
          }));
          if (!r.ok) return r;
        }
      }

      // 4. The state frame: carried over from the baseline, and labelled so.
      for (const metricKey of stateFrame) {
        const nodes = await valueGraph.findValueNodes(scope, { metricKeys: [metricKey], limit: 200 });
        if (!nodes.ok) return nodes;
        for (const node of nodes.value) {
          const nm = await nodeAndMetric(scope, node.id, cache);
          if (!nm.ok) return nm;
          if (!nm.value) continue;
          const metricUnit = nm.value.metric.unitType;
          const base = await readSource(nm.value, period);
          const r = await push(node.id, period, () =>
            base.ok && base.value
              ? {
                  origin: 'INHERITED',
                  value: canonicalNumeric(exactOf(base.value)),
                  unit: base.value.unitType,
                  currency: base.value.currency,
                  confidence: base.value.confidence,
                  observationId: base.value.id,
                  calculationRunId: null,
                  calculation: null,
                  stepStatus: null,
                  reason: 'not modelled: carried from the baseline source world',
                  override: null,
                }
              : {
                  origin: 'UNAVAILABLE',
                  value: null,
                  unit: metricUnit,
                  currency: null,
                  confidence: null,
                  observationId: null,
                  calculationRunId: null,
                  calculation: null,
                  stepStatus: null,
                  reason: base.ok
                    ? 'nothing in the source world speaks to this under the state\'s boundary'
                    : base.error.message,
                  override: null,
                },
          );
          if (!r.ok) return r;
        }
      }
    }

    // Periods the run could not simulate at all appear as missing, not as zeros.
    const completeness: Completeness = run.completeness ?? 'INVALID';

    const persisted = await store.listConstraintResults(scope, run.id);
    if (!persisted.ok) return persisted;
    let constraintResults = persisted.value;
    if (constraintResults.length === 0 && constraints.length > 0) {
      const subjects = await resolveSubjects(scope, constraintSubjects(constraints));
      if (!subjects.ok) return subjects;
      constraintResults = evaluateConstraints(constraints, values, run.periods, subjects.value);
    }

    return ok({
      run,
      scenario,
      revision,
      label: scenario ? `${scenario.name} (r${revision?.revisionNumber})` : 'Baseline',
      completeness,
      values,
      constraints: constraintResults,
    });
  }

  function stepValue(step: CalculationStep, calculationRunId: string): Omit<
    FutureStateValue,
    'nodeId' | 'nodeLabel' | 'metricKey' | 'metricName' | 'dimension' | 'directionality' | 'subjectEntityId' | 'period'
  > {
    const produced = (step.status === 'CALCULATED' || step.status === 'UNCHANGED') && step.outputValue !== null;
    return {
      origin: produced ? 'COMPUTED' : 'BLOCKED',
      value: produced ? canonicalNumeric(step.outputValue!) : null,
      unit: step.outputUnit,
      currency: step.outputCurrency,
      confidence: produced ? step.confidence : null,
      observationId: step.outputObservationId,
      calculationRunId,
      calculation: `${step.calculationKey}@${step.calculationVersion}`,
      stepStatus: step.status,
      reason: produced ? null : `${step.errorCode ?? step.status}: ${step.errorMessage ?? ''}`.trim(),
      override: null,
    };
  }

  async function observationConfidence(scope: Scope, nodeId: string, observationId: string): Promise<number | null> {
    const obs = await valueGraph.getObservations(scope, { nodeId, limit: 500 });
    if (!obs.ok) return null;
    return obs.value.find((o) => o.id === observationId)?.confidence ?? null;
  }

  async function resolveSubjects(scope: Scope, keys: readonly string[]): Promise<Result<Map<string, EntityId>>> {
    const map = new Map<string, EntityId>();
    if (keys.length === 0) return ok(map);
    const found = await graphStore.findEntities(scope, { canonicalKeys: [...keys], limit: keys.length * 2 });
    if (!found.ok) return found;
    for (const e of found.value) map.set(e.canonicalKey, e.id);
    return ok(map);
  }

  // ------------------------------------------------------ assumption deltas

  async function assumptionDeltasFor(
    scope: Scope,
    state: FutureState,
    ref: StateRef,
    reference: FutureState,
  ): Promise<Result<AssumptionDelta[]>> {
    if (!state.revision) return ok([]);
    const chain = await chainFor(scope, state.revision);
    if (!chain.ok) return chain;
    const out: AssumptionDelta[] = [];
    for (const period of state.run.periods) {
      for (const e of effectiveOverrides(chain.value, period)) {
        const o = e.override;
        const inState = state.values.find((v) => v.nodeId === o.targetNodeId && samePeriod(v.period, period));
        const inRef = reference.values.find((v) => v.nodeId === o.targetNodeId && samePeriod(v.period, period));
        out.push({
          state: ref,
          nodeId: o.targetNodeId,
          nodeLabel: inState?.nodeLabel ?? o.metricKey,
          metricKey: o.metricKey,
          period,
          overrideType: o.overrideType,
          operation: o.operation,
          overrideValue: canonicalNumeric(o.value),
          baselineValue: inRef?.value ?? inState?.override?.baselineValue ?? null,
          scenarioValue: inState?.value ?? null,
          unit: o.unit,
          currency: o.currency,
          provenanceKind: o.provenanceKind,
          rationale: o.rationale,
          confidence: o.confidence,
          inheritedFromScenarioId: e.inheritedFromScenarioId,
          shadowedOverrideIds: e.shadowed.map((s) => s.id),
          consumed: inState?.override?.consumed ?? false,
        });
      }
    }
    return ok(out);
  }

  // ---------------------------------------------------------------- runtime

  const runtime: ScenarioRuntime = {
    async createScenario(scope, input: CreateScenarioInput) {
      if (!KEY.test(input.key)) {
        return fail(
          ScenarioErrors.INVALID_INPUT,
          'A scenario key is 1–63 lowercase letters, digits and hyphens, starting with a letter or digit.',
        );
      }
      if (!input.name || input.name.trim().length === 0) {
        return fail(ScenarioErrors.INVALID_INPUT, 'A scenario needs a name.');
      }

      let parentRevision: ScenarioRevision | null = null;
      if (input.parentScenarioId) {
        const parent = await mustScenario(scope, input.parentScenarioId);
        if (!parent.ok) return parent;
        // Depth: the parent's own ancestors plus the parent itself.
        let depth = 1;
        let cursor = parent.value;
        while (cursor.parentScenarioId) {
          depth += 1;
          const up = await mustScenario(scope, cursor.parentScenarioId);
          if (!up.ok) return up;
          cursor = up.value;
        }
        if (depth > MAX_INHERITANCE_DEPTH) {
          return fail(
            ScenarioErrors.INHERITANCE_TOO_DEEP,
            `A scenario may inherit through at most ${MAX_INHERITANCE_DEPTH} ancestors.`,
          );
        }
        const sealed = await latestSealed(scope, parent.value.id);
        if (!sealed.ok) return sealed;
        if (!sealed.value) {
          return fail(
            ScenarioErrors.PARENT_NOT_SEALED,
            'A child scenario inherits a sealed revision of its parent; seal the parent first.',
          );
        }
        parentRevision = sealed.value;
      }

      const now = clock.now().toISOString();
      const fork = checkFork({
        effectiveAsOf: input.fork?.effectiveAsOf ?? parentRevision?.fork.effectiveAsOf ?? now,
        recordedThrough: input.fork?.recordedThrough ?? parentRevision?.fork.recordedThrough ?? now,
        policy: input.fork?.policy ?? parentRevision?.fork.policy ?? 'SOURCE_TRUTH',
      });
      if (!fork.ok) return fork;
      const periods = checkPeriods(input.periods ?? parentRevision?.periods ?? []);
      if (!periods.ok) return periods;

      // The ontology entity every output of this scenario is tagged with.
      const entity = await graphStore.upsertEntity(scope, {
        entityTypeKey: 'Scenario',
        canonicalKey: canonicalKey('helm', 'scenario', input.key),
        name: input.name,
        description: input.description ?? null,
        sourceSystem: 'helm',
        attributes: { kind: 'variant' },
        createdBy: scope.actorId,
      });
      if (!entity.ok) return entity;

      const scenario = await store.createScenario(scope, {
        key: input.key,
        name: input.name.trim(),
        description: input.description ?? '',
        parentScenarioId: input.parentScenarioId ?? null,
        scenarioEntityId: entity.value.entity.id,
        metadata: input.metadata ?? {},
        createdBy: scope.actorId,
      });
      if (!scenario.ok) return scenario;
      const revision = await store.createRevision(scope, {
        scenarioId: scenario.value.id,
        reason: 'CREATED',
        basedOnRevisionId: null,
        parentRevisionId: parentRevision?.id ?? null,
        fork: fork.value,
        periods: periods.value,
        notes: null,
        createdBy: scope.actorId,
      });
      if (!revision.ok) return revision;
      return ok({ scenario: scenario.value, revision: revision.value });
    },

    async createRevision(scope, scenarioId, options = {}) {
      const scenario = await mustScenario(scope, scenarioId);
      if (!scenario.ok) return scenario;
      if (TERMINAL.has(scenario.value.status)) {
        return fail(ScenarioErrors.NOT_EXECUTABLE, `The scenario is ${scenario.value.status}.`);
      }
      const latest = await latestRevision(scope, scenarioId);
      if (!latest.ok) return latest;
      if (!latest.value) return fail(ScenarioErrors.NOT_FOUND, 'The scenario has no revision to edit.');
      if (latest.value.state === 'DRAFT') {
        return fail(ScenarioErrors.DRAFT_EXISTS, 'Edit the existing draft revision instead.');
      }
      const created = await store.createRevision(scope, {
        scenarioId,
        reason: 'EDITED',
        basedOnRevisionId: latest.value.id,
        // The pin is carried, not refreshed: editing the child must not quietly
        // pick up whatever the parent has become since.
        parentRevisionId: latest.value.parentRevisionId,
        fork: latest.value.fork,
        periods: latest.value.periods,
        notes: options.notes ?? null,
        createdBy: scope.actorId,
      });
      if (!created.ok) return created;
      const copied = await copyOverrides(scope, latest.value, created.value);
      if (!copied.ok) return copied;
      const status = await store.setScenarioStatus(scope, scenarioId, 'DRAFT');
      if (!status.ok) return status;
      return created;
    },

    async addOverride(scope, revisionId, input) {
      const revision = await mustRevision(scope, revisionId);
      if (!revision.ok) return revision;
      if (revision.value.state !== 'DRAFT') {
        return fail(
          ScenarioErrors.REVISION_SEALED,
          'A sealed revision is immutable; create a new revision to change its assumptions.',
        );
      }
      const scenario = await mustScenario(scope, revision.value.scenarioId);
      if (!scenario.ok) return scenario;
      if (TERMINAL.has(scenario.value.status)) {
        return fail(ScenarioErrors.NOT_EXECUTABLE, `The scenario is ${scenario.value.status}.`);
      }
      if (!overrideTypes.includes(input.overrideType)) {
        return fail(ScenarioErrors.OVERRIDE_INVALID, `Unknown override type "${input.overrideType}".`);
      }
      if (input.overrideType === 'STRUCTURAL_OVERRIDE') {
        return fail(
          ScenarioErrors.STRUCTURAL_OVERRIDE_DEFERRED,
          'Structural overrides (adding a supplier, substituting a product) change the model\'s ' +
            'shape, not a value in it. Their interface is defined; executing them is deferred ' +
            'beyond Phase 4, and HELM will not approximate one with value overrides.',
          { structuralChange: input.structuralChange ?? null },
        );
      }
      if (!overrideProvenanceKinds.includes(input.provenanceKind)) {
        return fail(ScenarioErrors.OVERRIDE_INVALID, `Unknown provenance kind "${input.provenanceKind}".`);
      }
      const operation = input.operation ?? 'SET';
      if (operation !== 'SET' && operation !== 'ADD') {
        return fail(ScenarioErrors.OVERRIDE_INVALID, `Unknown operation "${operation}".`);
      }
      const rationale = (input.rationale ?? '').trim();
      if (rationale.length < 8) {
        return fail(
          ScenarioErrors.OVERRIDE_INVALID,
          'Every override needs a rationale: a scenario assumption nobody can explain is not one.',
        );
      }
      const confidence = input.confidence ?? null;
      if (confidence !== null && !(confidence >= 0 && confidence <= 1)) {
        return fail(ScenarioErrors.OVERRIDE_INVALID, 'Confidence is between 0 and 1.');
      }
      let value: string;
      try {
        value = canonicalNumeric(decToString(decimal(input.value)));
      } catch {
        return fail(ScenarioErrors.OVERRIDE_INVALID, `"${input.value}" is not a number.`);
      }

      const cache = new Map<string, { node: ValueNode; metric: ValueMetricDefinition } | null>();
      const nm = await nodeAndMetric(scope, input.targetNodeId, cache);
      if (!nm.ok) return nm;
      if (!nm.value) {
        return fail(ScenarioErrors.NOT_FOUND, `Value node ${input.targetNodeId} not found in this organization.`);
      }
      const { node, metric } = nm.value;
      if (input.unit !== metric.unitType) {
        return fail(
          ScenarioErrors.OVERRIDE_INVALID,
          `${metric.name} is measured in ${metric.unitType}, not ${input.unit}.`,
        );
      }
      const currency = input.currency ?? null;
      if (metric.unitType === 'currency' && (!currency || currency.length !== 3)) {
        return fail(ScenarioErrors.OVERRIDE_INVALID, 'A currency override must state its ISO currency.');
      }
      if (metric.unitType !== 'currency' && currency) {
        return fail(ScenarioErrors.OVERRIDE_INVALID, `${metric.name} carries no currency.`);
      }
      if (operation === 'SET') {
        const bounds = unitBounds[metric.unitType];
        const n = Number(value);
        if ((bounds.min !== null && n < bounds.min) || (bounds.max !== null && n > bounds.max)) {
          return fail(
            ScenarioErrors.OVERRIDE_INVALID,
            `${value} is outside the range of a ${metric.unitType} (${bounds.min ?? '−∞'}..${bounds.max ?? '∞'}).`,
          );
        }
      }

      const period = input.period ?? null;
      if (period && !revision.value.periods.some((p) => samePeriod(p, period))) {
        return fail(
          ScenarioErrors.PERIOD_NOT_IN_REVISION,
          `This revision simulates ${revision.value.periods.map(periodKey).join(', ')}, not ${periodKey(period)}.`,
        );
      }

      const existing = await store.listOverrides(scope, revisionId);
      if (!existing.ok) return existing;
      const clash = existing.value.find(
        (o) =>
          o.targetNodeId === node.id &&
          (o.period === null || period === null || samePeriod(o.period, period)),
      );
      if (clash) {
        return fail(
          ScenarioErrors.OVERRIDE_DUPLICATE,
          `This revision already overrides ${node.label}${clash.period ? ` for ${periodKey(clash.period)}` : ''}. ` +
            'One target has one assumption per revision.',
          { existingOverrideId: clash.id },
        );
      }

      const computed = await computedNodes(scope, revision.value.fork, revision.value.periods);
      if (!computed.ok) return computed;
      if (computed.value.has(node.id)) {
        return fail(
          ScenarioErrors.OVERRIDE_TARGETS_COMPUTED_NODE,
          `${node.label} is computed by the model. A scenario changes inputs and assumptions; ` +
            'the outcome is derived, never stated.',
          { nodeId: node.id },
        );
      }

      return store.addOverride(scope, {
        scenarioId: scenario.value.id,
        revisionId,
        overrideType: input.overrideType,
        targetNodeId: node.id,
        metricKey: node.metricKey,
        subjectEntityId: node.subjectEntityId,
        operation,
        value,
        unit: input.unit,
        currency,
        period,
        provenanceKind: input.provenanceKind,
        sourceSystem: input.sourceSystem ?? 'manual',
        rationale,
        confidence,
        createdBy: scope.actorId,
      });
    },

    async removeOverride(scope, overrideId) {
      return store.removeOverride(scope, overrideId);
    },

    async validate(scope, revisionId) {
      const revision = await mustRevision(scope, revisionId);
      if (!revision.ok) return revision;
      return validateRevision(scope, revision.value);
    },

    async markReady(scope, revisionId) {
      const revision = await mustRevision(scope, revisionId);
      if (!revision.ok) return revision;
      if (revision.value.state === 'SEALED') return ok(revision.value);
      const sealed = await seal(scope, revision.value);
      if (!sealed.ok) return sealed;
      const status = await store.setScenarioStatus(scope, sealed.value.scenarioId, 'READY');
      if (!status.ok) return status;
      return sealed;
    },

    async execute(scope, scenarioId) {
      const scenario = await mustScenario(scope, scenarioId);
      if (!scenario.ok) return scenario;
      if (TERMINAL.has(scenario.value.status)) {
        return fail(
          ScenarioErrors.NOT_EXECUTABLE,
          `The scenario is ${scenario.value.status}; its history stays readable and comparable.`,
        );
      }
      const latest = await latestRevision(scope, scenarioId);
      if (!latest.ok) return latest;
      if (!latest.value) return fail(ScenarioErrors.NOT_FOUND, 'The scenario has no revision.');
      let revision = latest.value;
      if (revision.state === 'DRAFT') {
        const sealed = await seal(scope, revision);
        if (!sealed.ok) return sealed;
        revision = sealed.value;
      }
      const model = currentModel();
      if (!sameModel(revision.modelRef, model)) {
        return fail(
          ScenarioErrors.NOT_EXECUTABLE,
          `Revision ${revision.revisionNumber} was sealed under a different model. Its history ` +
            'stays valid as it was; create a new revision to simulate it under the current model.',
          { sealedUnder: revision.modelRef, current: model },
        );
      }
      const running = await store.setScenarioStatus(scope, scenarioId, 'RUNNING');
      if (!running.ok) return running;
      const result = await simulate(scope, {
        scenario: running.value,
        revision,
        fork: revision.fork,
        periods: revision.periods,
        fingerprint: revision.fingerprint!,
        modelRef: model,
        kind: 'EXECUTE',
        replayOfRunId: null,
        notes: null,
      });
      const after = await store.setScenarioStatus(scope, scenarioId, result.ok ? 'COMPUTED' : 'READY');
      if (!after.ok) return after;
      return result;
    },

    async executeBaseline(scope, input) {
      const fork = checkFork(input.fork);
      if (!fork.ok) return fork;
      const periods = checkPeriods(input.periods);
      if (!periods.ok) return periods;
      const model = currentModel();
      const fingerprint = scenarioFingerprint({
        orgId: scope.orgId,
        fork: fork.value,
        periods: periods.value,
        model,
        effective: periods.value.map((period) => ({ period, overrides: [] })),
      });
      return simulate(scope, {
        scenario: null,
        revision: null,
        fork: fork.value,
        periods: periods.value,
        fingerprint,
        modelRef: model,
        kind: 'EXECUTE',
        replayOfRunId: null,
        notes: input.notes ?? null,
      });
    },

    async replay(scope, runId) {
      const original = await store.getRun(scope, runId);
      if (!original.ok) return original;
      if (!original.value) return fail(ScenarioErrors.NOT_FOUND, `Run ${runId} not found.`);
      const run = original.value;
      const model = currentModel();
      if (!sameModel(run.modelRef, model)) {
        return fail(
          ScenarioErrors.NOT_EXECUTABLE,
          'The run used a different model. A replay under another model would not be a replay.',
        );
      }
      let scenario: Scenario | null = null;
      let revision: ScenarioRevision | null = null;
      if (run.stateKind === 'SCENARIO') {
        const s = await mustScenario(scope, run.scenarioId!);
        if (!s.ok) return s;
        scenario = s.value;
        const r = await mustRevision(scope, run.revisionId!);
        if (!r.ok) return r;
        revision = r.value;
      }
      // Same revision, same fork, same periods: the boundary is restored, not
      // re-read from "now".
      return simulate(scope, {
        scenario,
        revision,
        fork: run.fork,
        periods: run.periods,
        fingerprint: run.fingerprint,
        modelRef: model,
        kind: 'REPLAY',
        replayOfRunId: run.id,
        notes: `replay of ${run.id}`,
      });
    },

    async rebase(scope, scenarioId, to = {}) {
      const scenario = await mustScenario(scope, scenarioId);
      if (!scenario.ok) return scenario;
      if (TERMINAL.has(scenario.value.status)) {
        return fail(ScenarioErrors.NOT_EXECUTABLE, `The scenario is ${scenario.value.status}.`);
      }
      const latest = await latestRevision(scope, scenarioId);
      if (!latest.ok) return latest;
      if (!latest.value) return fail(ScenarioErrors.NOT_FOUND, 'The scenario has no revision.');
      if (latest.value.state === 'DRAFT') {
        return fail(
          ScenarioErrors.DRAFT_EXISTS,
          'Seal or discard the draft first: a rebase restates a sealed set of assumptions.',
        );
      }
      const fork = checkFork({
        effectiveAsOf: to.effectiveAsOf ?? latest.value.fork.effectiveAsOf,
        recordedThrough: to.recordedThrough ?? clock.now().toISOString(),
        policy: to.policy ?? latest.value.fork.policy,
      });
      if (!fork.ok) return fork;
      const created = await store.createRevision(scope, {
        scenarioId,
        reason: 'REBASED',
        basedOnRevisionId: latest.value.id,
        parentRevisionId: latest.value.parentRevisionId,
        fork: fork.value,
        periods: latest.value.periods,
        notes: `rebased from r${latest.value.revisionNumber} (recorded through ${latest.value.fork.recordedThrough})`,
        createdBy: scope.actorId,
      });
      if (!created.ok) return created;
      const copied = await copyOverrides(scope, latest.value, created.value);
      if (!copied.ok) return copied;
      const sealed = await seal(scope, created.value);
      if (!sealed.ok) return sealed;
      const status = await store.setScenarioStatus(scope, scenarioId, 'READY');
      if (!status.ok) return status;
      return sealed;
    },

    async compare(scope, input) {
      const load = async (runId: string): Promise<Result<ComparedState & { state: FutureState }>> => {
        const run = await store.getRun(scope, runId);
        if (!run.ok) return run;
        if (!run.value) return fail(ScenarioErrors.NOT_FOUND, `Run ${runId} not found.`);
        const state = await buildFutureState(scope, run.value);
        if (!state.ok) return state;
        return ok({
          ref: refOf(run.value, state.value.scenario, state.value.revision),
          state: state.value,
          model: run.value.modelRef,
          assumptionDeltas: [],
        });
      };
      const baseline = await load(input.baselineRunId);
      if (!baseline.ok) return baseline;
      const alternatives: ComparedState[] = [];
      for (const id of input.alternativeRunIds) {
        const alt = await load(id);
        if (!alt.ok) return alt;
        const deltas = await assumptionDeltasFor(scope, alt.value.state, alt.value.ref, baseline.value.state);
        if (!deltas.ok) return deltas;
        alternatives.push({ ...alt.value, assumptionDeltas: deltas.value });
      }
      return ok(compareStates(baseline.value, alternatives));
    },

    async explain(scope, runId, nodeId, period) {
      const run = await store.getRun(scope, runId);
      if (!run.ok) return run;
      if (!run.value) return fail(ScenarioErrors.NOT_FOUND, `Run ${runId} not found.`);
      const state = await buildFutureState(scope, run.value);
      if (!state.ok) return state;
      const p = period ?? run.value.periods[0];
      const value = state.value.values.find((v) => v.nodeId === nodeId && samePeriod(v.period, p));
      if (!value) {
        return fail(ScenarioErrors.NOT_FOUND, `This state holds no value for node ${nodeId} in ${periodKey(p)}.`);
      }
      let lineage: Explanation | null = null;
      if (value.origin === 'COMPUTED' || value.origin === 'INHERITED') {
        if (value.observationId) {
          const e = await engine.explain(scope, value.observationId);
          if (!e.ok) return e;
          lineage = e.value;
        }
      } else if (value.origin === 'OVERRIDDEN' && value.override) {
        const o = value.override;
        const baselineLineage: Explanation[] = [];
        const trace = await findOverrideTrace(scope, run.value, p, o.overrideId);
        if (trace?.baseline) {
          const e = await engine.explain(scope, trace.baseline.observationId);
          if (e.ok) baselineLineage.push(e.value);
        }
        lineage = {
          observationId: `override:${o.overrideId}`,
          metricKey: value.metricKey,
          nodeLabel: value.nodeLabel,
          value: value.value ?? '',
          unit: value.unit ?? 'units',
          currency: value.currency,
          observationType: 'SCENARIO',
          confidence: value.confidence,
          derivation: null,
          source: null,
          override: trace ?? {
            overrideId: o.overrideId,
            scenarioId: state.value.scenario?.id ?? '',
            revisionId: state.value.revision?.id ?? '',
            operation: o.operation,
            value: o.overrideValue,
            inheritedFromScenarioId: o.inheritedFromScenarioId,
            shadowedOverrideIds: o.shadowedOverrideIds,
            provenanceKind: o.provenanceKind,
            baseline: null,
          },
          inputs: baselineLineage,
        };
      }
      return ok({
        state: refOf(run.value, state.value.scenario, state.value.revision),
        fork: run.value.fork,
        fingerprint: run.value.fingerprint,
        period: p,
        value,
        calculationRunId: value.calculationRunId,
        lineage,
      });
    },

    async getFutureState(scope, runId) {
      const run = await store.getRun(scope, runId);
      if (!run.ok) return run;
      if (!run.value) return fail(ScenarioErrors.NOT_FOUND, `Run ${runId} not found.`);
      return buildFutureState(scope, run.value);
    },

    async archive(scope, scenarioId) {
      return store.setScenarioStatus(scope, scenarioId, 'ARCHIVED');
    },

    async invalidate(scope, scenarioId, reason) {
      if (!reason || reason.trim().length < 8) {
        return fail(ScenarioErrors.INVALID_INPUT, 'Say why the scenario is invalidated.');
      }
      return store.setScenarioStatus(scope, scenarioId, 'INVALIDATED', reason.trim());
    },

    getScenario: (scope, id) => store.getScenario(scope, id),
    listScenarios: (scope) => store.listScenarios(scope),
    listRevisions: (scope, scenarioId) => store.listRevisions(scope, scenarioId),
    listOverrides: (scope, revisionId) => store.listOverrides(scope, revisionId),
    listRuns: (scope, filter) => store.listRuns(scope, filter),
  };

  async function findOverrideTrace(scope: Scope, run: ScenarioRun, period: Period, overrideId: string) {
    const pr = run.periodRuns.find((x) => samePeriod(x.period, period));
    if (!pr) return null;
    const trace = await engine.getTrace(scope, pr.calculationRunId);
    if (!trace.ok) return null;
    for (const step of trace.value) {
      for (const input of step.inputs) {
        for (const part of partsOf(input)) {
          if (part.override?.overrideId === overrideId) return part.override;
        }
      }
    }
    return null;
  }

  return runtime;
}

/** The per-node parts of a traced input: its components, or itself. */
function partsOf(input: TracedInput) {
  if (input.components && input.components.length > 0) {
    return input.components.map((c) => ({
      nodeId: c.nodeId,
      observationId: c.observationId,
      value: c.value,
      boundTo: c.boundTo ?? input.boundTo ?? 'SOURCE_OBSERVATION',
      override: c.override,
    }));
  }
  return [
    {
      nodeId: input.nodeId,
      observationId: input.observationId,
      value: input.value,
      boundTo: input.boundTo ?? 'SOURCE_OBSERVATION',
      override: input.override,
    },
  ];
}

/** The exact stored value of an observation. */
function exactOf(o: { metadata: Readonly<Record<string, unknown>>; numericValue: number | null }): string {
  const exact = o.metadata?.exactValue;
  return typeof exact === 'string' ? exact : String(o.numericValue ?? 0);
}
