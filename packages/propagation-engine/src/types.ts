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
 * THE THREE TRUTH LAYERS
 *
 * HELM holds three different kinds of number and must never conflate them.
 *
 *   BUSINESS / SOURCE TRUTH   ACTUAL, FORECAST, TARGET, ASSUMPTION.
 *                             Claims made by a business system or an authorized
 *                             person. Finance's Q4 forecast is source truth
 *                             whether or not HELM agrees with it.
 *
 *   MODEL TRUTH               DERIVED. What a HELM model computed, under a named
 *                             calculation version and a recorded context. It is
 *                             explainable output. It is NOT automatically the
 *                             authoritative business number, and a model result
 *                             must never silently displace what Finance said.
 *
 *   EXECUTION STATE           Values bound to a run that is currently executing.
 *                             Not a third persistent category — runtime bindings
 *                             that exist so one execution is internally
 *                             consistent. They live in `RunOutputs`, never in the
 *                             observation store.
 *
 * The policies below select from the PERSISTENT world, which is layers one and
 * two. No policy that answers "what does the business say?" may return DERIVED,
 * because that would make a historical HELM calculation authoritative merely by
 * virtue of its observation type.
 */
export const observationPolicies = [
  'SOURCE_TRUTH',
  'ACTUALS_FIRST',
  'SCENARIO',
  'ASSUMPTION_ONLY',
  'MODEL_OUTPUT',
] as const;
export type ObservationPolicy = (typeof observationPolicies)[number];

/** Policies a RUN may declare. `MODEL_OUTPUT` is per-input only (see below). */
export const runObservationPolicies = [
  'SOURCE_TRUTH',
  'ACTUALS_FIRST',
  'SCENARIO',
  'ASSUMPTION_ONLY',
] as const;
export type RunObservationPolicy = (typeof runObservationPolicies)[number];

/**
 * Ordering within each policy.
 *
 * Note what is absent: DERIVED does not appear in SOURCE_TRUTH, ACTUALS_FIRST or
 * SCENARIO. An earlier version put DERIVED first in the baseline policy so that
 * chained calculations would see each other's output. That was the wrong fix for
 * a real problem — it made every historical model result outrank the forecast a
 * human actually committed to, so Finance's 5.00B and HELM's 4.70B could not
 * coexist and the variance between them was unstateable.
 *
 * Chaining is now an EXECUTION concern, handled by `InputResolution` below, not
 * by promoting a whole observation type.
 */
export const policyOrder: Record<ObservationPolicy, readonly ObservationType[]> = {
  SOURCE_TRUTH: ['FORECAST', 'ACTUAL', 'ESTIMATE', 'ASSUMPTION'],
  ACTUALS_FIRST: ['ACTUAL', 'FORECAST', 'ESTIMATE', 'ASSUMPTION'],
  SCENARIO: ['SCENARIO', 'FORECAST', 'ACTUAL', 'ESTIMATE', 'ASSUMPTION'],
  ASSUMPTION_ONLY: ['ASSUMPTION'],
  // Persisted model truth, asked for explicitly.
  MODEL_OUTPUT: ['DERIVED'],
};

/**
 * Where an input's value comes from. This is the distinction between reading the
 * world and reading the model.
 *
 *   SOURCE_POLICY_ONLY      Always the persistent observation world, under the
 *                           declared policy. For measurements and commitments
 *                           that must remain source truth — available inventory,
 *                           unit cost, a finance forecast.
 *
 *   RUN_OUTPUT_IF_PLANNED   If the current execution plan produces this metric
 *                           for this node, consume THAT output — the execution
 *                           frame's value, not whichever DERIVED observation is
 *                           newest. Otherwise fall back to persisted model truth,
 *                           and then to the source world.
 *                           For executable value-model dependencies:
 *                           Expected Revenue -> Demand Quantity.
 */
export const inputResolutions = ['SOURCE_POLICY_ONLY', 'RUN_OUTPUT_IF_PLANNED'] as const;
export type InputResolution = (typeof inputResolutions)[number];

/**
 * Fallback order for an executable dependency whose upstream was NOT planned.
 * Persisted model truth first — the input has explicitly said it wants the
 * model — then the source world, so a gap degrades to what the business says
 * rather than to nothing.
 */
export const unplannedDependencyOrder: readonly ObservationType[] = [
  'DERIVED',
  'FORECAST',
  'ACTUAL',
  'ESTIMATE',
  'ASSUMPTION',
];

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
  /**
   * Where this input comes from. Defaults to SOURCE_POLICY_ONLY: reading the
   * world is the safe default, and an executable dependency has to say so.
   */
  resolution?: InputResolution;
  /** Overrides the run's policy — e.g. an assumption must stay an assumption. */
  preference?: ObservationPolicy;
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

/**
 * The two independent lenses a run looks through (§6-§8 of the hardening brief).
 *
 *   effectiveAsOf     What business time are we modelling? Governs valid time:
 *                     a point-in-time claim effective after this instant is not
 *                     about the world we are modelling.
 *
 *   recordedThrough   What was HELM allowed to KNOW when this run began? Governs
 *                     record time. An observation recorded after this cutoff must
 *                     not enter the run even if its effective time qualifies.
 *
 * They must not be collapsed. A Q4 forecast that Finance files at 20:16 is valid
 * for the period a 20:15 run is modelling, and that run still must not see it —
 * otherwise a run's inputs depend on how long the run took, and nothing is
 * reproducible. A later run sees it, which is correct.
 *
 * This gives a deterministic knowledge boundary without holding a database
 * transaction open across the whole propagation.
 */
export type CalculationRunContext = {
  /** Business/effective time being modelled. */
  effectiveAsOf: string;
  /** Knowledge cutoff: nothing recorded after this instant enters the run. */
  recordedThrough: string;
  horizon: TimeHorizon | null;
  preference: RunObservationPolicy;
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
   * Which layer this value came from — the execution frame of the current run,
   * or the persistent observation world. A reader auditing a trace has to be
   * able to tell "the number my run computed one step earlier" from "what the
   * business had on file".
   */
  boundTo?: 'RUN_OUTPUT' | 'SOURCE_OBSERVATION';
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
  /**
   * The BUSINESS-NORMALIZED value that was written down — what the observation
   * holds, at the metric's storage precision.
   */
  outputValue: string | null;
  /**
   * The raw computation before business normalization, at full internal
   * precision. Kept so a reader can see that 2 687 700 000 is a rounding of
   * 2 687 699 999.9999999999999999999969 rather than a number HELM invented.
   * Null when it is identical to `outputValue`.
   */
  outputValueRaw: string | null;
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
