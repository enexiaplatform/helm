/**
 * Decision Runtime types — what management decided, and everything it knew
 * when it decided (ADR-0021).
 *
 * TERMINOLOGY, used consistently everywhere below and in the docs:
 *
 *   Decision      The durable management object: one management QUESTION, its
 *                 context, its trigger, its owner and its horizons. Not a
 *                 chosen option — the question comes first and outlives the
 *                 answer.
 *   Revision      One preparation state of that decision: the alternatives,
 *                 criteria, assumptions, evidence and challenges as they stood.
 *                 Immutable once SEALED. A commitment seals one.
 *   Alternative   A management option. It carries NO economics of its own: it
 *                 references a scenario revision and the run that computed its
 *                 future, or declares itself UNMODELLED.
 *   Criterion     What management says matters, with how it is to be judged —
 *                 a hard constraint, a target, a preference, a qualitative
 *                 assessment, or a weighted input management itself defined.
 *   Assumption    A management-level belief the decision rests on, with an
 *                 OWNER who stands behind it.
 *   Challenge     Recorded disagreement with an assumption, criterion,
 *                 alternative or the framing itself. Decision evidence, not a
 *                 conversation.
 *   Evidence      Something outside the model that supports, challenges,
 *                 contextualizes or invalidates part of the decision.
 *   Readiness     Procedural completeness — never quality, never a winner.
 *   Commitment    "Management chose this, for these reasons, accepting these
 *                 trade-offs." Immutable, fingerprinted, and NOT an approval:
 *                 whether the actor was authorized is Phase 6's question.
 *   Snapshot      The frozen evidence manifest of a commitment: exactly what
 *                 was on the table, by reference and by fingerprint.
 *
 * HELM never chooses. It computes what each future looks like, states how each
 * alternative stands against management's own criteria, names the trade-offs,
 * and records the choice a person made.
 */

import type {
  Confidence,
  OrgId,
  Period,
  QuantityUnit,
  UserId,
} from '@helm/shared';
import type { Directionality } from '@helm/value-graph';
import type {
  Completeness,
  ForkPoint,
  ModelRef,
  ScenarioComparison,
  ScenarioExplanation,
  ValueOrigin,
} from '@helm/scenario-runtime';

// ------------------------------------------------------------------ errors

export const DecisionErrors = {
  NOT_FOUND: 'decision.not_found',
  INVALID_INPUT: 'decision.invalid_input',
  INVALID_TRANSITION: 'decision.invalid_transition',
  REVISION_SEALED: 'decision.revision_sealed',
  DRAFT_EXISTS: 'decision.draft_exists',
  ALREADY_COMMITTED: 'decision.already_committed',
  NOT_COMMITTED: 'decision.not_committed',
  COMMITMENT_IMMUTABLE: 'decision.commitment_immutable',
  ALTERNATIVE_UNMODELLED: 'decision.alternative_unmodelled',
  SCENARIO_NOT_FOUND: 'decision.scenario_not_found',
  SCENARIO_NOT_COMPLETED: 'decision.scenario_not_completed',
  CROSS_ORG: 'decision.cross_org',
  NOT_READY: 'decision.not_ready',
  WEIGHTING_NOT_DECLARED: 'decision.weighting_not_declared',
  WRITE_FAILED: 'decision.write_failed',
  READ_FAILED: 'decision.read_failed',
} as const;

// --------------------------------------------------------------- lifecycle

/**
 * The kernel decision lifecycle.
 *
 * Deliberately WITHOUT `pending_approval`, `approved` and `rejected`, which
 * the pre-kernel lifecycle had. Those are authority states, and Phase 5 does
 * not evaluate authority — it records that management committed. Phase 6 adds
 * whether the actor was allowed to.
 *
 *   DRAFT              the question is being framed
 *   INVESTIGATING      alternatives and evidence are being gathered
 *   MODELLING          alternatives are being bound to scenario futures
 *   READY_FOR_DECISION the preparation is procedurally complete enough to decide
 *   COMMITTED          management has chosen; the evidence basis is frozen
 *   EXECUTING          action intents are in flight
 *   COMPLETED          execution finished
 *   REVIEWED           expected vs actual has been looked at (terminal)
 *   CANCELLED          abandoned without a commitment (terminal)
 */
