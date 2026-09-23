/**
 * Scenario Runtime types — branching future states (ADR-0019).
 *
 * TERMINOLOGY, used consistently everywhere below and in the docs:
 *
 *   Scenario      A defined hypothetical: a named set of changes to the enterprise
 *                 model, forked from a baseline. The concept, with an identity
 *                 and a lifecycle. Never a copy of the enterprise state.
 *   Revision      One specific, immutable-once-sealed set of those changes, with
 *                 the fork point it applies to. Editing a sealed revision creates
 *                 a new one; history is never rewritten.
 *   Override      One explicit change: "Available Inventory = 12 units", with its
 *                 author, rationale, confidence and provenance.
 *   Simulation    Executing the enterprise model under a revision — one
 *                 propagation-engine run per modelled period. Recorded as a
 *                 ScenarioRun.
 *   Future State  The calculated management/value state a simulation produced —
 *                 a VIEW over value-graph observations and calculation traces,
 *                 not a second state model.
 *   Comparison    The differences between future states, shown as deltas per
 *                 metric and dimension. Never a ranking, a score or a choice.
 *
 * The baseline is a modelled state too — the same run record, the same future
 * state view — distinguished only by carrying no scenario and no overrides. It
 * never writes a fake scenario observation.
 */

import type {
  Confidence,
  EntityId,
  OrgId,
  Period,
  QuantityUnit,
  UserId,
} from '@helm/shared';
import type {
  Explanation,
  OverrideOperation,
  RunObservationPolicy,
} from '@helm/propagation-engine';
import type { Directionality, ValueDimension } from '@helm/value-graph';

// ------------------------------------------------------------------ errors

export const ScenarioErrors = {
  NOT_FOUND: 'scenario.not_found',
  DUPLICATE_KEY: 'scenario.duplicate_key',
  INVALID_INPUT: 'scenario.invalid_input',
  INVALID_TRANSITION: 'scenario.invalid_transition',
  REVISION_SEALED: 'scenario.revision_sealed',
  DRAFT_EXISTS: 'scenario.draft_exists',
  INHERITANCE_TOO_DEEP: 'scenario.inheritance_too_deep',
  PARENT_NOT_SEALED: 'scenario.parent_not_sealed',
  OVERRIDE_INVALID: 'scenario.override_invalid',
  OVERRIDE_DUPLICATE: 'scenario.override_duplicate',
  OVERRIDE_TARGETS_COMPUTED_NODE: 'scenario.override_targets_computed_node',
  STRUCTURAL_OVERRIDE_DEFERRED: 'scenario.structural_override_deferred',
  PERIOD_NOT_IN_REVISION: 'scenario.period_not_in_revision',
  VALIDATION_FAILED: 'scenario.validation_failed',
  EXECUTION_FAILED: 'scenario.execution_failed',
  NOT_EXECUTABLE: 'scenario.not_executable',
  WRITE_FAILED: 'scenario.write_failed',
  READ_FAILED: 'scenario.read_failed',
  IMMUTABLE: 'scenario.immutable',
} as const;

// --------------------------------------------------------------- lifecycle

/**
 * An analytical lifecycle — deliberately NOT the decision lifecycle. Nothing
 * here is proposed, approved or committed; a computed scenario is a set of
 * consequences, not a choice.
 *
 *   DRAFT        its latest revision is still being edited
 *   READY        its latest revision is sealed and valid, not yet executed
 *   RUNNING      a simulation of its latest revision is in progress
 *   COMPUTED     its latest revision has a completed simulation
 *   ARCHIVED     retired from active analysis; history stays readable (terminal)
 *   INVALIDATED  can no longer be executed as defined — e.g. it names a model
 *                version that has been retired; history stays readable (terminal)
 */
export const scenarioStatuses = [
  'DRAFT',
  'READY',
  'RUNNING',
  'COMPUTED',
  'ARCHIVED',
  'INVALIDATED',
] as const;
export type ScenarioStatus = (typeof scenarioStatuses)[number];

/** Allowed transitions. ARCHIVED and INVALIDATED are terminal. */
export const scenarioTransitions: Readonly<Record<ScenarioStatus, readonly ScenarioStatus[]>> = {
  DRAFT: ['READY', 'RUNNING', 'ARCHIVED', 'INVALIDATED'],
  READY: ['DRAFT', 'RUNNING', 'ARCHIVED', 'INVALIDATED'],
  RUNNING: ['COMPUTED', 'READY', 'INVALIDATED'],
  COMPUTED: ['DRAFT', 'READY', 'RUNNING', 'ARCHIVED', 'INVALIDATED'],
  ARCHIVED: [],
  INVALIDATED: [],
};

