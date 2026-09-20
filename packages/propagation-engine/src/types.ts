/**
 * Propagation engine types — the executable layer over the Phase 2 value graph.
 *
 * The distinction that organises this file (§29–30 of the phase brief):
 *
 *   Value Graph        = SEMANTIC dependency.  "Inventory CONSUMES Working Capital."
 *   Calculation Graph  = EXECUTABLE dependency. "WorkingCapital = InventoryRequirement × UnitCost."
 *
 * They overlap but are not the same. A value link can exist with no calculation
 * behind it (a real dependency HELM cannot yet compute), and a calculation can
 * span nodes that no single value link connects. The engine executes the
 * calculation graph; the value graph remains the semantic model.
 */

import type {
  Confidence,
  EntityId,
  OrgId,
  Quantity,
  QuantityUnit,
  RecordTime,
  Result,
  Scope,
  UserId,
  ValidTime,
} from '@helm/shared';
import type { ObservationType, TimeHorizon, ValueObservation } from '@helm/value-graph';

// ------------------------------------------------------- error taxonomy

export const CalculationErrors = {
  MISSING_INPUT: 'calculation.missing_input',
  AMBIGUOUS_INPUT: 'calculation.ambiguous_input',
  UNIT_MISMATCH: 'calculation.unit_mismatch',
  CURRENCY_MISMATCH: 'calculation.currency_mismatch',
  FX_RATE_REQUIRED: 'calculation.fx_rate_required',
  TIME_CONTEXT_MISMATCH: 'calculation.time_context_mismatch',
  CYCLE_DETECTED: 'calculation.cycle_detected',
  CALCULATION_NOT_FOUND: 'calculation.not_found',
  DUPLICATE_CALCULATION: 'calculation.duplicate',
  UNKNOWN_METRIC: 'calculation.unknown_metric',
  UNDECLARED_DEPENDENCY: 'calculation.undeclared_dependency',
  STALE_INPUT: 'calculation.stale_input',
  INVALID_ASSUMPTION: 'calculation.invalid_assumption',
  SCOPE_INCOMPATIBLE: 'calculation.scope_incompatible',
  NODE_NOT_FOUND: 'calculation.node_not_found',
  CALCULATION_FAILED: 'calculation.failed',
  INVALID_VERSION: 'calculation.invalid_version',
  DEPTH_EXCEEDED: 'calculation.depth_exceeded',
  WRITE_FAILED: 'calculation.write_failed',
  READ_FAILED: 'calculation.read_failed',
} as const;

// -------------------------------------------------- observation selection

/**
 * Which kind of claim a calculation should prefer as an input (ADR-0017 §2).
 * TARGET is never selectable: a target is what we want, not what we believe.
 */
export const observationPreferences = [
  'BASELINE',
  'ACTUALS_FIRST',
  'SCENARIO',
  'ASSUMPTION_ONLY',
] as const;
export type ObservationPreference = (typeof observationPreferences)[number];

/**
 * DERIVED comes before FORECAST in every policy that admits both, and the
 * reason is the whole point of this phase: if HELM can compute a number, the
 * computed one is the baseline, because it is the only one that can be
 * explained. A stated forecast is the fallback for what HELM cannot compute.
 * ACTUALS_FIRST still puts a measurement ahead of a model, which is right — a
 * model that overrode what actually happened would be worse than useless.
 */
export const preferenceOrder: Record<ObservationPreference, readonly ObservationType[]> = {
  BASELINE: ['DERIVED', 'FORECAST', 'ACTUAL', 'ESTIMATE', 'ASSUMPTION'],
  ACTUALS_FIRST: ['ACTUAL', 'DERIVED', 'FORECAST', 'ESTIMATE', 'ASSUMPTION'],
  SCENARIO: ['SCENARIO', 'DERIVED', 'FORECAST', 'ACTUAL', 'ESTIMATE', 'ASSUMPTION'],
  ASSUMPTION_ONLY: ['ASSUMPTION'],
};

// ----------------------------------------------------------- input binding

/**
 * How the engine locates the value node that supplies an input.
 *
 * This is where the calculation graph meets the ontology: an input on a
 * different entity is found by walking a named relationship, not by guessing.
 */