export const decisionStates = [
  'DRAFT',
  'INVESTIGATING',
  'MODELLING',
  'READY_FOR_DECISION',
  'COMMITTED',
  'EXECUTING',
  'COMPLETED',
  'REVIEWED',
  'CANCELLED',
] as const;
export type DecisionState = (typeof decisionStates)[number];

export const decisionTransitions: Readonly<Record<DecisionState, readonly DecisionState[]>> = {
  DRAFT: ['INVESTIGATING', 'MODELLING', 'CANCELLED'],
  INVESTIGATING: ['MODELLING', 'READY_FOR_DECISION', 'DRAFT', 'CANCELLED'],
  MODELLING: ['READY_FOR_DECISION', 'INVESTIGATING', 'CANCELLED'],
  // A decision may go back for more work right up until it is committed.
  READY_FOR_DECISION: ['COMMITTED', 'MODELLING', 'INVESTIGATING', 'CANCELLED'],
  // COMMITTED never returns to preparation: a reconsideration is a NEW revision.
  COMMITTED: ['EXECUTING', 'COMPLETED', 'REVIEWED'],
  EXECUTING: ['COMPLETED', 'REVIEWED'],
  COMPLETED: ['REVIEWED'],
  REVIEWED: [],
  CANCELLED: [],
};

/**
 * How the pre-kernel lifecycle maps onto this one. `pending_approval`,
 * `approved` and `rejected` have NO kernel equivalent on purpose — see
 * docs/architecture/decision-engine-assessment.md.
 */
export const legacyStateMapping: Readonly<Record<string, DecisionState | null>> = {
  draft: 'DRAFT',
  analyzing: 'INVESTIGATING',
  pending_approval: null,
  approved: null,
  rejected: null,
  executing: 'EXECUTING',
  monitoring: 'EXECUTING',
  closed: 'COMPLETED',
};

// ----------------------------------------------------------------- trigger

/** Why the decision exists at all. */
export const decisionTriggerTypes = [
  'SIGNAL',
  'ISSUE',
  'OPPORTUNITY',
  'RISK',
  'PLANNED_REVIEW',
  'STRATEGIC_INITIATIVE',
  'EXCEPTION',
  'MANUAL',
] as const;
export type DecisionTriggerType = (typeof decisionTriggerTypes)[number];

/** What the trigger points at. Optional: a manually raised decision has none. */
export type TriggerRef = {
  readonly kind: 'SIGNAL' | 'SCENARIO' | 'OPPORTUNITY' | 'RISK' | 'OBJECTIVE' | 'METRIC' | 'EXTERNAL';
  readonly ref: string;
  readonly label: string;
};

// ------------------------------------------------------------ reversibility

/**
 * How far a commitment can be walked back. Recorded because it should later
 * drive review cadence and governance — NOT because it scores an alternative.
 */
export const reversibilities = ['REVERSIBLE', 'PARTIALLY_REVERSIBLE', 'IRREVERSIBLE', 'UNASSESSED'] as const;
export type Reversibility = (typeof reversibilities)[number];

// --------------------------------------------------------------- authority

/**
 * Phase 6's integration point, and nothing more. Phase 5 writes exactly one
 * value; producing AUTHORIZED / REQUIRES_APPROVAL / ESCALATED is the authority
 * system's job and `verify:phase-boundary` fails the build if Phase 5 starts
 * producing them.
 */
export const authorityStatuses = ['NOT_EVALUATED'] as const;
export type AuthorityStatus = (typeof authorityStatuses)[number];

// ---------------------------------------------------------------- decision

/**
 * The decision's own temporal frame. Four dates that are genuinely different
 * questions, kept apart rather than overloaded onto one `due_date`.
 */
export type DecisionHorizon = {
  /** By when the choice must be made. */
  readonly decisionDeadline: string | null;
  /** When the chosen course starts. */
  readonly effectiveFrom: string | null;
  /** When its consequences should have materialized. */
  readonly expectedOutcomeHorizon: string | null;
  /** When it should be looked at again regardless. */
  readonly reviewDate: string | null;
};

export type DecisionOwner = {
  readonly kind: 'PERSON' | 'ROLE' | 'FUNCTION';
  readonly label: string;
  readonly userId: UserId | null;
};

