/**
 * Management Digital Twin types (ADR-0023).
 *
 * The twin is a temporally versioned management representation of the
 * enterprise: what entities existed and how they were connected, what value
 * state existed, what management knew, which futures were considered, which one
 * was committed to, what authority governed it, and what changed afterwards.
 *
 * It is NOT a second database universe. A snapshot is a MANIFEST: every item it
 * holds names the kernel object it came from (entity version, relationship,
 * observation, calculation step, scenario run, commitment, evaluation, approval
 * act, …) and carries a materialized reading of it so a snapshot can be read
 * and compared without recomputation. The fingerprint binds the two: replaying
 * the composition under the same lens must reproduce it exactly.
 */

import type { OrgId, UserId } from '@helm/shared';

export const TwinErrors = {
  NOT_FOUND: 'twin.not_found',
  INVALID_INPUT: 'twin.invalid_input',
  SCOPE_UNRESOLVED: 'twin.scope_unresolved',
  IMMUTABLE: 'twin.immutable',
  FINGERPRINT_MISMATCH: 'twin.fingerprint_mismatch',
  NOT_VISIBLE: 'twin.not_visible',
  NOT_COMPARABLE: 'twin.not_comparable',
  WRITE_FAILED: 'twin.write_failed',
  READ_FAILED: 'twin.read_failed',
} as const;

// ------------------------------------------------------------- snapshots

/**
 *   CURRENT           the latest management state under the current knowledge boundary
 *   HISTORICAL        the enterprise as HELM knew it at an earlier record time
 *   EXPECTED          what the business forecasts and the model derives, for a period
 *   SCENARIO          a hypothetical future computed by the Scenario Runtime
 *   COMMITTED_FUTURE  the future management explicitly committed toward, frozen
 *
 * They are never collapsed. A scenario never becomes CURRENT, and a commitment
 * never becomes the actual state: committing changes intent, not reality.
 */
export const snapshotKinds = ['CURRENT', 'HISTORICAL', 'EXPECTED', 'SCENARIO', 'COMMITTED_FUTURE'] as const;
export type SnapshotKind = (typeof snapshotKinds)[number];

/** The two-time lens (ADR-0014). Both are always explicit. */
export type TwinLens = {
  /** Business time: which state of the world the snapshot describes. */
  readonly effectiveAsOf: string;
  /** Knowledge boundary: nothing recorded after this instant enters the snapshot. */
  readonly recordedThrough: string;
};

/**
 * A bounded snapshot. ENTERPRISE is the whole organization; ENTITY anchors on
 * one entity — a country, a business unit, a customer, a portfolio, a product,
 * an opportunity — and takes what sits within it (see scope.ts).
 */
export type TwinScope =
  | { readonly kind: 'ENTERPRISE'; readonly label: string }
  | { readonly kind: 'ENTITY'; readonly entityId: string; readonly entityTypeKey: string; readonly label: string };

export const completenessStates = ['COMPLETE', 'PARTIAL', 'DEGRADED', 'INVALID'] as const;
/**
 *   COMPLETE  every item the scope calls for was read and can be relied on
 *   PARTIAL   some items could not be read (no feed, blocked calculation, unknown
 *             input) — they are listed as such, never filled with zero
 *   DEGRADED  items are present but reduced in trust (a stale model value, an
 *             authority verdict produced outside the trusted path, an
 *             unclassified customer, missing authority information)
 *   INVALID   the snapshot cannot describe its scope at all
 */
export type TwinCompleteness = (typeof completenessStates)[number];

export type CompletenessReason = {
  readonly code: string;
  readonly severity: Exclude<TwinCompleteness, 'COMPLETE'>;
  readonly message: string;
  readonly itemKey: string | null;
};

/** What a snapshot was composed from — enough to replay it exactly. */
export type SnapshotSpec = {
  readonly kind: SnapshotKind;
  readonly label: string;
  readonly lens: TwinLens;
  readonly scope: TwinScope;
  /** Business periods value state is read for. Keys as periodKey() writes them. */
  readonly periods: readonly string[];
  /** SCENARIO: the scenario run. COMMITTED_FUTURE: the commitment. */
  readonly scenarioRunId: string | null;
  readonly commitmentId: string | null;
};

export type ModelIdentity = {
  readonly engineVersion: string;
  /** Sorted `key@version` of the calculation registry the snapshot read under. */
  readonly calculations: readonly string[];
  readonly attentionRules: string;
  readonly composer: string;
};