export type InputBinding =
  /** The input node is about the same entity as the output node. */
  | { kind: 'SAME_SUBJECT' }
  /**
   * The input node is about an entity related to the output's subject.
   * e.g. DemandQuantity on an Opportunity needs the price of the Product it SELLS.
   */
  | {
      kind: 'RELATED_ENTITY';
      relationshipTypeKey: string;
      direction: 'out' | 'in';
      /** Narrows the related entity by an attribute, e.g. ownership = 'own'. */
      subjectFilter?: { attribute: string; equals: string | number | boolean };
      /** Several matches are summed rather than being an error. */
      aggregate?: boolean;
    }
  /** A node at an explicit organizational scope, e.g. an enterprise assumption. */
  | { kind: 'SCOPED'; scopeKind: string; scopeRef?: string };

export type CalculationInputSpec = {
  /** Local name the implementation uses. */
  name: string;
  metricKey: string;
  binding: InputBinding;
  required: boolean;
  /** Unit the implementation expects. Validated before `compute` runs. */
  expectUnit: QuantityUnit;
  /** Overrides the run's preference — e.g. an assumption must stay an assumption. */
  preference?: ObservationPreference;
  /** Horizon the input must carry. Defaults to the output node's horizon. */
  horizon?: TimeHorizon;
  /**
   * Accept an input from a different period rather than failing. Off by
   * default: §32 says reject ambiguous cross-period inputs rather than guess.
   */
  allowCrossPeriod?: boolean;
  description: string;
};

// ------------------------------------------------------ calculation object

export const calculationStatuses = ['DRAFT', 'ACTIVE', 'DEPRECATED', 'RETIRED'] as const;
export type CalculationStatus = (typeof calculationStatuses)[number];

/** Which entity-type categories a calculation may produce output for. */
export type ScopeCompatibility = readonly string[] | null;

export type ResolvedInputs = Readonly<Record<string, Quantity>>;

export type ComputeContext = {
  scope: Scope;
  asOf: Date;
  horizon: TimeHorizon | null;
  /** The entity the output is about, for calculations that need to branch. */
  subjectEntityId: EntityId | null;
};

export type CalculationDefinition = {
  key: string;
  /** Semantic version. A meaning change is a new version, never an edit. */
  version: string;
  name: string;
  description: string;
  /** Why this calculation exists, in business terms. Not optional (§63). */
  rationale: string;
  owner: string;
  status: CalculationStatus;
  effectiveFrom: string;

  outputMetricKey: string;
  outputUnit: QuantityUnit;
  inputs: readonly CalculationInputSpec[];
  scopeCompatibility: ScopeCompatibility;

  /**
   * How well the MODEL represents reality, independent of input quality.
   * `inventory_requirement@1.0.0` is demand with no stock policy at all, so it
   * declares less than 1 — the arithmetic is exact, the model is crude.
   */
  definitionConfidence: Confidence;

  /** Human-readable formula, shown in traces. Never evaluated. */
  expression: string;

  /** Pure. Same inputs and context always give the same result. */
  compute(ctx: ComputeContext, inputs: ResolvedInputs): Result<Quantity>;

  metadata?: Readonly<Record<string, unknown>>;
};

/** `key@version` — how a calculation is referenced in traces and runs. */
export const calculationRef = (d: Pick<CalculationDefinition, 'key' | 'version'>): string =>
  `${d.key}@${d.version}`;

// ---------------------------------------------------------- run and trace

export const triggerTypes = [
  'MANUAL',
  'SOURCE_CHANGE',
  'SCENARIO',
  'SYSTEM',
  'REPLAY',
] as const;
export type TriggerType = (typeof triggerTypes)[number];

export const runStatuses = ['RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'] as const;
export type RunStatus = (typeof runStatuses)[number];

/** Per-node execution outcome (§49). */
export const stepStatuses = [
  'CALCULATED',
  'UNCHANGED',
  'BLOCKED',
  'FAILED',
  'SKIPPED',
] as const;
export type StepStatus = (typeof stepStatuses)[number];

export type CalculationRunContext = {
  asOf: string;
  horizon: TimeHorizon | null;
  preference: ObservationPreference;
  scenarioEntityId: EntityId | null;
  /** Value node ids the propagation started from. */
  rootNodeIds: readonly string[];
  engineVersion: string;
};

export type CalculationRun = {
  id: string;
  orgId: OrgId;
  status: RunStatus;
  triggerType: TriggerType;
  context: CalculationRunContext;
  startedAt: RecordTime;
  completedAt: RecordTime | null;
  /** Set when this run replays an earlier one. */
  replayOfRunId: string | null;
  notes: string | null;
  createdBy: UserId | null;
};