export type Decision = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly title: string;
  /**
   * The one thing being decided, as a question. "How should we fulfil the
   * Rohto order given constrained SKU-X inventory?" — never "Decision:
   * Inventory". A later intelligence layer has to know what was asked.
   */
  readonly managementQuestion: string;
  readonly context: string;
  readonly problem: string;
  readonly scope: string;
  readonly triggerType: DecisionTriggerType;
  readonly triggerRefs: readonly TriggerRef[];
  readonly state: DecisionState;
  readonly owner: DecisionOwner | null;
  /** The business/knowledge boundary the decision is framed at. */
  readonly fork: ForkPoint;
  readonly horizon: DecisionHorizon;
  readonly objectives: readonly string[];
  readonly reversibility: Reversibility;
  readonly reversalWindowDays: number | null;
  readonly authorityStatus: AuthorityStatus;
  readonly createdBy: UserId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
};

// --------------------------------------------------------------- revisions

export const decisionRevisionStates = ['DRAFT', 'SEALED'] as const;
export type DecisionRevisionState = (typeof decisionRevisionStates)[number];

export const decisionRevisionReasons = ['OPENED', 'REVISED', 'RECONSIDERED'] as const;
export type DecisionRevisionReason = (typeof decisionRevisionReasons)[number];

/**
 * One preparation state. Everything a decision is "made of" hangs off a
 * revision, so that sealing one freezes the whole basis at once rather than
 * table by table.
 */
export type DecisionRevision = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly revisionNumber: number;
  readonly state: DecisionRevisionState;
  readonly reason: DecisionRevisionReason;
  readonly basedOnRevisionId: string | null;
  /** Set when this revision exists because an earlier commitment was reconsidered. */
  readonly reconsidersCommitmentId: string | null;
  readonly reconsiderationReason: string | null;
  /** The knowledge boundary this preparation was done under. */
  readonly fork: ForkPoint;
  readonly notes: string | null;
  readonly createdBy: UserId | null;
  readonly createdAt: string;
  readonly sealedAt: string | null;
};

// ------------------------------------------------------------ alternatives

/**
 *   MODELLED    bound to a scenario revision and a completed simulation
 *   UNMODELLED  a real option HELM cannot yet compute a future for. Recorded
 *               as such rather than given invented numbers (§8).
 *   WITHDRAWN   considered and taken off the table before the commitment. It
 *               stays visible: what was dropped, and when, is management history.
 */
export const alternativeStatuses = ['MODELLED', 'UNMODELLED', 'WITHDRAWN'] as const;
export type AlternativeStatus = (typeof alternativeStatuses)[number];

export type DecisionAlternative = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly revisionId: string;
  readonly label: string;
  readonly description: string;
  readonly status: AlternativeStatus;
  /** The scenario branch this alternative IS. Null while UNMODELLED. */
  readonly scenarioId: string | null;
  readonly scenarioRevisionId: string | null;
  /** The simulation whose future state is this alternative's evidence. */
  readonly scenarioRunId: string | null;
  /** Why no future state exists, when UNMODELLED. */
  readonly unmodelledReason: string | null;
  readonly sort: number;
  readonly createdBy: UserId | null;
  readonly createdAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
};

// ---------------------------------------------------------------- criteria

/**
 *   HARD_CONSTRAINT   an explicit requirement: coverage >= 90%. Failing it is
 *                     a stated violation, not a low score.
 *   TARGET            a level management is aiming at: GM% >= 35.
 *   PREFERENCE        a direction, with no line: higher service is preferred.
 *                     HELM reports the values and the direction; it does not
 *                     rank them.
 *   QUALITATIVE       judged by a person, with a rationale. Never fabricated.
 *   OPTIONAL_WEIGHTED a quantitative input management chose to weight. A
 *                     weight is only ever management's own number.
 */
export const criterionStyles = [
  'HARD_CONSTRAINT',
  'TARGET',
  'PREFERENCE',
  'QUALITATIVE',
  'OPTIONAL_WEIGHTED',
] as const;
export type CriterionStyle = (typeof criterionStyles)[number];

/** Which way is better for this criterion, as management states it. */
export const criterionDirections = ['HIGHER_IS_BETTER', 'LOWER_IS_BETTER', 'NONE'] as const;
export type CriterionDirection = (typeof criterionDirections)[number];