export type TwinSnapshot = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly spec: SnapshotSpec;
  readonly model: ModelIdentity;
  /** Kernel objects the snapshot as a whole rests on (runs, commitments, policies). */
  readonly sourceReferences: readonly KernelRef[];
  readonly completeness: TwinCompleteness;
  readonly completenessReasons: readonly CompletenessReason[];
  /** Union of the item sensitivities — a label derived from the contents, never declared. */
  readonly sensitivityClasses: readonly SensitivityClass[];
  /** Org units whose members (and members of any unit above) may read the snapshot. */
  readonly grantedUnitIds: readonly string[];
  readonly itemCount: number;
  readonly fingerprint: string;
  /** For a CURRENT snapshot: the CURRENT snapshot of the same scope it follows. */
  readonly previousSnapshotId: string | null;
  readonly builtBy: UserId | null;
  readonly createdAt: string;
};

// ----------------------------------------------------------------- items

export const managementCategories = [
  'STRUCTURE',
  'VALUE',
  'PERFORMANCE',
  'CONSTRAINTS',
  'RISKS',
  'OBJECTIVES',
  'DECISIONS',
  'COMMITMENTS',
  'GOVERNANCE',
  'ASSUMPTIONS',
  'ATTENTION',
] as const;
export type ManagementCategory = (typeof managementCategories)[number];

export const itemKinds = [
  'ENTITY',
  'RELATIONSHIP',
  'ROLE_OCCUPANCY',
  'VALUE',
  'CONSTRAINT',
  'OBJECTIVE',
  'DECISION',
  'COMMITMENT',
  'ACTION_INTENT',
  'GOVERNANCE',
  'POLICY',
  'DELEGATION',
  'ASSUMPTION',
  'CHALLENGE',
  'ATTENTION',
] as const;
export type ItemKind = (typeof itemKinds)[number];

/**
 * Which kind of claim a value item is. These are the twin's statement of
 * "ACTUAL STATE ≠ MODELLED STATE ≠ COMMITTED FUTURE": a reading is always one
 * of them and is never promoted into another.
 */
export const stateLayers = [
  'ACTUAL',
  'FORECAST',
  'ESTIMATE',
  'ASSUMED',
  'TARGET',
  'MODELLED',
  'SCENARIO',
  'COMMITTED_FUTURE',
] as const;
export type StateLayer = (typeof stateLayers)[number];

export const itemStatuses = ['KNOWN', 'UNKNOWN', 'BLOCKED', 'UNAVAILABLE'] as const;
export type ItemStatus = (typeof itemStatuses)[number];

export const refKinds = [
  'ENTITY',
  'ENTITY_VERSION',
  'RELATIONSHIP',
  'VALUE_NODE',
  'OBSERVATION',
  'CALCULATION_RUN',
  'CALCULATION_STEP',
  'SCENARIO',
  'SCENARIO_REVISION',
  'SCENARIO_RUN',
  'CONSTRAINT_RESULT',
  'DECISION',
  'DECISION_REVISION',
  'COMMITMENT',
  'COMMITMENT_SNAPSHOT',
  'ACTION_INTENT',
  'ASSUMPTION',
  'CHALLENGE',
  'OUTCOME_REVIEW',
  'DECISION_EVENT',
  'EVALUATION',
  'REQUIRED_APPROVAL',
  'APPROVAL_ACT',
  'POLICY',
  'RULE',
  'OCCUPANCY',
  'DELEGATION',
  'TWIN_ITEM',
] as const;
export type RefKind = (typeof refKinds)[number];

/** A pointer into the kernel. A twin item without one is a defect (verify:twin-lineage). */
export type KernelRef = {
  readonly kind: RefKind;
  readonly id: string;
  /** Version, fingerprint or record time that pins which state of the object was read. */
  readonly pin: string | null;
  readonly label: string | null;
};

export const sensitivityClasses = [
  'GENERAL_MANAGEMENT',
  'FINANCIAL_SENSITIVE',
  'COMMERCIAL_CONFIDENTIAL',
  'HR_RESTRICTED',
  'STRATEGIC_RESTRICTED',
] as const;
export type SensitivityClass = (typeof sensitivityClasses)[number];

