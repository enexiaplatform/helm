/**
 * The Value Propagation Engine.
 *
 * Execution lifecycle (§9):
 *
 *   resolve context → build plan → order by dependency → for each step:
 *     resolve inputs → validate units → compute → write DERIVED observation →
 *     append trace
 *
 * Three properties the implementation protects above all:
 *
 *   DETERMINISM   no ambient clock, no randomness, no hidden state. Same
 *                 inputs and context always give the same result (§15).
 *   PARTIAL       a missing input blocks one step, not the whole model (§48).
 *   AUDITABILITY  every output records the exact observations it used, the
 *                 formula version, and a fingerprint of both (§12, §27).
 */

import {
  chainConfidence,
  clampConfidence,
  decimal,
  normalize,
  overrideFromMetadata,
  policyFor,
  fail,
  formatQuantity,
  mustQuantity,
  ok,
  quantity,
  sumAll,
  toNumber,
  toString as decToString,
  periodKey,
  type Clock,
  type Confidence,
  type EntityId,
  type Period,
  type Quantity,
  type Result,
  type Scope,
  type ValidTime,
  asValidTime,
} from '@helm/shared';
import type { GraphStore } from '@helm/graph-store';
import type { OntologyRegistry } from '@helm/ontology';
import type {
  ObservationType,
  TimeBehavior,
  TimeHorizon,
  ValueGraph,
  ValueNode,
  ValueObservation,
} from '@helm/value-graph';
import {
  CalculationErrors,
  calculationRef,
  policyOrder,
  unplannedDependencyOrder,
  type CalculationDefinition,
  type CalculationInputSpec,
  type CalculationRun,
  type CalculationStep,
  type ComputeContext,
  type Explanation,
  type Freshness,
  type InputOverlay,
  type InputResolution,
  type InputSource,
  type ObservationPolicy,
  type OverlayEntry,
  type OverrideTrace,
  type RunObservationPolicy,
  type PropagationPlan,
  type PropagationPlanNode,
  type ResolvedInputs,
  type StepStatus,
  type TracedInput,
} from './types.ts';
import type { CalculationRegistry } from './registry.ts';
import {
  canonicalNumeric,
  inputFingerprint,
  readTruthLayers,
  selectObservation,
  type Lens,
} from './selection.ts';
import { buildDependencyGraph, downstreamOf, type MetricDependencyGraph } from './dependencyGraph.ts';
import type { CalculationStore, PropagationEngine, PropagationRequest } from './port.ts';

export const ENGINE_VERSION = '4.0.0';

/** No run in progress: freshness and ad-hoc resolution read the stored world. */
const EMPTY_RUN_OUTPUTS: RunOutputs = new Map();

/**
 * The two lenses, resolved from a request.
 *
 * `recordedThrough` defaults to the clock at run start. That default is the
 * whole mechanism: it pins the knowledge boundary once, so an observation
 * recorded while the run is still executing cannot enter it, and a run's inputs
 * stop depending on how long the run happens to take.
 */
function lensFor(
  request: { effectiveAsOf?: Date; asOf?: Date; recordedThrough?: Date },
  clock: Clock,
): Lens {
  const now = clock.now();
  const effectiveAsOf = request.effectiveAsOf ?? request.asOf ?? now;
  return {
    effectiveAsOf,
    recordedThrough: request.recordedThrough ?? now,
  };
}
const MAX_DEPTH = 12;

export type PropagationEngineOptions = {
  registry: CalculationRegistry;
  valueGraph: ValueGraph;
  graphStore: GraphStore;
  /**
   * The Phase 1 ontology, for scope compatibility. Injected rather than
   * hard-coded: a calculation that says it applies to "commercial" subjects must
   * mean the same thing the ontology means by commercial, and a new entity type
   * must not require an edit here to be understood.
   */
  ontology: OntologyRegistry;
  store: CalculationStore;
  /** Injected, never ambient: a run's `asOf` must be reproducible (§15). */
  clock: Clock;
};

type ResolvedInput = { quantity: Quantity; traced: TracedInput };

/** One value node's answer to an input, before an aggregate is summed. */
type NodeResolution = {
  readonly node: ValueNode;
  /** Set for run outputs and overrides; null when built from `observation`. */
  readonly quantity: Quantity | null;
  readonly observation?: ValueObservation;
  readonly observationId: string;
  readonly observationType: ObservationType;
  readonly confidence: Confidence | null;
  readonly sourceSystem: string;
  readonly effectiveAt: ValidTime | null;
  readonly boundTo: Exclude<InputSource, 'MIXED'>;
  readonly override?: OverrideTrace;
};

/**
 * What THIS run has produced so far, keyed by the value node it produced it for.
 *
 * A downstream calculation must consume the derived output of its own run:
 *
 *   source world (actual / forecast / assumption)
 *     -> calculation run
 *       -> same-run derived output
 *         -> downstream calculations
 *
 * Re-querying the node instead makes that chain accidental — it holds only
 * because the run's own write happens to have the latest record time. Two runs
 * in flight at once break it, and the trace then cites an observation the run
 * did not produce, which makes a run's internal consistency unprovable.
 *
 * An UNCHANGED step contributes too: it produced no new observation, but it
 * confirmed the existing one as this run's answer for that node.
 */
type RunOutput = {
  readonly observationId: string;
  /**
   * The RAW quantity, at full internal precision — not the normalized value the
   * observation holds. A downstream step in the same run must continue from the
   * computation, not from its business-rounded representation, or normalization
   * error compounds at every link in the chain.
   */
  readonly quantity: Quantity;
  readonly observationType: ObservationType;
  readonly sourceSystem: string;
  readonly confidence: Confidence | null;
  readonly effectiveAt: ValidTime | null;
};
type RunOutputs = ReadonlyMap<string, RunOutput>;

