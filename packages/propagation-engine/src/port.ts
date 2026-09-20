/**
 * The PropagationEngine port and the CalculationStore it persists through.
 *
 * The engine is pure orchestration over two ports — the Phase 2 `ValueGraph`
 * and a `CalculationStore` for runs and traces — so it has one implementation
 * and works against whichever adapters those ports are given. That is why there
 * is no `InMemoryPropagationEngine` and no `PostgresPropagationEngine`.
 */

import type { EntityId, Result, Scope } from '@helm/shared';
import type { TimeHorizon } from '@helm/value-graph';
import type {
  CalculationRun,
  CalculationStep,
  Explanation,
  Freshness,
  ObservationPreference,
  PropagationPlan,
  PropagationResult,
  TriggerType,
} from './types.ts';

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
  asOf?: Date;
  horizon?: TimeHorizon | null;
  preference?: ObservationPreference;
  /** Present for a scenario run: outputs become SCENARIO observations. */
  scenarioEntityId?: EntityId | null;
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
    options?: { asOf?: Date; preference?: ObservationPreference; scenarioEntityId?: EntityId | null },
  ): Promise<Result<readonly Freshness[]>>;

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