export const revisionStates = ['DRAFT', 'SEALED'] as const;
export type RevisionState = (typeof revisionStates)[number];

/** Why a revision exists. REBASED = same overrides, new baseline boundary. */
export const revisionReasons = ['CREATED', 'EDITED', 'REBASED'] as const;
export type RevisionReason = (typeof revisionReasons)[number];

// --------------------------------------------------------------- the fork

/**
 * Where a scenario branches from the enterprise model: the baseline as it was
 * known at this business/knowledge boundary. Pinned when the revision is
 * created, so a scenario created on 21 Sep keeps its 21 Sep knowledge when it
 * is recalculated on 25 Sep. Only an explicit REBASE moves it.
 */
export type ForkPoint = {
  /** Business time the baseline is taken at (point-in-time facts "as of"). */
  readonly effectiveAsOf: string;
  /** Knowledge boundary: nothing recorded after this enters any simulation. */
  readonly recordedThrough: string;
  /** Source policy the baseline world is read under. Never SCENARIO. */
  readonly policy: Exclude<RunObservationPolicy, 'SCENARIO'>;
};

/** At most this many ancestors above a scenario: parent and grandparent. */
export const MAX_INHERITANCE_DEPTH = 2;

// --------------------------------------------------------------- scenario

export type Scenario = {
  readonly id: string;
  readonly orgId: OrgId;
  /** Stable, human-readable, unique per organization: "expedite". */
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** The scenario this one inherits overrides from, if any. */
  readonly parentScenarioId: string | null;
  /**
   * The ontology Scenario entity its outputs are tagged with. Value-graph
   * observations name a scenario by entity, which is what isolates one
   * scenario's outputs from reality and from every other scenario.
   */
  readonly scenarioEntityId: EntityId;
  readonly status: ScenarioStatus;
  readonly statusReason: string | null;
  readonly createdBy: UserId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
};

export type ScenarioRevision = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly scenarioId: string;
  readonly revisionNumber: number;
  readonly state: RevisionState;
  readonly reason: RevisionReason;
  /** The revision this one was edited or rebased from. */
  readonly basedOnRevisionId: string | null;
  /**
   * The parent scenario's revision this one inherits from — PINNED, so editing
   * the parent later never silently changes a child's future.
   */
  readonly parentRevisionId: string | null;
  readonly fork: ForkPoint;
  /** The business periods simulated, in order. At least one. */
  readonly periods: readonly Period[];
  /** Model identity, fixed at sealing: engine version and calculation refs. */
  readonly modelRef: ModelRef | null;
  /** Deterministic fingerprint, fixed at sealing (see fingerprint.ts). */
  readonly fingerprint: string | null;
  readonly notes: string | null;
  readonly createdBy: UserId | null;
  readonly createdAt: string;
  readonly sealedAt: string | null;
};

export type ModelRef = {
  readonly engineVersion: string;
  /** Sorted `key@version` of every calculation the model registers. */
  readonly calculations: readonly string[];
};

// --------------------------------------------------------------- overrides

/**
 *   VALUE_OVERRIDE       "what if this fact were different" — probability = 0.9
 *   ASSUMPTION_OVERRIDE  a different management assumption — lead time = 7 days
 *   STRUCTURAL_OVERRIDE  a change to the model's structure — Supplier B becomes
 *                        available. The interface is defined; execution is
 *                        DEFERRED and the runtime refuses it rather than
 *                        pretending (ADR-0019 §8).
 */
export const overrideTypes = ['VALUE_OVERRIDE', 'ASSUMPTION_OVERRIDE', 'STRUCTURAL_OVERRIDE'] as const;
export type OverrideType = (typeof overrideTypes)[number];

/** Where an override came from. Not every scenario value is HELM's invention. */
export const overrideProvenanceKinds = [
  'MANAGEMENT_ASSUMPTION',
  'MODEL_ASSUMPTION',
  'USER_OVERRIDE',
  'SYSTEM_GENERATED',
  'EXTERNAL_SIGNAL',
] as const;
export type OverrideProvenanceKind = (typeof overrideProvenanceKinds)[number];