export function createPropagationEngine(
  opts: PropagationEngineOptions,
): Result<PropagationEngine> {
  const { registry, valueGraph, graphStore, ontology, store, clock } = opts;

  // Cycles are rejected once, at construction. An engine that could be built
  // around a circular model would fail later, in front of a manager.
  const graphResult = buildDependencyGraph(registry);
  if (!graphResult.ok) return graphResult;
  const depGraph: MetricDependencyGraph = graphResult.value;

  // --------------------------------------------------------- input resolution

/**
 * The nodes an input binding reached, split by whether their time horizon is the
 * one the input asked for. The rejected set exists so a mismatch can be reported
 * as a mismatch ("expected revenue exists, but only for the year") instead of as
 * a bare missing input, which sends a reader looking for data that is there.
 */
type BoundNodes = { usable: readonly ValueNode[]; wrongHorizon: readonly ValueNode[] };

  /** Finds the value node(s) an input binding points at. */
  async function resolveInputNodes(
    scope: Scope,
    spec: CalculationInputSpec,
    outputNode: ValueNode,
    horizon: TimeHorizon | null,
  ): Promise<Result<BoundNodes>> {
    const wantHorizon = spec.horizon ?? horizon;

    // A node with no horizon at all is horizon-agnostic and always usable; an
    // input that declares allowCrossPeriod has said it does not care.
    const usableAt = (n: ValueNode): boolean =>
      spec.allowCrossPeriod ||
      wantHorizon == null ||
      n.timeHorizon == null ||
      n.timeHorizon === wantHorizon;

    const split = (nodes: readonly ValueNode[]): BoundNodes => {
      const forMetric = nodes.filter((n) => n.metricKey === spec.metricKey);
      return {
        usable: forMetric.filter(usableAt),
        wrongHorizon: forMetric.filter((n) => !usableAt(n)),
      };
    };

    switch (spec.binding.kind) {
      case 'SAME_SUBJECT': {
        if (!outputNode.subjectEntityId) {
          const scoped = await valueGraph.findValueNodes(scope, {
            metricKeys: [spec.metricKey],
            scopeKind: outputNode.scopeKind ?? undefined,
          });
          if (!scoped.ok) return scoped;
          return ok(split(scoped.value));
        }
        const nodes = await valueGraph.findNodesForEntity(scope, outputNode.subjectEntityId);
        if (!nodes.ok) return nodes;
        return ok(split(nodes.value));
      }

      case 'RELATED_ENTITY': {
        if (!outputNode.subjectEntityId) return ok({ usable: [], wrongHorizon: [] });
        // The ontology says which entity: this is where the calculation graph
        // and the Phase 1 semantic graph meet.
        const neighbors = await graphStore.getNeighbors(scope, {
          entityId: outputNode.subjectEntityId,
          direction: spec.binding.direction,
          relationshipTypeKeys: [spec.binding.relationshipTypeKey],
        });
        if (!neighbors.ok) return neighbors;

        let entities = neighbors.value.map((n) => n.entity);
        const filter = spec.binding.subjectFilter;
        if (filter) {
          entities = entities.filter((e) => e.attributes[filter.attribute] === filter.equals);
        }

        const usable: ValueNode[] = [];
        const wrongHorizon: ValueNode[] = [];
        for (const entity of entities) {
          const nodes = await valueGraph.findNodesForEntity(scope, entity.id);
          if (!nodes.ok) return nodes;
          const s = split(nodes.value);
          usable.push(...s.usable);
          wrongHorizon.push(...s.wrongHorizon);
        }
        return ok({ usable, wrongHorizon });
      }

      case 'SCOPED': {
        const nodes = await valueGraph.findValueNodes(scope, {
          metricKeys: [spec.metricKey],
          scopeKind: spec.binding.scopeKind,
        });
        if (!nodes.ok) return nodes;
        return ok(split(nodes.value));
      }

      default:
        return ok({ usable: [], wrongHorizon: [] });
    }
  }

  /**
   * Resolves one declared input to a unit-checked quantity plus its trace row.
   *
   * THE RESOLUTION STACK (ADR-0019 §4). Each value node the binding reaches is
   * resolved on its own, in this order, and the first layer that answers wins:
   *
   *   1. this run's own output for that node   — RUN_OUTPUT_IF_PLANNED inputs only
   *   2. the scenario override for that node    — the revision's own, else an
   *                                               ancestor's (already merged, child
   *                                               wins, shadowed ones recorded)
   *   3. the source world                        — the input's policy, both lenses,
   *                                               the run's period
   *   4. nothing                                 — MISSING_INPUT, or
   *                                               TIME_CONTEXT_MISMATCH when the
   *                                               world only speaks to other periods
   *
   * Layers 1 and 2 can never compete for one node: an override may only name a
   * node the run does not compute, which `execute` enforces before anything runs.
   * And an override does not change an input's binding semantics — a
   * SOURCE_POLICY_ONLY input still never reads a run output, and an overridden
   * source value is bound as an override, not promoted into model state.
   *
   * Resolving per node (rather than all-or-nothing) is also what keeps an
   * aggregate honest when only some of its parts were planned: the planned parts
   * still bind to this run's outputs instead of falling back to persisted values.
   */
  async function resolveInput(
    scope: Scope,
    spec: CalculationInputSpec,
    outputNode: ValueNode,
    policy: RunObservationPolicy,
    lens: Lens,
    horizon: TimeHorizon | null,
    period: Period | null,
    scenarioEntityId: EntityId | null,
    runOutputs: RunOutputs,
    overlay: InputOverlay | null,
  ): Promise<Result<ResolvedInput | null>> {
    const bound = await resolveInputNodes(scope, spec, outputNode, horizon);
    if (!bound.ok) return bound;
    const { usable, wrongHorizon } = bound.value;
    const requiredHorizon = spec.horizon ?? horizon;

    if (usable.length === 0) {
      if (!spec.required) return ok(null);
      // Cross-period rejection (§32). The data exists; it is about the wrong
      // period. Saying so is the difference between a reader fixing a horizon
      // and a reader hunting for a number that was never missing.
      if (wrongHorizon.length > 0) {
        const found = [...new Set(wrongHorizon.map((n) => n.timeHorizon))].join(', ');
        return fail(
          CalculationErrors.TIME_CONTEXT_MISMATCH,
          `"${spec.metricKey}" exists for this subject but only at ${found}, and input ` +
            `"${spec.name}" needs ${requiredHorizon}. Combining periods would produce a ` +
            'number that means nothing; declare allowCrossPeriod if it is genuinely valid.',
          {
            metricKey: spec.metricKey,
            requiredHorizon,
            foundHorizons: wrongHorizon.map((n) => n.timeHorizon),
          },
        );
      }
      return fail(
        CalculationErrors.MISSING_INPUT,
        `No value node supplies "${spec.metricKey}" for this subject. ` +
          `The model needs ${spec.description.toLowerCase()}`,
        { metricKey: spec.metricKey, binding: spec.binding.kind },
      );
    }

    const aggregate =
      spec.binding.kind === 'RELATED_ENTITY' && spec.binding.aggregate === true;
    if (usable.length > 1 && !aggregate) {
      return fail(
        CalculationErrors.AMBIGUOUS_INPUT,
        `${usable.length} value nodes supply "${spec.metricKey}" for this subject ` +
          'and the input does not declare aggregation. HELM will not choose one.',
        { metricKey: spec.metricKey, nodeIds: usable.map((n) => n.id) },
      );
    }

    const resolution: InputResolution = spec.resolution ?? 'SOURCE_POLICY_ONLY';
    const effectivePolicy: ObservationPolicy = spec.preference ?? policy;
    const order =
      resolution === 'RUN_OUTPUT_IF_PLANNED'
        ? // Not planned upstream: persisted model truth first — this input has
          // explicitly asked for the model — then what the business says, so a
          // gap degrades to a stated number rather than to nothing.
          unplannedDependencyOrder
        : policyOrder[effectivePolicy];
    // A point-in-time input (declared `current`) reads "as of" the effective
    // lens whatever period the run models; that carry-forward is what the
    // declaration means. Every other input is held to the run's period.
    const inputPeriod = spec.horizon === 'current' ? null : period;

    // --- per node, the resolution stack ---
    const parts: NodeResolution[] = [];
    for (const node of usable) {
      // 1. EXECUTION DEPENDENCY: this run's own output.
      if (resolution === 'RUN_OUTPUT_IF_PLANNED') {
        const out = runOutputs.get(node.id);
        if (out) {
          parts.push({
            node,
            quantity: out.quantity,
            observationId: out.observationId,
            observationType: out.observationType,
            confidence: out.confidence,
            sourceSystem: out.sourceSystem,
            effectiveAt: out.effectiveAt,
            boundTo: 'RUN_OUTPUT',
          });
          continue;
        }
      }

      // 2. SCENARIO OVERRIDE.
      const entry = overlay?.entries.get(node.id);
      if (entry) {
        const applied = await applyOverride(scope, spec, node, entry, order, lens, inputPeriod, scenarioEntityId);
        if (!applied.ok) return applied;
        parts.push(applied.value);
        continue;
      }

      // 3. SOURCE WORLD.
      const obs = await selectObservation(valueGraph, scope, node.id, order, lens, scenarioEntityId, inputPeriod);
      if (!obs.ok) return obs;
      if (obs.value) {
        parts.push({
          node,
          quantity: null,
          observation: obs.value,
          observationId: obs.value.id,
          observationType: obs.value.observationType,
          confidence: obs.value.confidence,
          sourceSystem: obs.value.sourceSystem,
          effectiveAt: obs.value.effectiveAt ?? obs.value.periodStart ?? null,
          boundTo: 'SOURCE_OBSERVATION',
        });
      }
    }

    // 4. NOTHING.
    if (parts.length === 0) {
      if (!spec.required) return ok(null);
      const describedPolicy =
        resolution === 'RUN_OUTPUT_IF_PLANNED' ? 'execution-dependency' : effectivePolicy;
      return fail(
        CalculationErrors.MISSING_INPUT,
        `"${spec.metricKey}" has a value node but no usable observation under the ` +
          `${describedPolicy} policy, effective ${lens.effectiveAsOf.toISOString()} and ` +
          `known through ${lens.recordedThrough.toISOString()}` +
          (inputPeriod ? ` for ${periodKey(inputPeriod)}` : '') +
          `. The model needs ${spec.description.toLowerCase()}`,
        {
          metricKey: spec.metricKey,
          policy: effectivePolicy,
          resolution,
          effectiveAsOf: lens.effectiveAsOf.toISOString(),
          recordedThrough: lens.recordedThrough.toISOString(),
          period: inputPeriod ? periodKey(inputPeriod) : null,
        },
      );
    }

    // --- units, before compute() ever sees a value ---
    const quantities: Quantity[] = [];
    for (const part of parts) {
      let q: Quantity;
      if (part.quantity) {
        q = part.quantity;
      } else {
        const o = part.observation!;
        if (o.unitType !== spec.expectUnit) {
          return fail(
            CalculationErrors.UNIT_MISMATCH,
            `Input "${spec.name}" expects ${spec.expectUnit} but "${spec.metricKey}" observations ` +
              `are in ${o.unitType}.`,
            { expected: spec.expectUnit, received: o.unitType },
          );
        }
        const made = quantity(decimal(o.numericValue ?? 0), o.unitType, o.currency);
        if (!made.ok) return made;
        q = made.value;
      }
      if (q.unit !== spec.expectUnit) {
        return fail(
          CalculationErrors.UNIT_MISMATCH,
          `Input "${spec.name}" expects ${spec.expectUnit} but received ` +
            `${spec.metricKey} in ${q.unit}.`,
          { expected: spec.expectUnit, received: q.unit },
        );
      }
      quantities.push(q);
    }
    const currency = quantities[0].currency;
    if (quantities.some((q) => q.currency !== currency)) {
      return fail(
        CalculationErrors.CURRENCY_MISMATCH,
        `Aggregated "${spec.metricKey}" values mix units or currencies.`,
      );
    }

    const total = sumAll(quantities.map((q) => q.amount));
    const totalQuantity = quantity(total, spec.expectUnit, currency);
    if (!totalQuantity.ok) return totalQuantity;

    const bindings = [...new Set(parts.map((p) => p.boundTo))];
    const confidences = parts.map((p) => p.confidence).filter((c): c is number => c !== null);
    const first = parts[0];

    return ok({
      quantity: totalQuantity.value,
      traced: {
        name: spec.name,
        metricKey: spec.metricKey,
        nodeId: parts.map((p) => p.node.id).join('+'),
        observationId: parts.map((p) => p.observationId).join('+'),
        observationType: first.observationType,
        value: decToString(total),
        unit: spec.expectUnit,
        currency,
        confidence: confidences.length > 0 ? Math.min(...confidences) : null,
        sourceSystem: first.sourceSystem,
        effectiveAt: first.effectiveAt,
        boundTo: bindings.length === 1 ? bindings[0] : 'MIXED',
        override: parts.length === 1 ? first.override : undefined,
        // Only when more than one claim was summed: for a single input the
        // components would restate the value and add nothing.
        components:
          parts.length > 1
            ? parts.map((p, i) => ({
                nodeId: p.node.id,
                observationId: p.observationId,
                value: decToString(quantities[i].amount),
                observationType: p.observationType,
                boundTo: p.boundTo,
                override: p.override,
              }))
            : undefined,
      },
    });
  }

  /**
   * Layer 2 of the stack. SET binds the override's value; ADD reads the value
   * the run would otherwise have used — same order, same lenses, same period —
   * and adds the delta. An ADD with nothing to add to is a missing input, not a
   * zero: "freight +80M" says nothing about what freight is.
   */
  async function applyOverride(
    scope: Scope,
    spec: CalculationInputSpec,
    node: ValueNode,
    entry: OverlayEntry,
    order: readonly ObservationType[],
    lens: Lens,
    period: Period | null,
    scenarioEntityId: EntityId | null,
  ): Promise<Result<NodeResolution>> {
    if (entry.unit !== spec.expectUnit) {
      return fail(
        CalculationErrors.UNIT_MISMATCH,
        `Scenario override ${entry.overrideId} states "${spec.metricKey}" in ${entry.unit}, ` +
          `but input "${spec.name}" expects ${spec.expectUnit}.`,
        { expected: spec.expectUnit, received: entry.unit, overrideId: entry.overrideId },
      );
    }
    const trace: OverrideTrace = {
      overrideId: entry.overrideId,
      scenarioId: entry.scenarioId,
      revisionId: entry.revisionId,
      operation: entry.operation,
      value: canonicalNumeric(entry.value),
      inheritedFromScenarioId: entry.inheritedFromScenarioId,
      shadowedOverrideIds: entry.shadowedOverrideIds,
      provenanceKind: entry.provenanceKind,
      baseline: null,
    };

    if (entry.operation === 'SET') {
      const q = quantity(decimal(entry.value), entry.unit, entry.currency);
      if (!q.ok) return q;
      return ok({
        node,
        quantity: q.value,
        observationId: `override:${entry.overrideId}`,
        observationType: 'SCENARIO',
        confidence: entry.confidence,
        sourceSystem: 'scenario',
        effectiveAt: null,
        boundTo: 'SCENARIO_OVERRIDE',
        override: trace,
      });
    }

    // ADD: against the baseline this run would have read.
    const base = await selectObservation(valueGraph, scope, node.id, order, lens, scenarioEntityId, period);
    if (!base.ok) return base;
    if (!base.value) {
      return fail(
        CalculationErrors.MISSING_INPUT,
        `Scenario override ${entry.overrideId} adjusts "${spec.metricKey}" by ${entry.value}, ` +
          'but the baseline has no value to adjust under this run\'s lenses and period. ' +
          'State the value with SET instead.',
        { overrideId: entry.overrideId, metricKey: spec.metricKey },
      );
    }
    const b = base.value;
    if (b.unitType !== entry.unit || b.currency !== entry.currency) {
      return fail(
        CalculationErrors.UNIT_MISMATCH,
        `Scenario override ${entry.overrideId} is in ${entry.unit} ${entry.currency ?? ''} ` +
          `but the baseline "${spec.metricKey}" is in ${b.unitType} ${b.currency ?? ''}.`,
      );
    }
    const baseAmount = decimal(b.numericValue ?? 0);
    const q = quantity(sumAll([baseAmount, decimal(entry.value)]), entry.unit, entry.currency);
    if (!q.ok) return q;
    const confs = [entry.confidence, b.confidence].filter((c): c is number => c !== null);
    return ok({
      node,
      quantity: q.value,
      observationId: `override:${entry.overrideId}`,
      observationType: 'SCENARIO',
      confidence: confs.length > 0 ? Math.min(...confs) : null,
      sourceSystem: 'scenario',
      effectiveAt: b.effectiveAt ?? b.periodStart ?? null,
      boundTo: 'SCENARIO_OVERRIDE',
      override: {
        ...trace,
        baseline: {
          observationId: b.id,
          value: canonicalNumeric(decToString(baseAmount)),
          observationType: b.observationType,
        },
      },
    });
  }

  // ------------------------------------------------------------ fingerprint


  // ------------------------------------------------------------ confidence

  /** ADR-0017 §3: min(input confidences) × definition confidence. */
  function combineConfidence(
    calc: CalculationDefinition,
    inputs: readonly TracedInput[],
  ): Confidence {
    const known = inputs.map((i) => i.confidence).filter((c): c is number => c !== null);
    // A missing confidence is a stated fact we have no reason to doubt, not zero.
    const weakest = known.length > 0 ? Math.min(...known) : 1;
    return clampConfidence(weakest * calc.definitionConfidence);
  }

  // ----------------------------------------------------------------- planning

  async function buildPlan(
    scope: Scope,
    request: PropagationRequest,
  ): Promise<Result<{ plan: PropagationPlan; horizon: TimeHorizon | null }>> {
    const maxDepth = request.maxDepth ?? MAX_DEPTH;
    if (maxDepth < 0 || maxDepth > MAX_DEPTH) {
      return fail(
        CalculationErrors.DEPTH_EXCEEDED,
        `maxDepth must be 0..${MAX_DEPTH}, got ${maxDepth}.`,
      );
    }

    // Which metrics changed?
    let changedMetrics: string[] = [...(request.fromMetricKeys ?? [])];
    const rootSubjects = new Set<EntityId>();
    for (const id of request.fromNodeIds ?? []) {
      const node = await valueGraph.getValueNode(scope, id);
      if (!node.ok) return node;
      if (!node.value) {
        return fail(CalculationErrors.NODE_NOT_FOUND, `Value node ${id} not found.`);
      }
      changedMetrics.push(node.value.metricKey);
      if (node.value.subjectEntityId) rootSubjects.add(node.value.subjectEntityId);
    }
    if (changedMetrics.length === 0) {
      // No starting point: recompute everything computable.
      changedMetrics = [...depGraph.roots];
    }
    changedMetrics = [...new Set(changedMetrics)];

    // Incremental: only metrics downstream of the change (§24).
    const affected = downstreamOf(depGraph, changedMetrics);
    const targetMetrics = affected.filter((_m, i) => i < 10_000).slice(0, maxDepth * 50);

    // A stated period implies its horizon; a caller who states both must mean
    // the same thing by them.
    const grainHorizon: TimeHorizon | null = request.period
      ? request.period.grain === 'QUARTER'
        ? 'quarter'
        : request.period.grain === 'MONTH'
          ? 'month'
          : request.period.grain === 'YEAR'
            ? 'year'
            : null
      : null;
    if (request.period && request.horizon && grainHorizon && request.horizon !== grainHorizon) {
      return fail(
        CalculationErrors.TIME_CONTEXT_MISMATCH,
        `The run states period ${periodKey(request.period)} but horizon "${request.horizon}".`,
      );
    }
    const horizon =
      request.horizon !== undefined ? request.horizon : (grainHorizon ?? 'quarter');

    // For each affected metric, find the value nodes that should carry it.
    const planNodes: PropagationPlanNode[] = [];
    const uncomputable: { nodeId: string; metricKey: string; reason: string }[] = [];
    let order = 0;

    for (const metricKey of targetMetrics) {
      const producers = registry.findByOutputMetric(metricKey);
      if (producers.length === 0) continue;

      const candidates = await valueGraph.findValueNodes(scope, {
        metricKeys: [metricKey],
        limit: 500,
      });
      if (!candidates.ok) return candidates;

      for (const node of candidates.value) {
        if (
          request.subjectEntityIds?.length &&
          node.subjectEntityId &&
          !request.subjectEntityIds.includes(node.subjectEntityId)
        ) {
          continue;
        }
        if (horizon && node.timeHorizon && node.timeHorizon !== horizon) continue;

        // Scope compatibility (§31) decides WHICH producer computes this node.
        // The registry guarantees producers of one metric have disjoint scopes,
        // so at most one applies; if none does, the node is declared
        // uncomputable with every producer's reason rather than silently skipped.
        let category: string | null = null;
        if (node.subjectEntityId) {
          const entity = await graphStore.getEntity(scope, node.subjectEntityId);
          if (!entity.ok) return entity;
          if (entity.value) category = ontology.categoryOf(entity.value.entityTypeKey);
        }
        const applies = (d: CalculationDefinition): boolean =>
          d.scopeCompatibility === null || category === null || d.scopeCompatibility.includes(category);
        const calc = producers.find(applies);
        if (!calc) {
          uncomputable.push({
            nodeId: node.id,
            metricKey,
            reason: producers
              .map(
                (d) =>
                  `${calculationRef(d)} does not apply to a ${category} subject ` +
                  `(allowed: ${(d.scopeCompatibility ?? []).join(', ')})`,
              )
              .join('; '),
          });
          continue;
        }

        planNodes.push({
          calculation: calc,
          outputNodeId: node.id,
          order,
          dependsOn: (depGraph.dependsOn.get(metricKey) ?? []).filter((d) =>
            targetMetrics.includes(d),
          ),
        });
      }
      order += 1;
    }

    planNodes.sort((a, b) => a.order - b.order || a.outputNodeId.localeCompare(b.outputNodeId));
    return ok({ plan: { nodes: planNodes, uncomputable }, horizon });
  }

  // ---------------------------------------------------------------- execution

  const engine: PropagationEngine = {
    async planPropagation(scope, request) {
      const built = await buildPlan(scope, request);
      if (!built.ok) return built;
      return ok(built.value.plan);
    },

    async execute(scope, request) {
      const lens = lensFor(request, clock);
      const overlay = request.overlay ?? null;
      // A scenario RUNTIME run reads reality through the baseline's policy and
      // layers its overrides on top. Only the legacy form — a scenario entity
      // with no overlay — reads stated SCENARIO observations (ADR-0019 §5).
      const policy: RunObservationPolicy =
        request.preference ??
        (request.scenarioEntityId && !overlay ? 'SCENARIO' : 'SOURCE_TRUTH');
      const scenarioEntityId = request.scenarioEntityId ?? null;
      const period = request.period ?? null;

      if (overlay) {
        if (!scenarioEntityId || !request.scenarioRevisionId) {
          return fail(
            CalculationErrors.INVALID_OVERLAY,
            'An overlay run must name the scenario entity its outputs belong to and the ' +
              'scenario revision it executes.',
          );
        }
        if (policy === 'SCENARIO') {
          return fail(
            CalculationErrors.INVALID_OVERLAY,
            'An overlay run reads the baseline world and applies explicit overrides. Combined ' +
              'with the SCENARIO policy it would also read persisted scenario outputs as inputs, ' +
              'so an earlier run of a scenario could feed a later one.',
          );
        }
        if (overlay.revisionId !== request.scenarioRevisionId) {
          return fail(
            CalculationErrors.INVALID_OVERLAY,
            `The overlay belongs to revision ${overlay.revisionId}, not ${request.scenarioRevisionId}.`,
          );
        }
      }

      const built = await buildPlan(scope, request);
      if (!built.ok) return built;
      const { plan, horizon } = built.value;

      // An override changes an input, never an outcome. A scenario that states
      // the value of something the model computes would be asserting its own
      // conclusion, and the trace would show a derivation that never ran.
      if (overlay) {
        const computed = plan.nodes.filter((n) => overlay.entries.has(n.outputNodeId));
        if (computed.length > 0) {
          return fail(
            CalculationErrors.OVERRIDE_TARGETS_COMPUTED_NODE,
            `${computed.length} override(s) name value nodes this model computes ` +
              `(${computed.map((n) => `${n.calculation.outputMetricKey} via ${calculationRef(n.calculation)}`).join('; ')}). ` +
              'Override the inputs; the outcome is derived.',
            {
              nodeIds: computed.map((n) => n.outputNodeId),
              overrideIds: computed.map((n) => overlay.entries.get(n.outputNodeId)!.overrideId),
            },
          );
        }
      }

      const runInput: Omit<CalculationRun, 'id' | 'orgId' | 'startedAt'> = {
        status: 'RUNNING',
        triggerType: request.triggerType ?? 'MANUAL',
        context: {
          effectiveAsOf: lens.effectiveAsOf.toISOString(),
          recordedThrough: lens.recordedThrough.toISOString(),
          horizon,
          preference: policy,
          scenarioEntityId,
          rootNodeIds: request.fromNodeIds ?? [],
          rootMetricKeys: request.fromMetricKeys ?? [],
          subjectEntityIds: request.subjectEntityIds ?? [],
          engineVersion: ENGINE_VERSION,
          period,
          scenarioRevisionId: overlay ? request.scenarioRevisionId ?? null : null,
        },
        completedAt: null,
        replayOfRunId: null,
        notes: request.notes ?? null,
        createdBy: scope.actorId,
      };

      if (request.dryRun) {
        return ok({
          run: { ...runInput, id: 'dry-run', orgId: scope.orgId, startedAt: asRecord(clock) },
          steps: [],
          written: [],
          summary: emptySummary(),
          uncomputable: plan.uncomputable,
        });
      }

      const runResult = await store.createRun(scope, runInput);
      if (!runResult.ok) return runResult;
      const run = runResult.value;

      const steps: CalculationStep[] = [];
      const written: ValueObservation[] = [];
      const summary = emptySummary();
      // This run's answer per value node — see RunOutputs.
      const runOutputs = new Map<string, RunOutput>();
      let sequence = 0;

      for (const planNode of plan.nodes) {
        const calc = planNode.calculation;
        sequence += 1;

        const node = await valueGraph.getValueNode(scope, planNode.outputNodeId);
        if (!node.ok || !node.value) {
          await recordStep(scope, run.id, sequence, calc, planNode.outputNodeId, {
            status: 'FAILED',
            errorCode: CalculationErrors.NODE_NOT_FOUND,
            errorMessage: `Output node ${planNode.outputNodeId} disappeared mid-run.`,
          }, steps, summary);
          continue;
        }

        // --- resolve inputs; a failure BLOCKS this step only (§48) ---
        const resolved: Record<string, Quantity> = {};
        const traced: TracedInput[] = [];
        let blocked: { code: string; message: string } | null = null;

        for (const spec of calc.inputs) {
          const r = await resolveInput(
            scope,
            spec,
            node.value,
            policy,
            lens,
            horizon,
            period,
            scenarioEntityId,
            runOutputs,
            overlay,
          );
          if (!r.ok) {
            blocked = { code: r.error.code, message: r.error.message };
            break;
          }
          if (r.value) {
            resolved[spec.name] = r.value.quantity;
            traced.push(r.value.traced);
          }
        }

        if (blocked) {
          await recordStep(scope, run.id, sequence, calc, node.value.id, {
            status: 'BLOCKED',
            inputs: traced,
            errorCode: blocked.code,
            errorMessage: blocked.message,
          }, steps, summary);
          continue;
        }

        const fp = inputFingerprint(calculationRef(calc), {
          horizon: horizon ?? '',
          scenario: scenarioEntityId ?? '',
          period,
        }, traced);

        // --- idempotency: an identical computation is UNCHANGED (§26) ---
        const previous = await store.findLatestStepForNode(scope, node.value.id);
        if (
          previous.ok &&
          previous.value &&
          previous.value.inputFingerprint === fp &&
          previous.value.status === 'CALCULATED'
        ) {
          await recordStep(scope, run.id, sequence, calc, node.value.id, {
            status: 'UNCHANGED',
            inputs: traced,
            outputValue: previous.value.outputValue,
            outputUnit: previous.value.outputUnit,
            outputCurrency: previous.value.outputCurrency,
            outputObservationId: previous.value.outputObservationId,
            renderedExpression: previous.value.renderedExpression,
            confidence: previous.value.confidence,
            inputFingerprint: fp,
          }, steps, summary);
          if (previous.value.outputObservationId && previous.value.outputValue) {
            // An UNCHANGED step produced no new observation but its value still
            // stands as this run's answer. The RAW value is carried where the
            // step recorded one, so a downstream step continues from the
            // computation rather than from its rounded representation.
            const carried = quantity(
              decimal(previous.value.outputValueRaw ?? previous.value.outputValue),
              previous.value.outputUnit ?? calc.outputUnit,
              previous.value.outputCurrency,
            );
            if (carried.ok) {
              runOutputs.set(node.value.id, {
                observationId: previous.value.outputObservationId,
                quantity: carried.value,
                observationType: scenarioEntityId ? 'SCENARIO' : 'DERIVED',
                sourceSystem: 'helm',
                confidence: previous.value.confidence,
                effectiveAt: null,
              });
            }
          }
          continue;
        }

        // --- compute ---
        const computeCtx: ComputeContext = {
          scope,
          asOf: lens.effectiveAsOf,
          horizon,
          subjectEntityId: node.value.subjectEntityId,
        };
        let output: Result<Quantity>;
        try {
          output = calc.compute(computeCtx, resolved as ResolvedInputs);
        } catch (e) {
          output = fail(
            CalculationErrors.CALCULATION_FAILED,
            e instanceof Error ? e.message : String(e),
          );
        }

        if (!output.ok) {
          await recordStep(scope, run.id, sequence, calc, node.value.id, {
            status: 'FAILED',
            inputs: traced,
            inputFingerprint: fp,
            errorCode: output.error.code,
            errorMessage: output.error.message,
          }, steps, summary);
          continue;
        }

        if (output.value.unit !== calc.outputUnit) {
          await recordStep(scope, run.id, sequence, calc, node.value.id, {
            status: 'FAILED',
            inputs: traced,
            inputFingerprint: fp,
            errorCode: CalculationErrors.UNIT_MISMATCH,
            errorMessage:
              `${calculationRef(calc)} declared output unit ${calc.outputUnit} but produced ` +
              `${output.value.unit}.`,
          }, steps, summary);
          continue;
        }

        const confidence = combineConfidence(calc, traced);

        // --- write the observation ---
        const observationType: ObservationType = scenarioEntityId ? 'SCENARIO' : 'DERIVED';
        // The metric registry is the authority on how this value meets time.
        const metric = await valueGraph.getMetricDefinition(scope, calc.outputMetricKey);
        if (!metric.ok) return metric;
        if (!metric.value) {
          await recordStep(scope, run.id, sequence, calc, node.value.id, {
            status: 'FAILED',
            inputs: traced,
            inputFingerprint: fp,
            errorCode: CalculationErrors.UNKNOWN_METRIC,
            errorMessage:
              `${calculationRef(calc)} outputs "${calc.outputMetricKey}", which is no longer ` +
              'a registered value metric, so HELM cannot tell how it relates to time.',
          }, steps, summary);
          continue;
        }
        const outPeriod = periodFor(metric.value.timeBehavior, node.value, horizon, lens.effectiveAsOf, period);

        // ---------------------------------------------------------------
        // BUSINESS NORMALIZATION. The arithmetic ran at full internal
        // precision; what gets written down is the business value at the
        // metric's storage scale. 2 687 699 999.9999999999999999999969 VND is
        // a true statement about decimal division and a false statement about
        // money — there is no such thing as a fraction of a dong.
        //
        // The raw value stays in the trace, so a reader can see that the
        // stored number is a rounding of the computation and not an invention.
        // ---------------------------------------------------------------
        const policyForMetric = policyFor(
          output.value.unit,
          output.value.currency,
          overrideFromMetadata(metric.value.metadata),
        );
        const normalized = normalize(output.value.amount, policyForMetric);
        const businessValue = mustQuantity(
          normalized.normalized,
          output.value.unit,
          output.value.currency,
        );
        const rendered = renderExpression(calc, traced, businessValue);

        // The provenance record names the RUN, not the observation. It has to
        // exist before the observation (which points at it), and helm_provenance
        // is append-only, so a placeholder subject could never be corrected
        // afterwards. The reverse direction is served by the calculation step,
        // which is indexed by the observation it produced and is the richer
        // lineage record anyway.
        const provenance = await valueGraph.recordProvenance(scope, {
          subjectKind: 'calculation_run',
          subjectId: run.id,
          sourceField: null,
          method: 'calculated',
          system: 'helm',
          connector: `propagation-engine@${ENGINE_VERSION}`,
          sourceObjectType: 'calculation',
          sourceObjectId: calculationRef(calc),
          ingestionEventId: null,
          transformation: calc.expression,
          inputs: {
            calculationRun: run.id,
            fingerprint: fp,
            inputs: traced.map((t) => ({
              name: t.name,
              observationId: t.observationId,
              value: t.value,
              unit: t.unit,
            })),
          },
          actorId: null,
          confidence,
          notes: rendered,
          payload: null,
          observedAt: asValidTime(lens.effectiveAsOf.toISOString()),
        });
        if (!provenance.ok) return provenance;

        const obs = await valueGraph.recordObservation(scope, {
          nodeId: node.value.id,
          observationType,
          // The NORMALIZED business value, not the raw computation.
          numericValue: toNumber(normalized.normalized),
          unitType: output.value.unit,
          currency: output.value.currency,
          effectiveAt: outPeriod.effectiveAt,
          periodStart: outPeriod.periodStart,
          periodEnd: outPeriod.periodEnd,
          observedAt: asValidTime(lens.effectiveAsOf.toISOString()),
          scenarioEntityId,
          confidence,
          sourceSystem: 'helm',
          provenanceId: provenance.value.id,
          metadata: {
            derivedByCalculation: calculationRef(calc),
            calculationRunId: run.id,
            inputFingerprint: fp,
            // Exact decimal string of the stored business value. This is the
            // authoritative representation; `numericValue` is a convenience.
            exactValue: normalized.normalizedText,
            // What the arithmetic actually produced, when normalization moved it.
            rawValue: normalized.adjusted ? normalized.rawText : undefined,
            precision: {
              storageScale: policyForMetric.storageScale,
              roundingMode: policyForMetric.roundingMode,
            },
            // The modelled period, for every output — including point-in-time
            // ones, whose value columns cannot carry an interval.
            period: period ? periodKey(period) : undefined,
            scenarioRevisionId: overlay ? overlay.revisionId : undefined,
          },
        });
        if (!obs.ok) {
          await recordStep(scope, run.id, sequence, calc, node.value.id, {
            status: 'FAILED',
            inputs: traced,
            inputFingerprint: fp,
            errorCode: obs.error.code,
            errorMessage: obs.error.message,
          }, steps, summary);
          continue;
        }

        written.push(obs.value);
        // EXECUTION STATE: the run binds the RAW quantity, not the normalized
        // observation. A downstream step continues from the computation, so
        // normalization cannot compound down the chain.
        runOutputs.set(node.value.id, {
          observationId: obs.value.id,
          quantity: output.value,
          observationType,
          sourceSystem: 'helm',
          confidence,
          effectiveAt: outPeriod.effectiveAt ?? outPeriod.periodStart ?? null,
        });
        await recordStep(scope, run.id, sequence, calc, node.value.id, {
          status: 'CALCULATED',
          inputs: traced,
          outputValue: normalized.normalizedText,
          outputValueRaw: normalized.adjusted ? normalized.rawText : null,
          outputUnit: output.value.unit,
          outputCurrency: output.value.currency,
          outputObservationId: obs.value.id,
          renderedExpression: rendered,
          confidence,
          inputFingerprint: fp,
        }, steps, summary);
      }

      const status =
        summary.FAILED > 0 || summary.BLOCKED > 0
          ? summary.CALCULATED > 0 || summary.UNCHANGED > 0
            ? 'PARTIAL'
            : 'FAILED'
          : 'COMPLETED';
      const completed = await store.completeRun(scope, run.id, status);
      if (!completed.ok) return completed;

      return ok({ run: completed.value, steps, written, summary, uncomputable: plan.uncomputable });
    },

    async propagateFrom(scope, metricKey, options = {}) {
      return engine.execute(scope, {
        ...options,
        fromMetricKeys: [metricKey],
        triggerType: options.triggerType ?? 'SOURCE_CHANGE',
      });
    },

    async explain(scope, observationId, maxDepth = 8) {
      return explainInternal(scope, observationId, maxDepth, new Set());
    },

    async checkFreshness(scope, nodeIds, options = {}) {
      const nowLens = lensFor(options, clock);
      const out: Freshness[] = [];

      for (const nodeId of nodeIds) {
        const node = await valueGraph.getValueNode(scope, nodeId);
        if (!node.ok || !node.value) {
          out.push({
            nodeId,
            observationId: null,
            state: 'UNKNOWN',
            recordedFingerprint: null,
            currentFingerprint: null,
            reason: 'value node not found',
          });
          continue;
        }

        const step = await store.findLatestStepForNode(scope, nodeId);
        if (!step.ok || !step.value || step.value.status !== 'CALCULATED') {
          out.push({
            nodeId,
            observationId: null,
            state: 'UNKNOWN',
            recordedFingerprint: null,
            currentFingerprint: null,
            reason: 'no derived value has been calculated for this node',
          });
          continue;
        }

        // Freshness is judged under the SAME context the value was calculated
        // in. Re-resolving a baseline number under a scenario preference would
        // report it stale because the question changed, not because a fact did.
        const run = await store.getRun(scope, step.value.runId);
        if (!run.ok) return run;
        const contextHorizon = run.value ? run.value.context.horizon : node.value.timeHorizon;
        const runHorizon = contextHorizon ?? '';
        const preference: RunObservationPolicy =
          options.preference ?? run.value?.context.preference ?? 'SOURCE_TRUTH';
        // The effective lens comes from the run (what it was modelling); the
        // knowledge lens moves to NOW, because the question freshness answers
        // is "has anything been learned since?".
        const freshnessLens = {
          effectiveAsOf: run.value
            ? new Date(run.value.context.effectiveAsOf)
            : nowLens.effectiveAsOf,
          recordedThrough: options.recordedThrough ?? nowLens.recordedThrough,
        };
        const scenarioEntityId =
          options.scenarioEntityId ?? run.value?.context.scenarioEntityId ?? null;

        const calc = registry.get(step.value.calculationKey, step.value.calculationVersion);
        if (!calc) {
          out.push({
            nodeId,
            observationId: step.value.outputObservationId,
            state: 'UNKNOWN',
            recordedFingerprint: step.value.inputFingerprint,
            currentFingerprint: null,
            reason: `calculation ${step.value.calculationKey}@${step.value.calculationVersion} is no longer registered`,
          });
          continue;
        }

        // Re-resolve the inputs as they are NOW and compare fingerprints.
        // Nothing is mutated: the old derived value stays exactly as recorded
        // and simply becomes known-stale.
        const traced: TracedInput[] = [];
        let resolvable = true;
        for (const spec of calc.inputs) {
          const r = await resolveInput(
            scope,
            spec,
            node.value,
            preference,
            freshnessLens,
            contextHorizon,
            run.value?.context.period ?? null,
            scenarioEntityId,
            // Freshness asks what the inputs are NOW, outside any run, so
            // there is no execution frame to bind to.
            EMPTY_RUN_OUTPUTS,
            // Nor an overlay: a scenario value's freshness is a question for
            // the scenario runtime, which holds the revision.
            null,
          );
          if (!r.ok) {
            resolvable = false;
            break;
          }
          if (r.value) traced.push(r.value.traced);
        }

        if (!resolvable) {
          out.push({
            nodeId,
            observationId: step.value.outputObservationId,
            state: 'UNKNOWN',
            recordedFingerprint: step.value.inputFingerprint,
            currentFingerprint: null,
            reason: 'inputs can no longer be resolved',
          });
          continue;
        }

        const current = inputFingerprint(calculationRef(calc), {
          horizon: runHorizon,
          scenario: scenarioEntityId ?? '',
          period: run.value?.context.period ?? null,
        }, traced);
        const recorded = step.value.inputFingerprint;
        const matches = recorded === current;

        out.push({
          nodeId,
          observationId: step.value.outputObservationId,
          state: matches ? 'CLEAN' : 'STALE',
          recordedFingerprint: recorded,
          currentFingerprint: current,
          reason: matches
            ? 'inputs are unchanged since this value was calculated'
            : 'an input has changed since this value was calculated',
        });
      }
      return ok(out);
    },

    async replay(scope, runId) {
      const original = await store.getRun(scope, runId);
      if (!original.ok) return original;
      if (!original.value) {
        return fail(CalculationErrors.READ_FAILED, `Calculation run ${runId} not found.`);
      }
      // Replay reconstructs what HELM COULD KNOW when the original ran, not
      // merely the arithmetic it performed. Both lenses are restored, so an
      // observation recorded after the original's knowledge cutoff stays
      // invisible to the replay however long ago that was — which is what makes
      // a replay evidence about the original decision rather than a fresh run
      // that happens to use old numbers.
      const ctx = original.value.context;
      if (ctx.scenarioRevisionId) {
        return fail(
          CalculationErrors.REPLAY_REQUIRES_SCENARIO_RUNTIME,
          `Run ${runId} executed scenario revision ${ctx.scenarioRevisionId}. Its overrides live ` +
            'with that revision, so replaying it here would silently drop them; replay it ' +
            'through the scenario runtime.',
          { runId, scenarioRevisionId: ctx.scenarioRevisionId },
        );
      }
      return engine.execute(scope, {
        fromNodeIds: ctx.rootNodeIds,
        fromMetricKeys: ctx.rootMetricKeys,
        subjectEntityIds: ctx.subjectEntityIds.length > 0 ? ctx.subjectEntityIds : undefined,
        effectiveAsOf: new Date(ctx.effectiveAsOf),
        recordedThrough: new Date(ctx.recordedThrough),
        horizon: ctx.horizon,
        preference: ctx.preference,
        scenarioEntityId: ctx.scenarioEntityId,
        period: ctx.period,
        triggerType: 'REPLAY',
        notes: `replay of ${runId}`,
      });
    },

    async truthLayers(scope, nodeId, options = {}) {
      return readTruthLayers(
        valueGraph,
        scope,
        nodeId,
        lensFor(options, clock),
        options.sourcePolicy ?? 'SOURCE_TRUTH',
        options.period ?? null,
      );
    },

    async getRun(scope, runId) {
      return store.getRun(scope, runId);
    },

    async getTrace(scope, runId) {
      return store.getSteps(scope, runId);
    },

    async listRuns(scope, limit = 50) {
      return store.listRuns(scope, limit);
    },
  };

  // ------------------------------------------------------------- explain()

  async function explainInternal(
    scope: Scope,
    observationId: string,
    depthLeft: number,
    seen: Set<string>,
  ): Promise<Result<Explanation>> {
    if (seen.has(observationId)) {
      return fail(
        CalculationErrors.CYCLE_DETECTED,
        `Lineage revisits observation ${observationId}.`,
      );
    }
    seen.add(observationId);

    const step = await store.findStepByOutputObservation(scope, observationId);
    if (!step.ok) return step;

    // Locate the observation itself. A derived one is found through its step;
    // a source fact is found by scanning its node.
    let obs: ValueObservation | null = null;
    let node: ValueNode | null = null;

    if (step.value) {
      const n = await valueGraph.getValueNode(scope, step.value.outputNodeId);
      if (!n.ok) return n;
      node = n.value;
      if (node) {
        const all = await valueGraph.getObservations(scope, { nodeId: node.id, limit: 200 });
        if (!all.ok) return all;
        obs = all.value.find((o) => o.id === observationId) ?? null;
      }
    }

    if (!obs) {
      const found = await findObservationAnywhere(scope, observationId);
      if (!found.ok) return found;
      obs = found.value.observation;
      node = found.value.node;
    }

    if (!obs || !node) {
      return fail(
        CalculationErrors.READ_FAILED,
        `Observation ${observationId} not found in this organization.`,
      );
    }

    // Source facts carry provenance rather than a derivation.
    const provenance = await valueGraph.getObservationProvenance(scope, obs.id);
    const prov = provenance.ok && provenance.value.length > 0 ? provenance.value[0] : null;

    const inputs: Explanation[] = [];
    if (step.value && depthLeft > 0) {
      for (const traced of step.value.inputs) {
        // An aggregated input joins several observations with '+'.
        const ids = traced.observationId.split('+');
        for (let i = 0; i < ids.length; i += 1) {
          const id = ids[i];
          if (id.startsWith('override:')) {
            // A scenario override is not an observation. It is explained from
            // the trace, which recorded it exactly as it was applied, and an
            // ADD continues into the baseline observation it adjusted.
            const part = traced.components?.[i];
            const trace = part?.override ?? traced.override;
            if (!trace) continue;
            const child = await explainOverride(scope, traced, part?.nodeId ?? traced.nodeId,
              part?.value ?? traced.value, trace, depthLeft - 1, seen);
            if (child.ok) inputs.push(child.value);
            continue;
          }
          const child = await explainInternal(scope, id, depthLeft - 1, new Set(seen));
          if (child.ok) inputs.push(child.value);
        }
      }
    }

    const exactValue =
      (obs.metadata as { exactValue?: string } | undefined)?.exactValue ??
      String(obs.numericValue ?? obs.textValue ?? '');

    return ok({
      observationId: obs.id,
      metricKey: node.metricKey,
      nodeLabel: node.label,
      value: exactValue,
      unit: obs.unitType,
      currency: obs.currency,
      observationType: obs.observationType,
      confidence: obs.confidence,
      derivation: step.value
        ? {
            calculationKey: step.value.calculationKey,
            calculationVersion: step.value.calculationVersion,
            expression:
              registry.get(step.value.calculationKey, step.value.calculationVersion)?.expression ??
              '',
            renderedExpression: step.value.renderedExpression,
            runId: step.value.runId,
            recordedAt: step.value.recordedAt,
          }
        : null,
      source: prov
        ? {
            system: prov.system,
            method: prov.method,
            sourceObjectType: prov.sourceObjectType,
            sourceObjectId: prov.sourceObjectId,
            observedAt: prov.observedAt,
          }
        : null,
      inputs,
    });
  }

  async function explainOverride(
    scope: Scope,
    traced: TracedInput,
    nodeId: string,
    value: string,
    trace: OverrideTrace,
    depthLeft: number,
    seen: Set<string>,
  ): Promise<Result<Explanation>> {
    const node = await valueGraph.getValueNode(scope, nodeId);
    if (!node.ok) return node;
    const baseline: Explanation[] = [];
    if (trace.baseline && depthLeft > 0) {
      const b = await explainInternal(scope, trace.baseline.observationId, depthLeft - 1, new Set(seen));
      if (b.ok) baseline.push(b.value);
    }
    return ok({
      observationId: `override:${trace.overrideId}`,
      metricKey: traced.metricKey,
      nodeLabel: node.value?.label ?? nodeId,
      value,
      unit: traced.unit,
      currency: traced.currency,
      observationType: 'SCENARIO',
      confidence: traced.confidence,
      derivation: null,
      source: null,
      override: trace,
      inputs: baseline,
    });
  }

  async function findObservationAnywhere(
    scope: Scope,
    observationId: string,
  ): Promise<Result<{ observation: ValueObservation | null; node: ValueNode | null }>> {
    const nodes = await valueGraph.findValueNodes(scope, { limit: 500 });
    if (!nodes.ok) return nodes;
    for (const node of nodes.value) {
      const all = await valueGraph.getObservations(scope, { nodeId: node.id, limit: 200 });
      if (!all.ok) continue;
      const found = all.value.find((o) => o.id === observationId);
      if (found) return ok({ observation: found, node });
    }
    return ok({ observation: null, node: null });
  }

  // ----------------------------------------------------------- step helper

  async function recordStep(
    scope: Scope,
    runId: string,
    sequence: number,
    calc: CalculationDefinition,
    outputNodeId: string,
    partial: Partial<Omit<CalculationStep, 'id' | 'orgId' | 'recordedAt'>> & { status: StepStatus },
    steps: CalculationStep[],
    summary: Record<StepStatus, number>,
  ): Promise<void> {
    const r = await store.appendStep(scope, {
      runId,
      sequence,
      calculationKey: calc.key,
      calculationVersion: calc.version,
      outputNodeId,
      outputMetricKey: calc.outputMetricKey,
      status: partial.status,
      outputValue: partial.outputValue ?? null,
      outputValueRaw: partial.outputValueRaw ?? null,
      outputUnit: partial.outputUnit ?? null,
      outputCurrency: partial.outputCurrency ?? null,
      outputObservationId: partial.outputObservationId ?? null,
      renderedExpression: partial.renderedExpression ?? null,
      inputs: partial.inputs ?? [],
      confidence: partial.confidence ?? null,
      inputFingerprint: partial.inputFingerprint ?? null,
      errorCode: partial.errorCode ?? null,
      errorMessage: partial.errorMessage ?? null,
    });
    if (r.ok) steps.push(r.value);
    summary[partial.status] += 1;
  }

  return ok(engine);
}