export type CriterionAuthor = {
  readonly kind: 'PERSON' | 'ROLE' | 'FUNCTION' | 'POLICY';
  readonly label: string;
  readonly userId: UserId | null;
};

export type DecisionCriterion = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly revisionId: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly style: CriterionStyle;
  /** Required criteria must be evaluable or assessed before readiness is clean. */
  readonly required: boolean;
  /** The value metric this criterion reads, when it is measurable. */
  readonly metricKey: string | null;
  /** Which value node, where a metric sits on several subjects. */
  readonly subjectHint: string | null;
  /** Exact decimal. The line for HARD_CONSTRAINT and TARGET. */
  readonly threshold: string | null;
  readonly unit: QuantityUnit | null;
  readonly direction: CriterionDirection;
  /** Only for OPTIONAL_WEIGHTED, and only ever management's own number. */
  readonly weight: string | null;
  /** Who says this matters — never a system default. */
  readonly author: CriterionAuthor;
  readonly rationale: string;
  /** True when the threshold is demo seed data rather than a real policy. */
  readonly demoPolicy: boolean;
  readonly sort: number;
  readonly createdAt: string;
};

/**
 * A qualitative rating of one alternative against one criterion, by a person,
 * with a reason and a timestamp. HELM never produces one of these itself.
 */
export const qualitativeRatings = [
  'STRONG_SUPPORT',
  'SUPPORT',
  'NEUTRAL',
  'CONCERN',
  'STRONG_CONCERN',
] as const;
export type QualitativeRating = (typeof qualitativeRatings)[number];

export type CriterionAssessment = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly revisionId: string;
  readonly criterionId: string;
  readonly alternativeId: string;
  readonly rating: QualitativeRating;
  readonly rationale: string;
  readonly author: CriterionAuthor;
  readonly assessedAt: string;
};

/**
 * Criterion evaluation results. Statements of fact about an alternative
 * against a stated line — never a judgement about the alternative as a whole.
 */
export const criterionOutcomes = [
  'SATISFIED',
  'VIOLATED',
  'MEETS_TARGET',
  'MISSES_TARGET',
  'STATED',
  'ASSESSED',
  'NOT_ASSESSED',
  'UNKNOWN',
] as const;
export type CriterionOutcome = (typeof criterionOutcomes)[number];

export type CriterionEvaluation = {
  readonly criterionId: string;
  readonly criterionKey: string;
  readonly criterionName: string;
  readonly style: CriterionStyle;
  readonly alternativeId: string;
  readonly alternativeLabel: string;
  readonly outcome: CriterionOutcome;
  /** The alternative's value for the criterion's metric, exact. */
  readonly value: string | null;
  readonly unit: QuantityUnit | null;
  readonly currency: string | null;
  readonly threshold: string | null;
  readonly origin: ValueOrigin | null;
  readonly confidence: Confidence | null;
  /** Where the number came from, so the evaluation is traceable. */
  readonly nodeId: string | null;
  readonly period: Period | null;
  /** The authored assessment, for QUALITATIVE criteria. */
  readonly assessment: CriterionAssessment | null;
  /** Always present: why this outcome, in a sentence a manager can read. */
  readonly explanation: string;
};

/**
 * Aggregating criteria into one number requires management to say HOW. There
 * is no default method and no default weight; without this record, a weighted
 * view is refused rather than invented (§12).
 */
export type ManagementWeighting = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly revisionId: string;
  readonly method: string;
  readonly rationale: string;
  readonly author: CriterionAuthor;
  readonly declaredAt: string;
};

export type WeightedContribution = {
  readonly criterionId: string;
  readonly criterionName: string;
  readonly weight: string;
  readonly normalizedValue: string | null;
  readonly contribution: string | null;
  readonly note: string | null;
};

/**
 * A weighted view of the alternatives — computed ONLY when a
 * ManagementWeighting exists, and labelled with its author everywhere it is
 * shown. It is management's arithmetic, not HELM's opinion.
 */
export type WeightedView = {
  readonly weighting: ManagementWeighting;
  readonly perAlternative: readonly {
    readonly alternativeId: string;
    readonly alternativeLabel: string;
    readonly contributions: readonly WeightedContribution[];
    readonly total: string | null;
    readonly incomplete: boolean;
  }[];
  readonly statement: string;
};