/** The shape a structural change will take. Accepted by no execution path yet. */
export type StructuralChange =
  | { kind: 'ADD_RELATIONSHIP'; relationshipTypeKey: string; fromEntityId: EntityId; toEntityId: EntityId }
  | { kind: 'REMOVE_RELATIONSHIP'; relationshipId: string }
  | { kind: 'SUBSTITUTE_ENTITY'; replaceEntityId: EntityId; withEntityId: EntityId };

export type ScenarioOverride = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly scenarioId: string;
  readonly revisionId: string;
  readonly overrideType: OverrideType;
  /** The value node overridden. Must be one the model does not compute. */
  readonly targetNodeId: string;
  readonly metricKey: string;
  readonly subjectEntityId: EntityId | null;
  readonly operation: OverrideOperation;
  /** Canonical exact decimal. For ADD, the delta. */
  readonly value: string;
  readonly unit: QuantityUnit;
  readonly currency: string | null;
  /** The period it applies to; null = every period of the revision. */
  readonly period: Period | null;
  readonly provenanceKind: OverrideProvenanceKind;
  /** Who or what stated it: 'manual', 'finance', 'scm', ... */
  readonly sourceSystem: string;
  readonly rationale: string;
  readonly confidence: Confidence | null;
  readonly createdBy: UserId | null;
  readonly createdAt: string;
};

export type OverrideInput = {
  overrideType: OverrideType;
  targetNodeId: string;
  operation?: OverrideOperation;
  value: string | number;
  unit: QuantityUnit;
  currency?: string | null;
  period?: Period | null;
  provenanceKind: OverrideProvenanceKind;
  sourceSystem?: string;
  rationale: string;
  confidence?: Confidence | null;
  structuralChange?: StructuralChange;
};

/** An override as it takes effect in one period, after inheritance. */
export type EffectiveOverride = {
  readonly override: ScenarioOverride;
  /** Set when an ancestor supplied it. */
  readonly inheritedFromScenarioId: string | null;
  /** Ancestor overrides of the same target and period this one shadows. */
  readonly shadowed: readonly ScenarioOverride[];
};

// ---------------------------------------------------------------- runs

export const stateKinds = ['BASELINE', 'SCENARIO'] as const;
export type StateKind = (typeof stateKinds)[number];

export const scenarioRunKinds = ['EXECUTE', 'REPLAY'] as const;
export type ScenarioRunKind = (typeof scenarioRunKinds)[number];

export const scenarioRunStatuses = ['RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'] as const;
export type ScenarioRunStatus = (typeof scenarioRunStatuses)[number];

/**
 *   COMPLETE  every calculation in every period produced a value
 *   PARTIAL   some branches are BLOCKED or FAILED; the rest stands and is shown
 *   INVALID   no period produced anything — nothing here can be compared
 */
export const completenessStates = ['COMPLETE', 'PARTIAL', 'INVALID'] as const;
export type Completeness = (typeof completenessStates)[number];

/** One simulation of one modelled state. Baseline runs have no scenario. */
export type ScenarioRun = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly stateKind: StateKind;
  readonly scenarioId: string | null;
  readonly revisionId: string | null;
  readonly kind: ScenarioRunKind;
  readonly replayOfRunId: string | null;
  readonly status: ScenarioRunStatus;
  readonly completeness: Completeness | null;
  /** The exact boundary executed. For a scenario run, its revision's fork. */
  readonly fork: ForkPoint;
  readonly periods: readonly Period[];
  readonly fingerprint: string;
  /** The model the simulation ran: engine version and calculation refs. */
  readonly modelRef: ModelRef;
  /** One propagation-engine run per period. */
  readonly periodRuns: readonly { readonly period: Period; readonly calculationRunId: string }[];
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly createdBy: UserId | null;
  readonly notes: string | null;
};

// ------------------------------------------------------------ future state

/**
 *   COMPUTED     produced by the simulation's calculation run
 *   OVERRIDDEN   stated by a scenario override
 *   INHERITED    the baseline's source value, untouched by the scenario
 *   BLOCKED      the model could not compute it; never estimated instead
 *   UNAVAILABLE  nothing in the source world speaks to it under this boundary
 */
export const valueOrigins = ['COMPUTED', 'OVERRIDDEN', 'INHERITED', 'BLOCKED', 'UNAVAILABLE'] as const;
export type ValueOrigin = (typeof valueOrigins)[number];