export type ValueReading = {
  readonly nodeId: string;
  readonly metricKey: string;
  readonly metricName: string;
  readonly dimension: string;
  readonly directionality: string;
  readonly layer: StateLayer;
  /** Exact decimal string; null when the reading is not KNOWN. */
  readonly value: string | null;
  readonly unit: string | null;
  readonly currency: string | null;
  readonly period: string | null;
  readonly observationId: string | null;
  readonly observationType: string | null;
  readonly effectiveAt: string | null;
  readonly recordedAt: string | null;
  readonly sourceSystem: string | null;
  readonly confidence: number | null;
  /** When the value was calculated: `key@version`, the run and the step. */
  readonly calculation: string | null;
  readonly calculationRunId: string | null;
  readonly calculationStepId: string | null;
  /** Scenario / committed-future values only. */
  readonly origin: string | null;
  /** For a MODELLED reading: were its inputs superseded before the knowledge boundary? */
  readonly freshness: 'CLEAN' | 'STALE' | 'NOT_APPLICABLE';
  readonly staleInputs: readonly string[];
  /** Committed future: this node is one of the commitment's stated expected outcomes. */
  readonly expectedOutcome: boolean;
};

export const objectivePositions = ['MEETS_TARGET', 'SHORT_OF_TARGET', 'FORECAST_MEETS_TARGET', 'FORECAST_SHORT_OF_TARGET', 'NOT_ASSESSABLE'] as const;
export type ObjectivePosition = (typeof objectivePositions)[number];

export type ObjectiveState = {
  readonly nodeId: string;
  readonly metricKey: string;
  readonly label: string;
  readonly unit: string | null;
  readonly currency: string | null;
  readonly period: string | null;
  readonly directionality: string;
  readonly target: string | null;
  readonly actual: string | null;
  readonly forecast: string | null;
  readonly modelled: string | null;
  readonly committedFuture: string | null;
  /** What the "current" figure is read from, in this order: ACTUAL, MODELLED. */
  readonly currentLayer: 'ACTUAL' | 'MODELLED' | null;
  /** current − target, exact. Points for percentages. Null when either is missing. */
  readonly varianceToTarget: string | null;
  /**
   * Where the objective stands, read from the current value when there is one and
   * otherwise from the forecast — and the position says which it was read from.
   */
  readonly position: ObjectivePosition;
  readonly objectiveEntityIds: readonly string[];
};

export type TwinItem = {
  /** Stable identity within a snapshot and across snapshots: the unit of comparison. */
  readonly key: string;
  readonly kind: ItemKind;
  readonly categories: readonly ManagementCategory[];
  readonly label: string;
  readonly subjectEntityId: string | null;
  readonly layer: StateLayer | null;
  readonly status: ItemStatus;
  /** Kind-specific materialized reading. JSON-safe and deterministic. */
  readonly state: Readonly<Record<string, unknown>>;
  readonly refs: readonly KernelRef[];
  readonly sensitivity: SensitivityClass;
  readonly reason: string | null;
};

/** A snapshot with its manifest, as composed or as loaded. */
export type ComposedSnapshot = {
  readonly snapshot: TwinSnapshot;
  readonly items: readonly TwinItem[];
};

// ------------------------------------------------------------ attention

export const attentionConditions = [
  'CONSTRAINT_BREACHED',
  'MATERIAL_VALUE_DETERIORATION',
  'DECISION_AWAITING_COMMITMENT',
  'APPROVAL_PENDING',
  'COMMITMENT_NOT_AUTHORIZED',
  'AUTHORITY_UNRESOLVED',
  'ASSUMPTION_CHALLENGED',
  'CRITICAL_ASSUMPTION_DISPROVED',
  'SCENARIO_INCOMPLETE',
  'OBJECTIVE_OFF_TRACK',
  'RISK_EXPOSURE_INCREASED',
  'COMMITTED_FUTURE_OFF_TRACK',
] as const;
export type AttentionCondition = (typeof attentionConditions)[number];

/**
 * A condition a stated rule found — never a priority, never a score. The rule
 * is named, the cause is referenced, and nothing is ranked against anything.
 */
export type AttentionState = {
  readonly condition: AttentionCondition;
  readonly rule: string;
  readonly statement: string;
  /** The twin items (and through them the kernel objects) that raised it. */
  readonly causeItemKeys: readonly string[];
};

// ----------------------------------------------------------------- delta

export const differenceCategories = [
  'STRUCTURAL_CHANGE',
  'VALUE_CHANGE',
  'KNOWLEDGE_CHANGE',
  'DECISION_CHANGE',
  'ASSUMPTION_CHANGE',
  'GOVERNANCE_CHANGE',
  'CONSTRAINT_CHANGE',
  'ATTENTION_CHANGE',
] as const;
export type DifferenceCategory = (typeof differenceCategories)[number];