// ------------------------------------------------------------- utilities

function emptySummary(): Record<StepStatus, number> {
  return { CALCULATED: 0, UNCHANGED: 0, BLOCKED: 0, FAILED: 0, SKIPPED: 0 };
}

function asRecord(clock: Clock) {
  return clock.now().toISOString() as never;
}

/** Renders the formula with the actual numbers, for the trace. */
function renderExpression(
  calc: CalculationDefinition,
  inputs: readonly TracedInput[],
  output: Quantity,
): string {
  let rendered = calc.expression;
  for (const input of inputs) {
    const asQuantity = (v: string) =>
      formatQuantity(mustQuantity(decimal(v), input.unit, input.currency));
    // An aggregated input renders as its parts, so the trace shows where a sum
    // came from instead of restating the total it produced.
    const formatted =
      input.components && input.components.length > 1
        ? `(${input.components.map((c) => asQuantity(c.value)).join(' + ')})`
        : asQuantity(input.value);
    rendered = rendered.replaceAll(input.name, formatted);
  }
  return `${rendered} = ${formatQuantity(output)}`;
}

/**
 * Derives the observation's time context.
 *
 * The METRIC decides how a value relates to time, not the node's planning
 * horizon: working capital is a balance even when it is the balance implied by a
 * quarter's demand, and revenue is a flow even when the node is filed under
 * `current`. Getting this from the node horizon instead would write a period
 * onto a stock and the value graph would — correctly — refuse it.
 *
 * The horizon still decides HOW LONG the period is, for the metrics that have one.
 */