export type FutureStateValue = {
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly metricKey: string;
  readonly metricName: string;
  readonly dimension: ValueDimension;
  readonly directionality: Directionality;
  readonly subjectEntityId: EntityId | null;
  /** The period this value belongs to: the simulated period it was used or produced in. */
  readonly period: Period;
  readonly origin: ValueOrigin;
  /** Exact decimal string; null when BLOCKED or UNAVAILABLE. */
  readonly value: string | null;
  readonly unit: QuantityUnit | null;
  readonly currency: string | null;
  /** Inherited from the inputs, the assumptions and the calculation — never invented. */
  readonly confidence: Confidence | null;
  readonly observationId: string | null;
  readonly calculationRunId: string | null;
  readonly calculation: string | null;
  readonly stepStatus: string | null;
  /** Why it is BLOCKED or UNAVAILABLE. */
  readonly reason: string | null;
  /** Present when OVERRIDDEN. */
  readonly override: {
    readonly overrideId: string;
    readonly operation: OverrideOperation;
    readonly overrideValue: string;
    readonly baselineValue: string | null;
    readonly provenanceKind: string;
    readonly rationale: string;
    readonly inheritedFromScenarioId: string | null;
    readonly shadowedOverrideIds: readonly string[];
    /** False when no calculation in the model reads this node: stated, not propagated. */
    readonly consumed: boolean;
  } | null;
};

export type FutureState = {
  readonly run: ScenarioRun;
  readonly scenario: Scenario | null;
  readonly revision: ScenarioRevision | null;
  readonly label: string;
  readonly completeness: Completeness;
  readonly values: readonly FutureStateValue[];
  readonly constraints: readonly ScenarioConstraintResult[];
};

// ------------------------------------------------------------- constraints

export const constraintKinds = ['INVENTORY', 'CAPACITY', 'CASH', 'POLICY', 'DELIVERY_TIMING'] as const;
export type ConstraintKind = (typeof constraintKinds)[number];

export const constraintSeverities = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type ConstraintSeverity = (typeof constraintSeverities)[number];

/** A quantity in a future state, by metric and ontology subject (canonical key). */
export type ConstraintOperand =
  | { readonly metricKey: string; readonly subject: string }
  | { readonly sumOf: { readonly metricKey: string; readonly subjects: readonly string[] } };

/**
 * A feasibility rule: `required ≤ available`. Deterministic and model-level —
 * "the order cannot ship from the stock there is" — and never an authority
 * rule ("the GM must approve CAPEX above 5B"), which is Phase 6.
 */
export type ConstraintDefinition = {
  readonly key: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly kind: ConstraintKind;
  readonly severity: ConstraintSeverity;
  readonly required: ConstraintOperand;
  readonly available: ConstraintOperand;
};

export const constraintStatuses = ['SATISFIED', 'BREACHED', 'UNKNOWN'] as const;
export type ConstraintStatus = (typeof constraintStatuses)[number];

export type ScenarioConstraintResult = {
  readonly constraintKey: string;
  readonly constraintVersion: string;
  readonly name: string;
  readonly kind: ConstraintKind;
  readonly period: Period;
  readonly status: ConstraintStatus;
  /** The limit: what is available. */
  readonly threshold: string | null;
  /** What the state requires. */
  readonly actual: string | null;
  /** actual − threshold when BREACHED. */
  readonly breachAmount: string | null;
  readonly unit: QuantityUnit | null;
  readonly severity: ConstraintSeverity;
  readonly explanation: string;
};

// -------------------------------------------------------------- comparison

export const deltaDirections = ['UP', 'DOWN', 'UNCHANGED', 'UNRESOLVED'] as const;
export type DeltaDirection = (typeof deltaDirections)[number];

/**
 * What a movement means GIVEN the metric's declared directionality — and only
 * that. CONTEXT_DEPENDENT metrics (working capital, allocated stock) are shown,
 * not judged: judging them needs an objective or a constraint HELM does not
 * yet hold.
 */
export const directionalInterpretations = [
  'FAVORABLE',
  'UNFAVORABLE',
  'NEUTRAL',
  'CONTEXT_DEPENDENT',
] as const;
export type DirectionalInterpretation = (typeof directionalInterpretations)[number];

export type StateRef = {
  readonly runId: string;
  readonly stateKind: StateKind;
  readonly scenarioId: string | null;
  readonly scenarioKey: string | null;
  readonly revisionId: string | null;
  readonly label: string;
};

