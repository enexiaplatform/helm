/**
 * The Management Genome vocabulary (ADR-0028).
 *
 * Organizational memory of how the enterprise meets situations: forms beliefs,
 * decides, accepts trade-offs and obtains outcomes. It is NOT a performance
 * ledger — nothing here scores a decision, ranks a manager or rates a person —
 * and it is NOT a knowledge base: an episode REFERENCES the immutable
 * artifacts of one management experience, it never copies them.
 *
 *          Decision Process Quality ≠ Outcome Quality
 */

import type { OrgId, UserId } from '@helm/shared';
import type { SensitivityClass, TwinLens } from '@helm/twin-runtime';
import type { CausalRefKind, CausalScope } from '@helm/causal-runtime';

export const GenomeErrors = {
  INVALID: 'genome.invalid_input',
  NOT_FOUND: 'genome.not_found',
  IMMUTABLE: 'genome.immutable',
  FORBIDDEN: 'genome.forbidden',
  NOT_KNOWN_AT_LENS: 'genome.not_known_at_lens',
  KNOWLEDGE_IN_FUTURE: 'genome.knowledge_in_future',
  HINDSIGHT_AS_SITUATION: 'genome.hindsight_as_situation',
  INCONSISTENT_STANCE: 'genome.inconsistent_stance',
  SELF_ENDORSEMENT: 'genome.self_endorsement',
  DUPLICATE: 'genome.duplicate',
} as const;

export type GenomeLens = TwinLens;
export type GenomeScope = CausalScope;

/** A pointer to something that already exists — the episode holds references, never copies. */
export type GenomeRefKind = CausalRefKind | 'CAUSAL_CLAIM' | 'MANAGEMENT_EPISODE' | 'MANAGEMENT_PATTERN' | 'COUNTERFACTUAL_CASE';
export type GenomeRef = {
  readonly kind: GenomeRefKind;
  readonly id: string;
  /** Version, fingerprint, decision id or record time that pins which state was meant. */
  readonly pin: string | null;
  readonly label: string | null;
};

// ---------------------------------------------------------------- situation

/**
 * The features similarity is defined over. Explicit, derived from kernel
 * records at the decision boundary, each one checkable. Nothing here is an
 * embedding, and there is no person among them (ADR-0028 §2, §8).
 */
export const featureNames = [
  'decisionType',
  'triggerType',
  'reversibility',
  'businessUnit',
  'country',
  'constraintKind',
  'expectedMetric',
  'overrideMetric',
  'customerClass',
] as const;
export type FeatureName = (typeof featureNames)[number];

/** The features a pattern may condition on (scope is stated separately, as a causal-style scope). */
export const conditionFeatures = ['decisionType', 'triggerType', 'reversibility', 'constraintKind', 'expectedMetric', 'overrideMetric', 'customerClass'] as const;
export type ConditionFeature = (typeof conditionFeatures)[number];
export type PatternConditions = Readonly<Partial<Record<ConditionFeature, readonly string[]>>>;

export type SituationFeatures = {
  /** Every feature holds a list; a feature the sources could not state is listed in `notStated`. */
  readonly values: Readonly<Record<FeatureName, readonly string[]>>;
  readonly notStated: readonly FeatureName[];
  /** Org-chain coordinates of the scope anchors: dimension → entity ids, at the decision boundary. */
  readonly placement: Readonly<Record<string, readonly string[]>>;
  /** Entity ids of the scope anchors (customers, products and units the decision was about). */
  readonly anchorIds: readonly string[];
};

// ---------------------------------------------------------------- episodes

/** What a bound reference IS to the episode. */
export const episodeRefRoles = [
  'SITUATION_SNAPSHOT',
  'COMMITTED_FUTURE',
  'OUTCOME_SNAPSHOT',
  'CAUSAL_CONTEXT',
  'GOVERNANCE_EVALUATION',
  'OUTCOME_REVIEW',
  /** A counterfactual case reviewing this episode's own decision — beside, never inside, how management decided and what happened (ADR-0029 §9). */
  'COUNTERFACTUAL_CASE',
] as const;
export type EpisodeRefRole = (typeof episodeRefRoles)[number];

/**
 * A durable container around ONE management experience. Its identity is small
 * and immutable; everything else is a reference bound later, append-only.
 */
export type ManagementEpisode = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly commitmentId: string | null;
  readonly title: string;
  readonly scope: GenomeScope;
  readonly situation: SituationFeatures;
  /** The knowledge boundary management decided under. Nothing recorded after it is situation. */
  readonly boundary: GenomeLens;
  /** Derived from the value metrics the commitment expects to move — never declared. */
  readonly sensitivityClasses: readonly SensitivityClass[];
  readonly visibility: 'ORG_WIDE' | 'RESTRICTED';
  readonly grantedUnitIds: readonly string[];
  readonly authoredBy: UserId | null;
  readonly authoredByLabel: string;
  readonly recordedAt: string;
};