// ------------------------------------------------------------- assumptions

export const assumptionOwnerKinds = ['PERSON', 'ROLE', 'FUNCTION', 'SYSTEM_MODEL'] as const;
export type AssumptionOwnerKind = (typeof assumptionOwnerKinds)[number];

export type AssumptionOwner = {
  readonly kind: AssumptionOwnerKind;
  readonly label: string;
  readonly userId: UserId | null;
};

export const assumptionCriticalities = ['CRITICAL', 'MATERIAL', 'MINOR'] as const;
export type AssumptionCriticality = (typeof assumptionCriticalities)[number];

/** How the assumption turned out. The seed of outcome review — not a score. */
export const assumptionOutcomes = [
  'PENDING',
  'CONFIRMED',
  'PARTIALLY_CONFIRMED',
  'DISPROVED',
  'UNKNOWN',
] as const;
export type AssumptionOutcome = (typeof assumptionOutcomes)[number];

/**
 * A management-level belief. Scenario-level assumptions already exist as
 * scenario overrides; this REFERENCES them rather than copying them, and adds
 * the ones no scenario models ("the relationship has strategic priority").
 */
export type DecisionAssumption = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly revisionId: string;
  readonly statement: string;
  /** Who stands behind it. Required: an unowned assumption is a readiness gap. */
  readonly owner: AssumptionOwner | null;
  readonly source: string;
  readonly rationale: string;
  readonly confidence: Confidence | null;
  readonly criticality: AssumptionCriticality;
  /** The scenario override that models this assumption, when one does. */
  readonly scenarioRevisionId: string | null;
  readonly scenarioOverrideId: string | null;
  /** Alternatives this assumption is specific to; empty means all of them. */
  readonly alternativeIds: readonly string[];
  readonly outcome: AssumptionOutcome;
  readonly outcomeNote: string | null;
  readonly createdBy: UserId | null;
  readonly createdAt: string;
};

// -------------------------------------------------------------- challenges

export const challengeTargetKinds = ['ASSUMPTION', 'CRITERION', 'ALTERNATIVE', 'CONTEXT'] as const;
export type ChallengeTargetKind = (typeof challengeTargetKinds)[number];

/**
 *   OPEN           raised, unresolved. A decision may still be committed over
 *                  it — management is allowed to proceed under uncertainty, so
 *                  long as the uncertainty is on the record.
 *   RESOLVED       answered, with a resolution
 *   ACCEPTED_RISK  not answered; management knowingly carries it
 *   REJECTED       considered and set aside, with a reason
 */
export const challengeStatuses = ['OPEN', 'RESOLVED', 'ACCEPTED_RISK', 'REJECTED'] as const;
export type ChallengeStatus = (typeof challengeStatuses)[number];

export type DecisionChallenge = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly revisionId: string;
  readonly targetKind: ChallengeTargetKind;
  readonly targetId: string | null;
  readonly author: CriterionAuthor;
  readonly concern: string;
  readonly evidenceId: string | null;
  readonly status: ChallengeStatus;
  readonly resolution: string | null;
  readonly resolvedBy: UserId | null;
  readonly resolvedAt: string | null;
  readonly raisedAt: string;
};

// ---------------------------------------------------------------- evidence

export const evidenceKinds = [
  'SCENARIO_FUTURE_STATE',
  'SOURCE_OBSERVATION',
  'CALCULATION',
  'CUSTOMER_COMMUNICATION',
  'MARKET_SIGNAL',
  'SUPPLIER_COMMITMENT',
  'POLICY',
  'HISTORICAL_DECISION',
  'MANAGEMENT_JUDGEMENT',
  'EXTERNAL_DOCUMENT',
] as const;
export type EvidenceKind = (typeof evidenceKinds)[number];

export const evidenceRelations = ['SUPPORT', 'CHALLENGE', 'CONTEXTUALIZE', 'INVALIDATE'] as const;
export type EvidenceRelation = (typeof evidenceRelations)[number];

export const evidenceTargetKinds = ['ASSUMPTION', 'CRITERION', 'ALTERNATIVE', 'CONTEXT'] as const;
export type EvidenceTargetKind = (typeof evidenceTargetKinds)[number];

