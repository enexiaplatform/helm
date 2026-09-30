/**
 * The Counterfactual vocabulary (ADR-0029).
 *
 * A counterfactual is ex post: GIVEN what actually happened, what might have
 * happened had management chosen differently. It is not a scenario (ex ante),
 * it does not start from today's enterprise, and it is never a verdict on the
 * decision: nothing here is a regret figure, a ranking or a probability.
 *
 *     Scenario ≠ Counterfactual · AS_KNOWN_THEN ≠ WITH_HINDSIGHT
 *     Decision Process Quality ≠ Outcome Quality
 */

import type { OrgId, Period, QuantityUnit, UserId } from '@helm/shared';
import type { OverrideInput } from '@helm/scenario-runtime';
import type { CausalScope, ClaimStatus } from '@helm/causal-runtime';
import type { SensitivityClass, TwinLens } from '@helm/twin-runtime';

export const CounterfactualErrors = {
  INVALID: 'counterfactual.invalid_input',
  NOT_FOUND: 'counterfactual.not_found',
  FORBIDDEN: 'counterfactual.forbidden',
  DUPLICATE: 'counterfactual.duplicate',
  NO_COMMITMENT: 'counterfactual.no_commitment',
  UNANCHORED: 'counterfactual.unanchored',
  HINDSIGHT_AS_ANCHOR: 'counterfactual.hindsight_as_anchor',
  NOT_AN_INTERVENTION: 'counterfactual.not_an_intervention',
  HINDSIGHT_IN_AS_KNOWN_THEN: 'counterfactual.hindsight_in_as_known_then',
  NO_HINDSIGHT_INPUTS: 'counterfactual.no_hindsight_inputs',
  NOT_HINDSIGHT: 'counterfactual.not_hindsight',
  HINDSIGHT_IS_CONSEQUENCE: 'counterfactual.hindsight_is_consequence',
  CLASS_EXCEEDS_CASE: 'counterfactual.class_exceeds_case',
  NOT_KNOWN_AT_LENS: 'counterfactual.not_known_at_lens',
  KNOWLEDGE_IN_FUTURE: 'counterfactual.knowledge_in_future',
  NOTHING_TO_REVIEW: 'counterfactual.nothing_to_review',
} as const;

export type CounterfactualLens = TwinLens;
export type CounterfactualScope = CausalScope;

// ---------------------------------------------------------------- vocabulary

/** The two retrospective questions. They are never blended into one world. */
export const retrospectiveLenses = ['AS_KNOWN_THEN', 'WITH_HINDSIGHT'] as const;
export type RetrospectiveLens = (typeof retrospectiveLenses)[number];

/** How a world was estimated. Only the executable model exists; a causal-inference method may implement the same port later. */
export const counterfactualMethods = ['MODEL_COUNTERFACTUAL'] as const;
export type CounterfactualMethod = (typeof counterfactualMethods)[number];

export const estimabilities = ['ESTIMATED', 'NOT_ESTIMABLE'] as const;
export type Estimability = (typeof estimabilities)[number];

/** Where a world's state came from. */
export const worldOrigins = ['BOUND_TO_DECISION', 'COMPUTED_FOR_CASE'] as const;
export type WorldOrigin = (typeof worldOrigins)[number];

/**
 * Whether the enterprise has EVIDENCE for the links from what the intervention
 * moves to what is compared — a separate judgement from the estimate itself:
 *   MODEL_ONLY           no applicable, SUPPORTED causal claim links a moved input to a compared metric at the lens
 *   PARTIALLY_SUPPORTED  some moved-input → compared-metric pairs have one; others do not
 *   CAUSALLY_SUPPORTED   every pair has one (still a model result: HELM identifies nothing)
 *   CONTESTED            no pair is supported and at least one is contested, weakened or refuted
 */
export const causalSupports = ['MODEL_ONLY', 'PARTIALLY_SUPPORTED', 'CAUSALLY_SUPPORTED', 'CONTESTED'] as const;
export type CausalSupportLevel = (typeof causalSupports)[number];

