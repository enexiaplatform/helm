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
  fail,
  formatQuantity,
  mustQuantity,
  ok,
  quantity,
  sumAll,
  toNumber,
  toString as decToString,
  type Clock,
  type Confidence,
  type EntityId,
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
  preferenceOrder,
  type CalculationDefinition,
  type CalculationInputSpec,
  type CalculationRun,
  type CalculationStep,
  type ComputeContext,
  type Explanation,
  type Freshness,
  type ObservationPreference,
  type PropagationPlan,
  type PropagationPlanNode,
  type ResolvedInputs,
  type StepStatus,
  type TracedInput,
} from './types.ts';
import type { CalculationRegistry } from './registry.ts';
import { buildDependencyGraph, downstreamOf, type MetricDependencyGraph } from './dependencyGraph.ts';
import type { CalculationStore, PropagationEngine, PropagationRequest } from './port.ts';

export const ENGINE_VERSION = '3.0.0';
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
   * Chooses ONE observation for an input, by declared preference then valid
   * time. Never "the latest" (§5): an actual, a forecast and a target are
   * different kinds of claim and the calculation says which it wants.
   */
  async function selectObservation(
    scope: Scope,
    nodeId: string,
    preference: ObservationPreference,
    asOf: Date,
    scenarioEntityId: EntityId | null,
  ): Promise<Result<ValueObservation | null>> {
    // A scenario run reads scenario values AND reality; a baseline run reads
    // only reality, so a scenario can never leak into a baseline number.
    const scenarioArg = preference === 'SCENARIO' ? undefined : null;
    const all = await valueGraph.getObservations(scope, {
      nodeId,
      scenarioEntityId: scenarioArg,
      limit: 200,
    });
    if (!all.ok) return all;

    const cutoff = asOf.getTime();
    const ms = (t: string): number => new Date(t).getTime();

    /**
     * Was this claim KNOWN at asOf? Record time, not the period it describes.
     * A Q4 forecast made on 18 September is available on 19 September; the
     * alternative reading — that a forecast about October cannot be used in
     * September — would make forecasting impossible.
     */
    const knownBy = (o: ValueObservation): number => ms(o.observedAt ?? o.recordedAt);

    /**
     * Which claim SPEAKS TO the latest moment. A point-in-time observation
     * anchors on `effectiveAt`, a period one on `periodStart`.
     *
     * Known limitation: two forecasts for different future periods on the same
     * node would be separated by period here, and the later one would win. The
     * horizon filter is what keeps periods apart today; genuine multi-period
     * forecasting on one node is not modelled yet.
     */
    const validAt = (o: ValueObservation): number =>
      ms(o.effectiveAt ?? o.periodStart ?? o.observedAt ?? o.recordedAt);

    for (const type of preferenceOrder[preference]) {
      let candidates = all.value.filter((o) => o.observationType === type);
      if (type === 'SCENARIO') {
        candidates = candidates.filter((o) => o.scenarioEntityId === scenarioEntityId);
      } else {
        candidates = candidates.filter((o) => o.scenarioEntityId === null);
      }
      // The model must not read what it did not yet know.
      candidates = candidates.filter((o) => knownBy(o) <= cutoff);
      // A point-in-time fact cannot describe the present if it only becomes
      // true later. Period claims are exempt: being about a period is the point.
      candidates = candidates.filter((o) => o.effectiveAt === null || ms(o.effectiveAt) <= cutoff);
      if (candidates.length === 0) continue;

      const bestValid = Math.max(...candidates.map(validAt));
      let winners = candidates.filter((o) => validAt(o) === bestValid);

      // Same kind of claim, same valid time: the more recently RECORDED belief
      // supersedes. That is what record time is for, and it is the rule a
      // recalculated derived value relies on — not an arbitrary pick.
      if (winners.length > 1) {
        const bestRecord = Math.max(...winners.map((o) => ms(o.recordedAt)));
        winners = winners.filter((o) => ms(o.recordedAt) === bestRecord);
      }

      if (winners.length > 1) {
        // Identical in valid time AND record time. Nothing distinguishes them,
        // so choosing would make the result unexplainable.
        return fail(
          CalculationErrors.AMBIGUOUS_INPUT,
          `Value node ${nodeId} has ${winners.length} ${type} observations with the same ` +
            'valid time and the same record time. HELM will not pick one arbitrarily.',
          { nodeId, observationType: type, candidates: winners.map((w) => w.id) },
        );
      }
      return ok(winners[0]);
    }
    return ok(null);
  }

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

  /** Resolves one declared input to a unit-checked quantity plus its trace row. */
  async function resolveInput(
    scope: Scope,
    spec: CalculationInputSpec,
    outputNode: ValueNode,
    preference: ObservationPreference,
    asOf: Date,
    horizon: TimeHorizon | null,
    scenarioEntityId: EntityId | null,
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

    const effectivePreference = spec.preference ?? preference;
    const picked: { node: ValueNode; obs: ValueObservation }[] = [];
    for (const node of usable) {
      const obs = await selectObservation(
        scope,
        node.id,
        effectivePreference,
        asOf,
        scenarioEntityId,
      );
      if (!obs.ok) return obs;
      if (obs.value) picked.push({ node, obs: obs.value });
    }

    if (picked.length === 0) {
      if (!spec.required) return ok(null);
      return fail(
        CalculationErrors.MISSING_INPUT,
        `"${spec.metricKey}" has a value node but no usable observation under the ` +
          `${effectivePreference} preference at ${asOf.toISOString()}. ` +
          `The model needs ${spec.description.toLowerCase()}`,
        { metricKey: spec.metricKey, preference: effectivePreference },
      );
    }

    const first = picked[0].obs;

    // Unit validation before compute() ever sees the value.
    if (first.unitType !== spec.expectUnit) {
      return fail(
        CalculationErrors.UNIT_MISMATCH,
        `Input "${spec.name}" expects ${spec.expectUnit} but "${spec.metricKey}" observations ` +
          `are in ${first.unitType}.`,
        { expected: spec.expectUnit, received: first.unitType },
      );
    }
    for (const p of picked) {
      if (p.obs.unitType !== first.unitType || p.obs.currency !== first.currency) {
        return fail(
          CalculationErrors.CURRENCY_MISMATCH,
          `Aggregated "${spec.metricKey}" observations mix units or currencies.`,
        );
      }
    }

    const total = sumAll(picked.map((p) => decimal(p.obs.numericValue ?? 0)));
    const q = quantity(total, spec.expectUnit, first.currency);
    if (!q.ok) return q;

    const confidences = picked.map((p) => p.obs.confidence).filter((c): c is number => c !== null);

    return ok({
      quantity: q.value,
      traced: {
        name: spec.name,
        metricKey: spec.metricKey,
        nodeId: picked.map((p) => p.node.id).join('+'),
        observationId: picked.map((p) => p.obs.id).join('+'),
        observationType: first.observationType,
        value: decToString(total),
        unit: spec.expectUnit,
        currency: first.currency,
        confidence: confidences.length > 0 ? Math.min(...confidences) : null,
        sourceSystem: first.sourceSystem,
        effectiveAt: first.effectiveAt ?? first.periodStart ?? null,
        // Only when more than one claim was summed: for a single input the
        // components would restate the value and add nothing.
        components:
          picked.length > 1
            ? picked.map((p) => ({
                nodeId: p.node.id,
                observationId: p.obs.id,
                value: decToString(decimal(p.obs.numericValue ?? 0)),
                observationType: p.obs.observationType,
              }))
            : undefined,
      },
    });
  }

  // ------------------------------------------------------------ fingerprint

  /**
   * Deterministic fingerprint of (calculation version + input observations +
   * context). Identical fingerprints mean an identical computation, which is
   * what makes idempotency and staleness checkable without re-running (§27).
   *
   * FNV-1a over a canonical string: no crypto dependency, and collisions are
   * not a security concern here — this identifies recomputation, not identity.
   */
  function fingerprint(
    calc: CalculationDefinition,
    inputs: readonly TracedInput[],
    ctx: { horizon: string; scenario: string },
  ): string {
    const canonical = [
      calculationRef(calc),
      ctx.horizon,
      ctx.scenario,
      ...[...inputs]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((i) => `${i.name}=${i.observationId}:${i.value}${i.unit}${i.currency ?? ''}`),
    ].join('|');

    let hash = 0x811c9dc5;
    for (let i = 0; i < canonical.length; i += 1) {
      hash ^= canonical.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fp_${hash.toString(16).padStart(8, '0')}_${canonical.length}`;
  }

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

    const horizon = request.horizon === undefined ? 'quarter' : request.horizon;

    // For each affected metric, find the value nodes that should carry it.
    const planNodes: PropagationPlanNode[] = [];
    const uncomputable: { nodeId: string; metricKey: string; reason: string }[] = [];
    let order = 0;

    for (const metricKey of targetMetrics) {
      const calc = registry.findByOutputMetric(metricKey)[0];
      if (!calc) continue;

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

        // Scope compatibility (§31).
        if (calc.scopeCompatibility && node.subjectEntityId) {
          const entity = await graphStore.getEntity(scope, node.subjectEntityId);
          if (!entity.ok) return entity;
          if (entity.value) {
            const category = ontology.categoryOf(entity.value.entityTypeKey);
            if (category && !calc.scopeCompatibility.includes(category)) {
              uncomputable.push({
                nodeId: node.id,
                metricKey,
                reason:
                  `${calculationRef(calc)} does not apply to a ${category} subject ` +
                  `(allowed: ${calc.scopeCompatibility.join(', ')})`,
              });
              continue;
            }
          }
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
      const asOf = request.asOf ?? clock.now();
      const preference: ObservationPreference =
        request.preference ?? (request.scenarioEntityId ? 'SCENARIO' : 'BASELINE');
      const scenarioEntityId = request.scenarioEntityId ?? null;

      const built = await buildPlan(scope, request);
      if (!built.ok) return built;
      const { plan, horizon } = built.value;

      const runInput: Omit<CalculationRun, 'id' | 'orgId' | 'startedAt'> = {
        status: 'RUNNING',
        triggerType: request.triggerType ?? 'MANUAL',
        context: {
          asOf: asOf.toISOString(),
          horizon,
          preference,
          scenarioEntityId,
          rootNodeIds: request.fromNodeIds ?? [],
          engineVersion: ENGINE_VERSION,
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
            preference,
            asOf,
            horizon,
            scenarioEntityId,
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

        const fp = fingerprint(calc, traced, {
          horizon: horizon ?? '',
          scenario: scenarioEntityId ?? '',
        });

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
          continue;
        }

        // --- compute ---
        const computeCtx: ComputeContext = {
          scope,
          asOf,
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
        const rendered = renderExpression(calc, traced, output.value);

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
        const period = periodFor(metric.value.timeBehavior, node.value, horizon, asOf);

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
          observedAt: asValidTime(asOf.toISOString()),
        });
        if (!provenance.ok) return provenance;

        const obs = await valueGraph.recordObservation(scope, {
          nodeId: node.value.id,
          observationType,
          numericValue: toNumber(output.value.amount),
          unitType: output.value.unit,
          currency: output.value.currency,
          effectiveAt: period.effectiveAt,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          observedAt: asValidTime(asOf.toISOString()),
          scenarioEntityId,
          confidence,
          sourceSystem: 'helm',
          provenanceId: provenance.value.id,
          metadata: {
            derivedByCalculation: calculationRef(calc),
            calculationRunId: run.id,
            inputFingerprint: fp,
            exactValue: decToString(output.value.amount),
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
        await recordStep(scope, run.id, sequence, calc, node.value.id, {
          status: 'CALCULATED',
          inputs: traced,
          outputValue: decToString(output.value.amount),
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
      const asOf = options.asOf ?? clock.now();
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
        const preference: ObservationPreference =
          options.preference ?? run.value?.context.preference ?? 'BASELINE';
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
            asOf,
            contextHorizon,
            scenarioEntityId,
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

        const current = fingerprint(calc, traced, {
          horizon: runHorizon,
          scenario: scenarioEntityId ?? '',
        });
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
      // Replay re-executes against the SAME context, so the same observations
      // are selected and the same numbers come out (§59).
      const ctx = original.value.context;
      return engine.execute(scope, {
        fromNodeIds: ctx.rootNodeIds,
        asOf: new Date(ctx.asOf),
        horizon: ctx.horizon,
        preference: ctx.preference,
        scenarioEntityId: ctx.scenarioEntityId,
        triggerType: 'REPLAY',
        notes: `replay of ${runId}`,
      });
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
        for (const id of traced.observationId.split('+')) {
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
): { effectiveAt: ValidTime | null; periodStart: ValidTime | null; periodEnd: ValidTime | null } {
  const at = asValidTime(asOf.toISOString());
  if (timeBehavior === 'POINT_IN_TIME' || timeBehavior === 'RATE') {
    return { effectiveAt: at, periodStart: null, periodEnd: null };
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