/** One input as it was actually used, for the trace. */
export type TracedInput = {
  name: string;
  metricKey: string;
  nodeId: string;
  observationId: string;
  observationType: ObservationType;
  /** Exact decimal string — never a float. */
  value: string;
  unit: QuantityUnit;
  currency: string | null;
  confidence: Confidence | null;
  sourceSystem: string;
  effectiveAt: ValidTime | null;
  /**
   * For an AGGREGATED input, the individual claims that were summed.
   *
   * Without this the trace of a summed input reads `Σ 12.385714285714 =
   * 12.385714285714`, which is true and useless: a reader cannot see that the
   * total is one tender's 8.4 units plus another's 3.985714285714, which is the
   * only interesting thing about it. Absent for a single-observation input.
   */
  components?: readonly {
    nodeId: string;
    observationId: string;
    value: string;
    observationType: ObservationType;
  }[];
};

/**
 * One calculation execution within a run. This IS the trace: it records what
 * was computed, from which exact observations, by which formula version.
 * Append-only.
 */
export type CalculationStep = {
  id: string;
  orgId: OrgId;
  runId: string;
  /** Deterministic execution order within the run. */
  sequence: number;
  calculationKey: string;
  calculationVersion: string;
  outputNodeId: string;
  outputMetricKey: string;
  status: StepStatus;
  /** Exact decimal string of the computed value, when status is CALCULATED. */
  outputValue: string | null;
  outputUnit: QuantityUnit | null;
  outputCurrency: string | null;
  outputObservationId: string | null;
  /** The formula rendered with the actual numbers. */
  renderedExpression: string | null;
  inputs: readonly TracedInput[];
  confidence: Confidence | null;
  /**
   * Deterministic hash of (calculation version + horizon + scenario + the exact
   * input observations and their values). Equal fingerprints mean an identical
   * computation (§27).
   *
   * `asOf` is deliberately NOT part of it. `asOf` is the lens that selected the
   * inputs, not an input: if the same observations with the same values were
   * used, the computation was the same, and a freshness check an hour later must
   * not report a value as stale merely because the clock moved.
   */
  inputFingerprint: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  recordedAt: RecordTime;
};

// ------------------------------------------------------------- execution

export type PropagationPlanNode = {
  calculation: CalculationDefinition;
  outputNodeId: string;
  /** Topological depth: 0 executes first. */
  order: number;
  /** Output node ids this step depends on within the plan. */
  dependsOn: readonly string[];
};

export type PropagationPlan = {
  nodes: readonly PropagationPlanNode[];
  /** Nodes reached but with no calculation available — a real gap in the model. */
  uncomputable: readonly { nodeId: string; metricKey: string; reason: string }[];
};

export type PropagationResult = {
  run: CalculationRun;
  steps: readonly CalculationStep[];
  /** Observations written by this run. */
  written: readonly ValueObservation[];
  summary: Record<StepStatus, number>;
  /**
   * Value positions the run deliberately did NOT attempt, each with a reason.
   *
   * Carried on the result and not only on the plan, because a reader looking at
   * what a run did must be able to tell "the model does not claim to compute
   * this" from "the model forgot". A silent absence reads as the second.
   */
  uncomputable: readonly { nodeId: string; metricKey: string; reason: string }[];
};

/** One line of `explain()` — recursive to the source facts. */
export type Explanation = {
  observationId: string;
  metricKey: string;
  nodeLabel: string;
  value: string;
  unit: QuantityUnit;
  currency: string | null;
  observationType: ObservationType;
  confidence: Confidence | null;
  /** Present when the value was calculated; absent for source facts. */
  derivation: {
    calculationKey: string;
    calculationVersion: string;
    expression: string;
    renderedExpression: string | null;
    runId: string;
    recordedAt: RecordTime;
  } | null;
  /** Where a source fact came from. */
  source: {
    system: string;
    method: string | null;
    sourceObjectType: string | null;
    sourceObjectId: string | null;
    observedAt: ValidTime | null;
  } | null;
  /** Recursive: each input explained in turn, down to source facts. */
  inputs: readonly Explanation[];
};

// -------------------------------------------------------------- staleness

export const freshnessStates = ['CLEAN', 'STALE', 'UNKNOWN'] as const;
export type FreshnessState = (typeof freshnessStates)[number];

/**
 * Whether a derived observation still reflects its inputs (§25).
 *
 * Computed by re-resolving the inputs and comparing fingerprints — nothing is
 * mutated, so an old derived value stays exactly as it was recorded and simply
 * becomes known-stale.
 */
export type Freshness = {
  nodeId: string;
  observationId: string | null;
  state: FreshnessState;
  recordedFingerprint: string | null;
  currentFingerprint: string | null;
  reason: string;
};