export type ValueDelta = {
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly metricKey: string;
  readonly metricName: string;
  readonly dimension: ValueDimension;
  readonly period: Period;
  readonly state: StateRef;
  readonly baseline: string | null;
  readonly scenario: string | null;
  readonly unit: QuantityUnit | null;
  readonly currency: string | null;
  readonly absoluteDelta: string | null;
  /** absoluteDelta ÷ |baseline|; null for percentages (the delta is already in points) or a zero baseline. */
  readonly relativeDelta: string | null;
  readonly direction: DeltaDirection;
  readonly directionalInterpretation: DirectionalInterpretation | null;
  readonly baselineConfidence: Confidence | null;
  readonly scenarioConfidence: Confidence | null;
  readonly baselineOrigin: ValueOrigin | null;
  readonly scenarioOrigin: ValueOrigin | null;
  /** Why the delta could not be stated. */
  readonly unresolvedReason: string | null;
};

/** What changed IN THE ASSUMPTIONS — shown separately from what changed in the outcomes. */
export type AssumptionDelta = {
  readonly state: StateRef;
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly metricKey: string;
  readonly period: Period | null;
  readonly overrideType: OverrideType;
  readonly operation: OverrideOperation;
  readonly overrideValue: string;
  readonly baselineValue: string | null;
  readonly scenarioValue: string | null;
  readonly unit: QuantityUnit;
  readonly currency: string | null;
  readonly provenanceKind: OverrideProvenanceKind;
  readonly rationale: string;
  readonly confidence: Confidence | null;
  readonly inheritedFromScenarioId: string | null;
  readonly shadowedOverrideIds: readonly string[];
  readonly consumed: boolean;
};

export type ComparisonRow = {
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly metricKey: string;
  readonly metricName: string;
  readonly dimension: ValueDimension;
  readonly directionality: Directionality;
  readonly period: Period;
  readonly cells: readonly {
    readonly state: StateRef;
    readonly value: string | null;
    readonly origin: ValueOrigin | null;
    readonly confidence: Confidence | null;
    readonly reason: string | null;
  }[];
};

/**
 * The trade-off space. It states differences; it never resolves them. There
 * is no score, no ranking and no "recommended" field, and `verify:phase-boundary`
 * fails the build if one appears.
 */
export type ScenarioComparison = {
  readonly baseline: StateRef;
  readonly alternatives: readonly StateRef[];
  readonly rows: readonly ComparisonRow[];
  readonly metricDeltas: readonly ValueDelta[];
  /** The same deltas grouped by value dimension, per alternative. Grouped, never summed. */
  readonly dimensionDeltas: readonly {
    readonly state: StateRef;
    readonly dimension: ValueDimension;
    readonly deltas: readonly ValueDelta[];
  }[];
  readonly assumptionDeltas: readonly AssumptionDelta[];
  readonly unresolvedMetrics: readonly {
    readonly state: StateRef;
    readonly nodeId: string;
    readonly metricKey: string;
    readonly period: Period;
    readonly reason: string;
  }[];
  readonly constraints: readonly { readonly state: StateRef; readonly results: readonly ScenarioConstraintResult[] }[];
  readonly completeness: readonly { readonly state: StateRef; readonly completeness: Completeness }[];
  /** Where two states were NOT simulated on the same footing, and why that matters. */
  readonly comparability: readonly {
    readonly state: StateRef;
    readonly sameFork: boolean;
    readonly samePeriods: boolean;
    readonly sameModel: boolean;
    readonly warnings: readonly string[];
  }[];
  readonly statement: string;
};

// ------------------------------------------------------------- validation

export type ValidationIssue = {
  readonly severity: 'ERROR' | 'WARNING' | 'INFO';
  readonly code: string;
  readonly message: string;
  readonly overrideId?: string;
  readonly nodeId?: string;
};

export type ValidationReport = {
  readonly revisionId: string;
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
  /** Per period: the effective override set after inheritance. */
  readonly effective: readonly { readonly period: Period; readonly overrides: readonly EffectiveOverride[] }[];
  readonly fingerprint: string;
};

// ------------------------------------------------------------- explanation

/** Lineage of one future-state value, framed by the state it belongs to. */
export type ScenarioExplanation = {
  readonly state: StateRef;
  readonly fork: ForkPoint;
  readonly fingerprint: string;
  readonly period: Period;
  readonly value: FutureStateValue;
  readonly calculationRunId: string | null;
  /** The engine's lineage, override nodes included. Null for an inherited or inert value. */
  readonly lineage: Explanation | null;
};