/**
 * Evidence is a relationship, not an attachment: it always says WHAT it bears
 * on and HOW. Its two times are the Phase 3 lenses — when it was true, and
 * when HELM learned it.
 */
export type DecisionEvidence = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly revisionId: string;
  readonly kind: EvidenceKind;
  readonly title: string;
  readonly detail: string;
  readonly relation: EvidenceRelation;
  readonly targetKind: EvidenceTargetKind;
  readonly targetId: string | null;
  readonly sourceSystem: string;
  /** An id in the source system, or a HELM ref: run id, observation id, node id. */
  readonly sourceRef: string | null;
  readonly effectiveAt: string | null;
  readonly recordedAt: string;
  readonly confidence: Confidence | null;
  readonly author: CriterionAuthor | null;
  readonly createdAt: string;
};

// --------------------------------------------------------------- readiness

/**
 * Procedural completeness only. There is no readiness score: a number would
 * imply that 76% ready is a meaningful state, and it is not — either a
 * specific thing is missing or it is not.
 */
export const readinessStates = ['READY', 'READY_WITH_GAPS', 'NOT_READY'] as const;
export type ReadinessState = (typeof readinessStates)[number];

export const gapSeverities = ['BLOCKING', 'GAP'] as const;
export type GapSeverity = (typeof gapSeverities)[number];

export type ReadinessGap = {
  readonly code: string;
  readonly severity: GapSeverity;
  readonly message: string;
  readonly alternativeId?: string;
  readonly criterionId?: string;
  readonly assumptionId?: string;
  readonly challengeId?: string;
};

export type ReadinessReport = {
  readonly decisionId: string;
  readonly revisionId: string;
  readonly state: ReadinessState;
  readonly gaps: readonly ReadinessGap[];
  readonly evaluatedAt: string;
  readonly statement: string;
};

// -------------------------------------------------------------- trade-offs

/**
 * One factual difference between two alternatives on one criterion or metric,
 * phrased as a gain or a concession relative to the reference alternative.
 * Which concessions are acceptable is a management question, and HELM does not
 * answer it.
 */
export type TradeOffLine = {
  readonly criterionId: string | null;
  readonly label: string;
  readonly metricKey: string | null;
  readonly referenceValue: string | null;
  readonly alternativeValue: string | null;
  readonly delta: string | null;
  readonly unit: QuantityUnit | null;
  readonly currency: string | null;
  readonly directionality: Directionality | CriterionDirection | null;
  /** GAIN / CONCESSION / SAME / UNRESOLVED — relative to the reference, factually. */
  readonly kind: 'GAIN' | 'CONCESSION' | 'SAME' | 'UNRESOLVED';
  readonly note: string | null;
};

export type TradeOffColumn = {
  readonly alternativeId: string;
  readonly alternativeLabel: string;
  readonly status: AlternativeStatus;
  readonly completeness: Completeness | null;
  readonly gains: readonly TradeOffLine[];
  readonly concessions: readonly TradeOffLine[];
  readonly unresolved: readonly TradeOffLine[];
};

/**
 * A factual dominance statement: on every criterion that could be evaluated
 * for both, X is at least as good and strictly better somewhere. It is a fact
 * about the current model, stated with its own limits, and it stops there —
 * HELM never turns it into "choose X".
 */
export type DominanceStatement = {
  readonly alternativeId: string;
  readonly overAlternativeId: string;
  readonly betterOn: readonly string[];
  readonly equalOn: readonly string[];
  readonly notComparableOn: readonly string[];
  readonly statement: string;
};

export type TradeOffSpace = {
  readonly decisionId: string;
  readonly revisionId: string;
  readonly referenceAlternativeId: string | null;
  readonly columns: readonly TradeOffColumn[];
  readonly dominance: readonly DominanceStatement[];
  /** Carried straight through from the scenario comparison. */
  readonly comparability: ScenarioComparison['comparability'];
  readonly statement: string;
};

// ------------------------------------------------------------- commitment

/** One reason, tied to the thing that justifies it. */
export type RationaleItem = {
  readonly kind: 'CRITERION' | 'SCENARIO_DELTA' | 'ASSUMPTION' | 'EVIDENCE' | 'JUDGEMENT';
  readonly ref: string | null;
  readonly label: string;
  readonly statement: string;
};