export const pairStates = ['SUPPORTED_PATH', 'UNSUPPORTED_PATH', 'CONTESTED_PATH', 'OUTSIDE_SCOPE', 'NO_PATH', 'NO_CAUSAL_KNOWLEDGE'] as const;
export type PairState = (typeof pairStates)[number];

// ---------------------------------------------------------------- intervention

/** One explicit change to the world, with why. Same shape a scenario override takes. */
export type InterventionOverride = OverrideInput;

/** What differs from reality. Never proposed by HELM; always different from what was chosen. */
export type CounterfactualIntervention =
  | { readonly kind: 'CHOOSE_ALTERNATIVE'; readonly alternativeId: string }
  | { readonly kind: 'OVERRIDES'; readonly label: string; readonly overrides: readonly InterventionOverride[] };

/** A metric the case compares, copied from what the commitment expected to move. */
export type ComparedMetric = {
  readonly label: string;
  readonly metricKey: string;
  readonly nodeId: string | null;
  readonly period: Period | null;
  readonly unit: QuantityUnit | null;
  readonly currency: string | null;
};

// ---------------------------------------------------------------- case

/**
 * The question, and the anchor. Immutable identity: everything else is a world
 * or a review appended later.
 */
export type CounterfactualCase = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly commitmentId: string;
  readonly title: string;
  /** "What might have happened had we expedited instead of reallocating?" */
  readonly question: string;
  readonly intervention: CounterfactualIntervention;
  /** A twin snapshot known at or before the decision boundary — never today's state. */
  readonly anchor: { readonly snapshotId: string; readonly lens: CounterfactualLens };
  /** The knowledge boundary management decided under. */
  readonly boundary: CounterfactualLens;
  readonly compared: readonly ComparedMetric[];
  readonly scope: CounterfactualScope;
  /** Derived from the compared metrics — never declared. */
  readonly sensitivityClasses: readonly SensitivityClass[];
  readonly visibility: 'ORG_WIDE' | 'RESTRICTED';
  readonly grantedUnitIds: readonly string[];
  readonly authoredBy: UserId | null;
  readonly authoredByLabel: string;
  readonly recordedAt: string;
};

// ---------------------------------------------------------------- hindsight

/**
 * One fact learned AFTER the decision boundary, stated as an override with the
 * record it came from — and a person's statement of why it does not depend on
 * which alternative was chosen. HELM shows that assertion; it cannot verify it.
 */
export type HindsightInput = {
  readonly label: string;
  readonly source: { readonly kind: 'OUTCOME_REVIEW' | 'EXTERNAL_RECORD'; readonly ref: string };
  /** When the enterprise learned it. Derived from the source record; always after the boundary. */
  readonly learnedAt: string;
  readonly override: InterventionOverride;
  /** Required: why this is news about the world and not a consequence of the choice. */
  readonly exogeneity: string;
};

/** A hindsight input as a person supplies it. `learnedAt` is read from an outcome review, or stated for an external record. */
export type HindsightInputSpec = {
  readonly label: string;
  readonly source: { readonly kind: 'OUTCOME_REVIEW' | 'EXTERNAL_RECORD'; readonly ref: string; readonly learnedAt?: string };
  readonly override: InterventionOverride;
  readonly exogeneity: string;
};

// ---------------------------------------------------------------- world

export type WorldReading = {
  readonly label: string;
  readonly metricKey: string;
  readonly nodeId: string | null;
  readonly period: Period | null;
  readonly status: 'READ' | 'UNAVAILABLE';
  /** Exact decimal string; null when UNAVAILABLE. Never estimated instead. */
  readonly value: string | null;
  readonly unit: QuantityUnit | null;
  readonly currency: string | null;
  readonly origin: string | null;
  readonly reason: string | null;
  /** "Under model …, and the N assumptions listed, the estimated counterfactual … is …" */
  readonly statement: string;
};

