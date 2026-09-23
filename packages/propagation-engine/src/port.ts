/**
 * The PropagationEngine port and the CalculationStore it persists through.
 *
 * The engine is pure orchestration over two ports — the Phase 2 `ValueGraph`
 * and a `CalculationStore` for runs and traces — so it has one implementation
 * and works against whichever adapters those ports are given. That is why there
 * is no `InMemoryPropagationEngine` and no `PostgresPropagationEngine`.
 */

import type { EntityId, Period, Result, Scope } from '@helm/shared';
import type { TimeHorizon } from '@helm/value-graph';
import type {
  CalculationRun,
  CalculationStep,
  Explanation,
  Freshness,
  InputOverlay,
  ObservationPolicy,
  RunObservationPolicy,
  PropagationPlan,
  PropagationResult,
  TriggerType,
} from './types.ts';
import type { TruthLayerReading } from './selection.ts';

/** What a caller asks the engine to do. */
export type PropagationRequest = {
  /**
   * Where to start. Either explicit value nodes, or metrics that changed and
   * whose dependents should be recalculated.
   */
  fromNodeIds?: readonly string[];
  fromMetricKeys?: readonly string[];
  /** Restrict to these subject entities; omitted means every affected subject. */
  subjectEntityIds?: readonly EntityId[];
  /**
   * Business/effective time being modelled. `asOf` is accepted as a synonym for
   * backwards compatibility; prefer the explicit name.
   */
  effectiveAsOf?: Date;
  asOf?: Date;
  /**
   * Knowledge cutoff. Nothing recorded after this instant enters the run.
   * Defaults to the clock at run start, which is what makes a run's inputs
   * independent of how long the run takes.
   */
  recordedThrough?: Date;
  horizon?: TimeHorizon | null;
  preference?: RunObservationPolicy;
  /** Present for a scenario run: outputs become SCENARIO observations. */
  scenarioEntityId?: EntityId | null;
  /**
   * The business period being modelled. Period claims must be about exactly
   * this period; outputs of period metrics are written for it. Omitted, the
   * run refuses to choose between claims about different periods (ADR-0020).
   */
  period?: Period | null;
  /**
   * Scenario overrides to layer over the source world, from the scenario
   * runtime. Requires `scenarioEntityId` and `scenarioRevisionId`, and may only
   * name value nodes the run does not compute (ADR-0019).
   */
  overlay?: InputOverlay | null;
  scenarioRevisionId?: string | null;
  triggerType?: TriggerType;
  /** Plan only, write nothing. */
  dryRun?: boolean;
  maxDepth?: number;
  notes?: string | null;
};

export interface PropagationEngine {
  /** Builds the execution plan without running it. */
  planPropagation(scope: Scope, request: PropagationRequest): Promise<Result<PropagationPlan>>;

  /** Plans and executes, writing DERIVED (or SCENARIO) observations and a trace. */
  execute(scope: Scope, request: PropagationRequest): Promise<Result<PropagationResult>>;

  /** Convenience: everything downstream of one metric's change. */
  propagateFrom(
    scope: Scope,
    metricKey: string,
    options?: Omit<PropagationRequest, 'fromMetricKeys'>,
  ): Promise<Result<PropagationResult>>;

  /** Full lineage of one observation, down to source facts and assumptions. */
  explain(scope: Scope, observationId: string, maxDepth?: number): Promise<Result<Explanation>>;

  /** Whether a node's derived value still reflects its current inputs. */
  checkFreshness(
    scope: Scope,
    nodeIds: readonly string[],
    options?: {
      effectiveAsOf?: Date;
      asOf?: Date;
      recordedThrough?: Date;
      preference?: RunObservationPolicy;
      scenarioEntityId?: EntityId | null;
    },
  ): Promise<Result<readonly Freshness[]>>;

  /**
   * Business truth and model truth for one value node, side by side.
   *
   * The source side reads under a SOURCE policy and can never return a DERIVED
   * observation; the model side reads persisted DERIVED output only. Neither is
   * promoted over the other — the point is that both can be stated, with the
   * variance between them, without HELM declaring either one the truth.
   */
  truthLayers(
    scope: Scope,
    nodeId: string,
    options?: {
      effectiveAsOf?: Date;
      recordedThrough?: Date;
      sourcePolicy?: ObservationPolicy;
      period?: Period | null;
    },
  ): Promise<Result<TruthLayerReading>>;

  /** Re-executes a historical run against the observations it originally used. */
  replay(scope: Scope, runId: string): Promise<Result<PropagationResult>>;

  getRun(scope: Scope, runId: string): Promise<Result<CalculationRun | null>>;
  getTrace(scope: Scope, runId: string): Promise<Result<readonly CalculationStep[]>>;
  listRuns(scope: Scope, limit?: number): Promise<Result<readonly CalculationRun[]>>;
}

/**
 * Persistence for runs and traces. Deliberately small: the engine writes
 * observations through the ValueGraph port, so this only covers what the value
 * graph has no concept of.
 */
export interface CalculationStore {
  createRun(
    scope: Scope,
    run: Omit<CalculationRun, 'id' | 'orgId' | 'startedAt'>,
  ): Promise<Result<CalculationRun>>;
  completeRun(
    scope: Scope,
    runId: string,
    status: CalculationRun['status'],
    notes?: string | null,
  ): Promise<Result<CalculationRun>>;
  getRun(scope: Scope, runId: string): Promise<Result<CalculationRun | null>>;
  listRuns(scope: Scope, limit: number): Promise<Result<readonly CalculationRun[]>>;

  /** Append-only: a recorded step is never rewritten (§51). */
  appendStep(
    scope: Scope,
    step: Omit<CalculationStep, 'id' | 'orgId' | 'recordedAt'>,
  ): Promise<Result<CalculationStep>>;
  getSteps(scope: Scope, runId: string): Promise<Result<readonly CalculationStep[]>>;
  /** The step that produced a given observation — the entry point for explain(). */
  findStepByOutputObservation(
    scope: Scope,
    observationId: string,
  ): Promise<Result<CalculationStep | null>>;
  /** Most recent step that wrote to this node, for freshness checks. */
  findLatestStepForNode(scope: Scope, nodeId: string): Promise<Result<CalculationStep | null>>;
}

// NOTE: this port has no provenance methods, deliberately. A derived value's
// provenance is provenance OF A VALUE OBSERVATION, and the ValueGraph port
// already owns that mechanism. Giving this store its own would mean two
// provenance stores in memory and one table in Postgres — a divergence the
// conformance suite would be unable to paper over, and the exact kind of
// adapter-specific assumption ADR-0015 exists to prevent.