export type AcceptedTradeOff = {
  readonly label: string;
  readonly statement: string;
  readonly criterionId: string | null;
  readonly metricKey: string | null;
  readonly givenUp: string | null;
  readonly inFavourOf: string | null;
};

/**
 * What management expects. It REFERENCES the chosen future state's values
 * rather than restating numbers, so "expected" and "what the model said" can
 * never disagree.
 */
export type ExpectedOutcome = {
  readonly label: string;
  readonly kind: 'MODELLED' | 'QUALITATIVE';
  readonly nodeId: string | null;
  readonly metricKey: string | null;
  readonly period: Period | null;
  /** Copied from the frozen future state at commitment, for display without a re-run. */
  readonly expectedValue: string | null;
  readonly unit: QuantityUnit | null;
  readonly currency: string | null;
  readonly statement: string | null;
};

export type ReviewTrigger = {
  readonly key: string;
  readonly description: string;
  readonly kind: 'METRIC_THRESHOLD' | 'EVENT' | 'DATE' | 'ASSUMPTION_BREAK';
  readonly metricKey: string | null;
  readonly comparator: 'ABOVE' | 'BELOW' | 'EQUALS' | null;
  readonly threshold: string | null;
  readonly byDate: string | null;
};

/** Who authored the commitment — and explicitly, whether HELM had any part in it. */
export const commitmentAuthorships = ['MANAGEMENT_AUTHORED', 'MANAGEMENT_AUTHORED_DEMO'] as const;
export type CommitmentAuthorship = (typeof commitmentAuthorships)[number];

export type DecisionCommitment = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly revisionId: string;
  readonly chosenAlternativeId: string;
  readonly authorship: CommitmentAuthorship;
  readonly committedBy: UserId | null;
  readonly committedByLabel: string;
  readonly committedAt: string;
  readonly summary: string;
  readonly rationale: readonly RationaleItem[];
  readonly acceptedTradeOffs: readonly AcceptedTradeOff[];
  readonly expectedOutcomes: readonly ExpectedOutcome[];
  readonly reviewTriggers: readonly ReviewTrigger[];
  /** Always NOT_EVALUATED in Phase 5. */
  readonly authorityStatus: AuthorityStatus;
  readonly fingerprint: string;
  readonly snapshotId: string;
};

/**
 * The frozen evidence manifest: exactly what was on the table when management
 * committed, by reference and by fingerprint. Never rewritten — a later model
 * change, a later forecast and a later rebase all leave it alone.
 */
export type CommitmentSnapshot = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly revisionId: string;
  readonly capturedAt: string;
  readonly fork: ForkPoint;
  readonly modelRef: ModelRef | null;
  readonly alternatives: readonly {
    readonly alternativeId: string;
    readonly label: string;
    readonly status: AlternativeStatus;
    readonly scenarioId: string | null;
    readonly scenarioKey: string | null;
    readonly scenarioRevisionId: string | null;
    readonly scenarioRunId: string | null;
    readonly scenarioFingerprint: string | null;
    readonly completeness: Completeness | null;
    readonly chosen: boolean;
  }[];
  readonly criterionIds: readonly string[];
  readonly assumptionIds: readonly string[];
  readonly challengeIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly criterionEvaluations: readonly CriterionEvaluation[];
  readonly openChallenges: readonly string[];
  readonly fingerprint: string;
};

// ----------------------------------------------------------- action intent

export const actionIntentStatuses = ['INTENDED', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;
export type ActionIntentStatus = (typeof actionIntentStatuses)[number];

/**
 * What management intends to happen next. Deliberately thin: HELM records the
 * intent and who owns it; the system that actually does the work — Memoire for
 * commercial activity, ERP for a transfer — remains the system of execution.
 */
export type ActionIntent = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly commitmentId: string;
  readonly title: string;
  readonly detail: string;
  readonly ownerLabel: string;
  readonly ownerUserId: UserId | null;
  readonly dueDate: string | null;
  readonly status: ActionIntentStatus;
  /** 'memoire' | 'erp' | 'scm' | 'finance' | 'helm' | 'manual' — where it will be done. */
  readonly targetSystem: string;
  /** Set only if a connector ever hands it over. Phase 5 writes nothing outward. */
  readonly handoffRef: string | null;
  readonly createdAt: string;
};