/** A value the intervention (or a hindsight input) set, as the world shows it. */
export type MovedInput = {
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly metricKey: string;
  readonly period: Period;
  readonly source: 'INTERVENTION' | 'HINDSIGHT';
  readonly baselineValue: string | null;
  readonly value: string;
  readonly rationale: string;
  readonly provenanceKind: string;
  readonly confidence: number | null;
};

export type WorldAssumption = {
  readonly label: string;
  readonly rationale: string;
  readonly provenanceKind: string;
  readonly confidence: number | null;
};

export type WorldConstraint = {
  readonly key: string;
  readonly name: string;
  readonly kind: string;
  readonly period: Period;
  readonly status: string;
  readonly breachAmount: string | null;
  readonly unit: QuantityUnit | null;
};

/**
 * One computed world for one retrospective lens. Append-only: a later
 * estimate is a new world, and both stay readable.
 */
export type CounterfactualWorld = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly caseId: string;
  readonly lens: RetrospectiveLens;
  readonly method: CounterfactualMethod;
  readonly estimability: Estimability;
  readonly notEstimableReasons: readonly string[];
  /** The fork the STATE was read at — always the decision's own. */
  readonly anchorFork: { readonly effectiveAsOf: string; readonly recordedThrough: string; readonly policy: string };
  /** The lens the world's INFORMATION was read at: the boundary for AS_KNOWN_THEN, the moment of the estimate for WITH_HINDSIGHT. */
  readonly knowledge: CounterfactualLens;
  readonly origin: WorldOrigin | null;
  readonly scenario: { readonly scenarioId: string; readonly revisionId: string | null; readonly runId: string } | null;
  readonly model: { readonly engineVersion: string; readonly calculations: readonly string[] } | null;
  readonly readings: readonly WorldReading[];
  readonly movedInputs: readonly MovedInput[];
  readonly assumptions: readonly WorldAssumption[];
  readonly constraints: readonly WorldConstraint[];
  readonly hindsightInputs: readonly HindsightInput[];
  readonly uncertainty: readonly string[];
  readonly statement: string;
  readonly fingerprint: string;
  readonly createdBy: UserId | null;
  readonly createdByLabel: string;
  readonly recordedAt: string;
};

// ---------------------------------------------------------------- causal support

export type PairSupport = {
  readonly input: MovedInput;
  readonly compared: ComparedMetric;
  readonly state: PairState;
  /** The claims on the strongest path found, or the ones that count against it. */
  readonly claims: readonly { readonly claimId: string; readonly statement: string; readonly status: ClaimStatus; readonly confidence: string; readonly applies: boolean }[];
  /** The model dependency between the two metrics, shown apart and never counted. */
  readonly modelDependency: string | null;
  readonly note: string;
};

export type CausalSupport = {
  readonly level: CausalSupportLevel;
  /** The lens the claims were read at — the world's own knowledge boundary. */
  readonly lens: CounterfactualLens;
  readonly pairs: readonly PairSupport[];
  readonly statement: string;
};

// ---------------------------------------------------------------- review

/** A person's recorded reading of the comparison. Append-only; limitations are required. */
export type CounterfactualReview = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly caseId: string;
  /** The comparison fingerprint the reviewer saw. A review says what it was a review OF. */
  readonly comparisonFingerprint: string;
  readonly statement: string;
  readonly limitations: string;
  readonly reviewedBy: UserId | null;
  readonly reviewedByLabel: string;
  readonly recordedAt: string;
};

// ---------------------------------------------------------------- layers

export const comparisonLayers = ['EXPECTED_AT_COMMITMENT', 'ACTUAL', 'ALTERNATIVE_THEN', 'ALTERNATIVE_WITH_HINDSIGHT'] as const;
export type ComparisonLayer = (typeof comparisonLayers)[number];

export type ComparisonCell = {
  readonly layer: ComparisonLayer;
  readonly status: 'READ' | 'UNAVAILABLE';
  readonly value: string | null;
  readonly unit: QuantityUnit | null;
  readonly currency: string | null;
  /** Where the number came from, in words. */
  readonly source: string;
  readonly reason: string | null;
  readonly worldId: string | null;
};