export type ItemChange = {
  readonly itemKey: string;
  readonly kind: ItemKind;
  readonly label: string;
  readonly category: DifferenceCategory;
  readonly change: 'ADDED' | 'REMOVED' | 'CHANGED';
  readonly before: TwinItem | null;
  readonly after: TwinItem | null;
  /** Field-level: what moved, in plain words. */
  readonly fields: readonly { readonly field: string; readonly before: unknown; readonly after: unknown }[];
  /** Value changes: exact delta, and "pts" for percentages. */
  readonly delta: string | null;
  readonly deltaUnit: string | null;
  readonly statement: string;
};

/** Snapshot A → Snapshot B, by category. Nothing here is a verdict. */
export type TwinDelta = {
  readonly from: TwinSnapshot;
  readonly to: TwinSnapshot;
  readonly comparability: {
    readonly sameScope: boolean;
    readonly sameModel: boolean;
    readonly warnings: readonly string[];
  };
  readonly structuralChanges: readonly ItemChange[];
  readonly valueChanges: readonly ItemChange[];
  readonly knowledgeChanges: readonly ItemChange[];
  readonly decisionChanges: readonly ItemChange[];
  readonly assumptionChanges: readonly ItemChange[];
  readonly governanceChanges: readonly ItemChange[];
  readonly constraintChanges: readonly ItemChange[];
  readonly attentionChanges: readonly ItemChange[];
  /** Conditions only a comparison can see: deterioration, rising exposure. */
  readonly deltaAttention: readonly AttentionState[];
  readonly unchangedCount: number;
  readonly statement: string;
};

// ------------------------------------------------------------ trajectory

/**
 *   DISTANCE_TO_INTENT   the committed period has not ended: how far the current
 *                        state is from the committed future. Not a variance —
 *                        nothing was due yet.
 *   EXPECTED_VS_ACTUAL   the committed period has ended: what management expected
 *                        against what the enterprise became.
 */
export const trajectoryRelations = ['DISTANCE_TO_INTENT', 'EXPECTED_VS_ACTUAL'] as const;
export type TrajectoryRelation = (typeof trajectoryRelations)[number];

export type TrajectoryLine = {
  readonly nodeId: string;
  readonly metricKey: string;
  readonly label: string;
  readonly period: string | null;
  readonly unit: string | null;
  readonly currency: string | null;
  readonly committed: string | null;
  readonly current: string | null;
  readonly currentLayer: StateLayer | null;
  readonly difference: string | null;
  readonly differenceUnit: string | null;
  readonly beyondMateriality: boolean | null;
  readonly note: string | null;
};

export type Trajectory = {
  readonly relation: TrajectoryRelation;
  readonly commitmentId: string;
  readonly current: TwinSnapshot;
  readonly committedFuture: TwinSnapshot;
  readonly horizon: string | null;
  readonly lines: readonly TrajectoryLine[];
  /** What still stands between the two: action intents, approvals, assumptions. */
  readonly unresolved: readonly { readonly itemKey: string; readonly label: string; readonly why: string }[];
  readonly statement: string;
};

// ----------------------------------------------------------- explanation

export type AttributionNode = {
  readonly input: string;
  readonly metricKey: string;
  readonly nodeId: string | null;
  readonly before: string | null;
  readonly after: string | null;
  readonly beforeSource: string;
  readonly afterSource: string;
  readonly beforeRef: KernelRef | null;
  readonly afterRef: KernelRef | null;
  readonly changedBecause: readonly AttributionNode[];
};

export type LineageStep = {
  readonly depth: number;
  readonly label: string;
  readonly ref: KernelRef | null;
  readonly detail: string;
};

export type TwinItemExplanation = {
  readonly snapshot: TwinSnapshot;
  readonly item: TwinItem;
  /** Snapshot → item → kernel object → calculation/scenario/decision/governance → source. */
  readonly chain: readonly LineageStep[];
  readonly statement: string;
};

export type DifferenceExplanation = {
  readonly itemKey: string;
  readonly from: { readonly snapshot: TwinSnapshot; readonly item: TwinItem | null; readonly lineage: readonly LineageStep[] };
  readonly to: { readonly snapshot: TwinSnapshot; readonly item: TwinItem | null; readonly lineage: readonly LineageStep[] };
  readonly delta: string | null;
  readonly deltaUnit: string | null;
  /** Which model inputs changed, recursively, down to the facts and assumptions. */
  readonly attribution: readonly AttributionNode[];
  readonly statement: string;
  /** Always present: this is dependency attribution through the model, not causality. */
  readonly disclaimer: string;
};

export const ATTRIBUTION_DISCLAIMER =
  'This is deterministic dependency attribution through HELM\'s model: the calculated value moved because ' +
  'these model inputs moved. It is not a causal claim about the world — causal hypotheses are Phase 8.';