/**
 * The integration contract Phase 5 defines and does not call: what a connector
 * would receive when a decision is committed. No cross-system write happens
 * here — the shape is the deliverable.
 */
export type DecisionCommittedEvent = {
  readonly type: 'DecisionCommitted';
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly managementQuestion: string;
  readonly commitmentId: string;
  readonly commitmentFingerprint: string;
  readonly chosenAlternative: { readonly id: string; readonly label: string; readonly scenarioKey: string | null };
  readonly committedAt: string;
  readonly committedByLabel: string;
  readonly actionIntents: readonly ActionIntent[];
  readonly targetSystems: readonly string[];
};

// ----------------------------------------------------------- outcome review

export type OutcomeVariance = {
  readonly label: string;
  readonly metricKey: string | null;
  readonly nodeId: string | null;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly variance: string | null;
  readonly unit: QuantityUnit | null;
  readonly currency: string | null;
  readonly note: string | null;
};

export type AssumptionResult = {
  readonly assumptionId: string;
  readonly statement: string;
  readonly outcome: AssumptionOutcome;
  readonly evidenceId: string | null;
  readonly note: string | null;
};

/**
 * Expected vs actual. It reports variance and how the assumptions turned out;
 * it does NOT conclude that the decision was good or bad. A well-reasoned
 * decision can produce a poor outcome and a careless one can get lucky — see
 * docs/architecture/decision-quality-vs-outcome.md.
 */
export type DecisionOutcomeReview = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly commitmentId: string;
  readonly reviewedAt: string;
  readonly reviewedByLabel: string;
  readonly variances: readonly OutcomeVariance[];
  readonly assumptionResults: readonly AssumptionResult[];
  readonly notes: string;
  readonly statement: string;
};

// --------------------------------------------------------------- timeline

export const decisionEventTypes = [
  'DECISION_OPENED',
  'STATE_CHANGED',
  'ALTERNATIVE_ADDED',
  'ALTERNATIVE_WITHDRAWN',
  'SCENARIO_BOUND',
  'CRITERION_ADDED',
  'ASSESSMENT_RECORDED',
  'ASSUMPTION_ADDED',
  'ASSUMPTION_CHALLENGED',
  'CHALLENGE_RESOLVED',
  'EVIDENCE_ADDED',
  'READINESS_EVALUATED',
  'REVISION_SEALED',
  'COMMITTED',
  'ACTION_INTENT_ADDED',
  'ACTION_INTENT_STATUS_CHANGED',
  'RECONSIDERED',
  'OUTCOME_REVIEWED',
] as const;
export type DecisionEventType = (typeof decisionEventTypes)[number];

export type DecisionTimelineEvent = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly eventType: string;
  readonly actorId: UserId | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly recordedAt: string;
};

// ------------------------------------------------------------ explanation

/**
 * "Why did management choose B?" — answered all the way down. Each layer is a
 * reference into something that already exists, so nothing here is a retelling.
 */
export type DecisionExplanation = {
  readonly decision: Decision;
  readonly commitment: DecisionCommitment;
  readonly snapshot: CommitmentSnapshot;
  readonly chosen: DecisionAlternative;
  readonly rejected: readonly DecisionAlternative[];
  readonly rationale: readonly RationaleItem[];
  readonly acceptedTradeOffs: readonly AcceptedTradeOff[];
  readonly criterionEvaluations: readonly CriterionEvaluation[];
  readonly assumptions: readonly DecisionAssumption[];
  readonly challenges: readonly DecisionChallenge[];
  readonly evidence: readonly DecisionEvidence[];
  /** The lineage of each expected outcome, into calculations and source facts. */
  readonly valueLineage: readonly ScenarioExplanation[];
  /** Evidence recorded after the commitment: shown, never folded in. */
  readonly evidenceAfterCommitment: readonly DecisionEvidence[];
  readonly statement: string;
};

// -------------------------------------------------------- state descriptor

/** Known / Assumed / Uncertain / Unknown, per §33. Nothing disappears. */
export const knowledgeQualities = ['KNOWN', 'ASSUMED', 'UNCERTAIN', 'UNKNOWN'] as const;
export type KnowledgeQuality = (typeof knowledgeQualities)[number];