function periodFor(
  timeBehavior: TimeBehavior,
  node: ValueNode,
  horizon: TimeHorizon | null,
  asOf: Date,
  period: Period | null,
): { effectiveAt: ValidTime | null; periodStart: ValidTime | null; periodEnd: ValidTime | null } {
  const at = asValidTime(asOf.toISOString());
  if (timeBehavior === 'POINT_IN_TIME' || timeBehavior === 'RATE') {
    return { effectiveAt: at, periodStart: null, periodEnd: null };
  }

  // A stated period is written exactly, so the output is a claim about the
  // same interval its period inputs were held to (ADR-0020).
  if (period) {
    return {
      effectiveAt: null,
      periodStart: asValidTime(period.start),
      periodEnd: asValidTime(period.end),
    };
  }

  const h = node.timeHorizon ?? horizon;
  // A flow has to be measured over something. A node with no horizon at all
  // gives no interval to use, so the value is anchored as a point instead of
  // being given an invented one.
  if (h === null || h === 'current') {
    return { effectiveAt: at, periodStart: null, periodEnd: null };
  }
  const start = new Date(asOf);
  const end = new Date(asOf);
  if (h === 'month') end.setUTCMonth(end.getUTCMonth() + 1);
  else if (h === 'quarter') end.setUTCMonth(end.getUTCMonth() + 3);
  else if (h === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCFullYear(end.getUTCFullYear() + 10);
  return {
    effectiveAt: null,
    periodStart: asValidTime(start.toISOString()),
    periodEnd: asValidTime(end.toISOString()),
  };
}

export { chainConfidence };