export type EpisodeRef = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly episodeId: string;
  readonly role: EpisodeRefRole;
  readonly ref: GenomeRef;
  readonly note: string | null;
  readonly boundBy: UserId | null;
  readonly recordedAt: string;
};

// ---------------------------------------------------------------- patterns

export const outcomeDirections = ['ACTUAL_BELOW_EXPECTED', 'ACTUAL_ABOVE_EXPECTED', 'ACTUAL_EQUALS_EXPECTED'] as const;
export type OutcomeDirection = (typeof outcomeDirections)[number];
export const processFeatures = ['CRITICAL_ASSUMPTION_UNOWNED', 'CHALLENGE_OPEN_AT_COMMITMENT', 'ALTERNATIVE_UNMODELLED'] as const;
export type ProcessFeature = (typeof processFeatures)[number];
export const assumptionCriticalities = ['CRITICAL', 'MATERIAL', 'MINOR', 'ANY'] as const;
export const assumptionOutcomeKinds = ['DISPROVED', 'CONFIRMED', 'PARTIALLY_CONFIRMED'] as const;

/**
 * What a pattern says recurs. Three OBSERVABLE kinds, so HELM can check any
 * episode against it from its own records — it never guesses.
 */
export type PatternCharacteristic =
  | { readonly kind: 'OUTCOME_VS_EXPECTATION'; readonly metricKey: string; readonly direction: OutcomeDirection }
  | { readonly kind: 'ASSUMPTION_OUTCOME'; readonly criticality: (typeof assumptionCriticalities)[number]; readonly outcome: (typeof assumptionOutcomeKinds)[number] }
  | { readonly kind: 'PROCESS_FEATURE'; readonly feature: ProcessFeature };

/**
 * A structured hypothesis that similar situations produced a recurring
 * decision or outcome characteristic. Identity (immutable): scope, conditions,
 * characteristic. Never a universal law.
 */
export type ManagementPattern = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly title: string;
  readonly scope: GenomeScope;
  readonly conditions: PatternConditions;
  readonly characteristic: PatternCharacteristic;
  readonly visibility: 'ORG_WIDE' | 'RESTRICTED';
  readonly grantedUnitIds: readonly string[];
  readonly authoredBy: UserId | null;
  readonly authoredByLabel: string;
  readonly recordedAt: string;
};

/** What is said ABOUT a pattern, versioned. Append-only; the limitations are required. */
export type PatternRevision = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly patternId: string;
  readonly revision: number;
  readonly statement: string;
  readonly limitations: string;
  readonly retired: boolean;
  readonly retirementReason: string | null;
  readonly recordedBy: UserId | null;
  readonly recordedAt: string;
};

export const patternStances = ['SUPPORTING_EPISODE', 'CONTRADICTORY_EPISODE', 'CONTEXTUAL_EPISODE'] as const;
export type PatternStance = (typeof patternStances)[number];

export const classifications = ['SUPPORTS', 'CONTRADICTS', 'OUT_OF_SCOPE', 'NOT_OBSERVABLE'] as const;
export type Classification = (typeof classifications)[number];

/** A person's link of one episode to one pattern. Append-only; one per (pattern, episode). */
export type PatternEvidence = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly patternId: string;
  readonly episodeId: string;
  readonly stance: PatternStance;
  readonly rationale: string;
  /** What HELM's own records said when the link was made — the link must agree with it. */
  readonly observed: Classification;
  readonly linkedBy: UserId | null;
  readonly recordedAt: string;
};

export const patternStatuses = ['EMERGING', 'RECURRING', 'SUPPORTED', 'CONTESTED', 'RETIRED'] as const;
export type PatternStatus = (typeof patternStatuses)[number];

// ---------------------------------------------------------------- lessons

/** A management-authored claim about what to remember. Inert: it changes no policy, model or belief. */
export type Lesson = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly claim: string;
  readonly scope: GenomeScope;
  /** At least one episode or pattern the lesson rests on. */
  readonly evidence: readonly GenomeRef[];
  readonly visibility: 'ORG_WIDE' | 'RESTRICTED';
  readonly grantedUnitIds: readonly string[];
  readonly authoredBy: UserId | null;
  readonly authoredByLabel: string;
  readonly recordedAt: string;
};

export const lessonStatuses = ['PROPOSED', 'ENDORSED', 'DISPUTED', 'RETIRED'] as const;
export type LessonStatus = (typeof lessonStatuses)[number];

/** A review of a lesson. Append-only. PROPOSED is the absence of a review. */
export type LessonReview = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly lessonId: string;
  readonly status: Exclude<LessonStatus, 'PROPOSED'>;
  readonly note: string;
  readonly reviewedBy: UserId | null;
  readonly reviewedByLabel: string;
  readonly recordedAt: string;
};
