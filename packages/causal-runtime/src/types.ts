/**
 * The Enterprise Causal Graph vocabulary (ADR-0026, ADR-0027).
 *
 * HELM holds several graphs and this module keeps them apart:
 *
 *   semantic graph        what exists and how it is related        (graph-store)
 *   calculation graph     which model input moves which output     (propagation-engine)
 *   causal graph          what the enterprise has EVIDENCE to believe influences
 *                         real-world outcomes                       (this package)
 *
 *                 CALCULATION_DEPENDENCY ≠ CAUSAL_RELATIONSHIP
 *
 * A causal claim is never created, supported or strengthened by a calculation
 * dependency, a correlation, a co-movement in a twin delta or a temporal
 * sequence. It is authored by a person, scoped, and judged only by the
 * evidence linked to it, under a named policy.
 */

import type { OrgId, UserId } from '@helm/shared';
import type { RefKind, SensitivityClass, TwinLens } from '@helm/twin-runtime';

export const CausalErrors = {
  INVALID: 'causal.invalid_input',
  NOT_FOUND: 'causal.not_found',
  IMMUTABLE: 'causal.immutable',
  FORBIDDEN: 'causal.forbidden',
  UNSCOPED: 'causal.unscoped_claim',
  NOT_KNOWN_AT_LENS: 'causal.not_known_at_lens',
  KNOWLEDGE_IN_FUTURE: 'causal.knowledge_in_future',
  TRAVERSAL_UNBOUNDED: 'causal.traversal_unbounded',
  DUPLICATE_LINK: 'causal.duplicate_link',
  CORRELATION_IS_NOT_CAUSATION: 'causal.correlation_is_not_causation',
} as const;

export type CausalLens = TwinLens;

/**
 * A pointer from causal knowledge into the rest of HELM: the twin's kernel
 * references, plus the three things only causal knowledge points at — a twin
 * snapshot as a whole, a source document behind evidence, a correlation finding.
 */
export type CausalRefKind = RefKind | 'TWIN_SNAPSHOT' | 'SOURCE_DOCUMENT' | 'CORRELATION_FINDING';
export type KernelRef = {
  readonly kind: CausalRefKind;
  readonly id: string;
  /** Version, fingerprint, decision id (for an ASSUMPTION) or record time. */
  readonly pin: string | null;
  readonly label: string | null;
};

// ---------------------------------------------------------------- variables

/** What a node of the causal graph is. A METRIC variable is bound to a value metric; the rest are named factors. */
export const variableKinds = ['METRIC', 'ACTION', 'CONDITION', 'EVENT', 'OUTCOME'] as const;
export type VariableKind = (typeof variableKinds)[number];

export type CausalVariable = {
  readonly id: string;
  readonly orgId: OrgId;
  /** Stable per organization: 'FULFILMENT_COST', 'EXPEDITED_TRANSFER'. */
  readonly key: string;
  readonly label: string;
  readonly kind: VariableKind;
  /** Only for METRIC variables: the value metric the variable denotes. */
  readonly metricKey: string | null;
  readonly description: string;
  /** Derived for METRIC variables (the metric's class) unless declared; declared otherwise. */
  readonly sensitivity: SensitivityClass;
  readonly refs: readonly KernelRef[];
  readonly recordedBy: UserId | null;
  readonly recordedAt: string;
};

// ---------------------------------------------------------------- claims

/**
 * A deliberately small vocabulary. There is no CAUSES: an unconditional
 * "X causes Y" asserts more than evidence usually carries. MEDIATES and
 * MODERATES qualify another claim and must name it.
 */
export const relationshipTypes = ['INCREASES', 'DECREASES', 'ENABLES', 'CONSTRAINS', 'DELAYS', 'ACCELERATES', 'MEDIATES', 'MODERATES'] as const;
export type CausalRelationshipType = (typeof relationshipTypes)[number];
export const QUALIFYING_TYPES: readonly CausalRelationshipType[] = ['MEDIATES', 'MODERATES'];

export type ScopeAnchor = { readonly entityId: string; readonly label: string; readonly dimension: string };

/**
 * Where a claim is believed to hold. Never global by default: an
 * ENTERPRISE_WIDE claim must say why it generalizes.
 */
export type CausalScope =
  | { readonly kind: 'ANCHORED'; readonly anchors: readonly ScopeAnchor[] }
  | { readonly kind: 'ENTERPRISE_WIDE'; readonly justification: string };

/** An explicit applicability condition ("WHEN air freight is required"). Text, not a rule engine. */
export type ApplicabilityCondition = { readonly statement: string; readonly refs: readonly KernelRef[] };

/** Business time the claim is about. Null ends are open. */
export type ApplicablePeriod = { readonly from: string | null; readonly to: string | null };

/**
 * A causal claim's IDENTITY: cause, effect, relationship, scope, context and
 * validity. Immutable. A claim with different scope or conditions is a
 * different claim, however similar its cause and effect — claims are never
 * de-duplicated on cause and effect alone.
 */
export type CausalClaim = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly causeKey: string;
  readonly effectKey: string;
  readonly relationshipType: CausalRelationshipType;
  /** The claim a MEDIATES / MODERATES claim qualifies. Null otherwise. */
  readonly targetClaimId: string | null;
  readonly scope: CausalScope;
  readonly conditions: readonly ApplicabilityCondition[];
  readonly applicablePeriod: ApplicablePeriod;
  /** The class the author declared; the claim's effective classes also include its variables' and its evidence's. */
  readonly sensitivity: SensitivityClass;
  readonly visibility: 'ORG_WIDE' | 'RESTRICTED';
  readonly grantedUnitIds: readonly string[];
  readonly authoredBy: UserId | null;
  readonly authoredByLabel: string;
  readonly recordedAt: string;
};

export type MechanismStep = { readonly variableKey: string | null; readonly description: string };
/** How X is believed to affect Y: ordered steps, optional when unknown. Versioned with the claim's revisions. */
export type CausalMechanism = readonly MechanismStep[];
/** A candidate common cause that threatens the claim, stated explicitly — never inferred. */
export type Confounder = { readonly variableKey: string; readonly note: string };
/** Where and when a claim is believed to hold: part of its identity (see CausalClaim). */
export type CausalContext = {
  readonly scope: CausalScope;
  readonly conditions: readonly ApplicabilityCondition[];
  readonly applicablePeriod: ApplicablePeriod;
};

/**
 * What is said ABOUT a claim, versioned. Append-only: revision n+1 supersedes
 * revision n from its record time on; revision n stays readable for any lens
 * before that. Retirement is a revision.
 */
export type ClaimRevision = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly claimId: string;
  readonly revision: number;
  readonly statement: string;
  readonly mechanism: readonly MechanismStep[];
  readonly confounders: readonly Confounder[];
  readonly rationale: string;
  /** e.g. "Supported in this scope; external validity unknown." */
  readonly externalValidity: string;
  /** Lineage: entities, value nodes, twin snapshots, decisions, assumptions, scenarios. */
  readonly links: readonly KernelRef[];
  readonly retired: boolean;
  readonly retirementReason: string | null;
  readonly recordedBy: UserId | null;
  readonly recordedAt: string;
};

// ---------------------------------------------------------------- evidence

/** Ordered roughly by evidentiary strength; the ceilings are in policy.ts (ADR-0027). */
export const evidenceTypes = [
  'CONTROLLED_EXPERIMENT',
  'NATURAL_EXPERIMENT',
  'INTERVENTION',
  'LONGITUDINAL_OBSERVATION',
  'REPEATED_PATTERN',
  'STATISTICAL_ANALYSIS',
  'PROCESS_MECHANISM',
  'EXTERNAL_RESEARCH',
  'MANAGEMENT_EXPERTISE',
  'CONTRADICTORY_CASE',
] as const;
export type EvidenceType = (typeof evidenceTypes)[number];

export const strengthLevels = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type StrengthLevel = (typeof strengthLevels)[number];

export const provenanceMethods = ['DOCUMENT', 'MEASUREMENT', 'ANALYSIS', 'JUDGEMENT', 'EXTERNAL'] as const;
export type EvidenceMethod = (typeof provenanceMethods)[number];

/** Where it came from, who asserted it, and how. Every evidence item answers all of these. */
export type EvidenceProvenance = {
  readonly sourceSystem: string;
  readonly sourceReference: string;
  readonly method: EvidenceMethod;
  readonly assertedBy: UserId | null;
  readonly assertedByLabel: string;
  readonly assertedRole: string | null;
};

/** A statistical result is stored as reported, never computed here. */
export type StatisticalDetail = {
  readonly method: string;
  readonly population: string;
  readonly period: string;
  readonly effectEstimate: string;
  readonly uncertainty: string;
  readonly limitations: string;
};

export type CausalEvidence = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly type: EvidenceType;
  readonly statement: string;
  /** The assessor's grade; the policy caps it by type (ADR-0027). */
  readonly assessedStrength: StrengthLevel;
  readonly strengthRationale: string;
  readonly provenance: EvidenceProvenance;
  /** Business time the candidate cause and the effect were observed, where the evidence states them. */
  readonly causeObservedAt: string | null;
  readonly effectObservedAt: string | null;
  readonly statistical: StatisticalDetail | null;
  /** A correlation this evidence cites. Citing one caps the evidence at LOW. */
  readonly correlationFindingId: string | null;
  readonly refs: readonly KernelRef[];
  readonly sensitivity: SensitivityClass;
  /** A correction supersedes; it never edits. */
  readonly supersedesId: string | null;
  readonly recordedBy: UserId | null;
  readonly recordedAt: string;
};

export const evidenceStances = ['SUPPORTS', 'CHALLENGES', 'CONTRADICTS', 'CONTEXTUALIZES'] as const;
export type EvidenceStance = (typeof evidenceStances)[number];

/** What one piece of evidence is said to do to one claim. Append-only; one per (claim, evidence). */
export type EvidenceLink = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly claimId: string;
  readonly evidenceId: string;
  readonly stance: EvidenceStance;
  readonly rationale: string;
  readonly linkedBy: UserId | null;
  readonly recordedAt: string;
};

// ---------------------------------------------------------------- correlation

/**
 * CORRELATES_WITH — a different kind of statement, in a different store. There
 * is no path that turns a finding into a claim: a person may author a claim and
 * cite the finding as (LOW) evidence, and that is all.
 */
export type CorrelationFinding = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly xKey: string;
  readonly yKey: string;
  readonly direction: 'POSITIVE' | 'NEGATIVE' | 'NONE';
  readonly method: string;
  readonly population: string;
  readonly period: string;
  readonly effectEstimate: string;
  readonly uncertainty: string;
  readonly limitations: string;
  readonly scope: CausalScope;
  readonly refs: readonly KernelRef[];
  readonly sensitivity: SensitivityClass;
  readonly recordedBy: UserId | null;
  readonly recordedAt: string;
};

// ---------------------------------------------------------------- questions

export type QuestionTarget = {
  readonly variableKey: string;
  readonly metricKey: string | null;
  readonly nodeId: string | null;
  readonly fromSnapshotId: string | null;
  readonly toSnapshotId: string | null;
  readonly itemKey: string | null;
  readonly observedChange: string | null;
  readonly unit: string | null;
};

/** "Why did fulfilment cost rise?" — an analytical question, not a workflow. */
export type CausalQuestion = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly statement: string;
  readonly target: QuestionTarget;
  readonly scope: CausalScope;
  readonly period: ApplicablePeriod;
  readonly grantedUnitIds: readonly string[];
  readonly askedBy: UserId | null;
  readonly recordedAt: string;
};

/** A candidate explanation: always an existing claim, proposed by a person. HELM never proposes one. */
export type QuestionCandidate = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly questionId: string;
  readonly claimId: string;
  readonly rationale: string;
  readonly proposedBy: UserId | null;
  readonly recordedAt: string;
};

// ---------------------------------------------------------------- evaluation

export const claimStatuses = ['HYPOTHESIS', 'SUPPORTED', 'CONTESTED', 'WEAKENED', 'REFUTED', 'UNRESOLVED', 'RETIRED'] as const;
export type ClaimStatus = (typeof claimStatuses)[number];

/** Categorical, with reasons. Never a number (ADR-0027 §4). */
export const confidenceLevels = ['NONE', 'LOW', 'MODERATE', 'HIGH'] as const;
export type ConfidenceLevel = (typeof confidenceLevels)[number];

export type TemporalOrder = 'CAUSE_PRECEDES_EFFECT' | 'SIMULTANEOUS' | 'TEMPORAL_CONFLICT' | 'NOT_STATED';

export type EvidenceAssessment = {
  readonly link: EvidenceLink;
  /** The version of the evidence in force at the lens (the head of its correction chain). */
  readonly evidence: CausalEvidence;
  readonly ceiling: StrengthLevel;
  readonly strength: StrengthLevel;
  readonly strengthNote: string;
  readonly temporal: TemporalOrder;
  /** How the policy counted it. A SUPPORTS link in temporal conflict counts as a CHALLENGE. */
  readonly countedAs: 'SUPPORT' | 'CHALLENGE' | 'CONTRADICTION' | 'CONTEXT';
  readonly note: string | null;
};

export type ClaimEvaluation = {
  readonly claimId: string;
  readonly lens: CausalLens;
  readonly policy: string;
  readonly status: ClaimStatus;
  readonly confidence: ConfidenceLevel;
  readonly reasons: readonly string[];
  readonly assessments: readonly EvidenceAssessment[];
  readonly counts: { readonly supporting: number; readonly challenging: number; readonly contradicting: number; readonly contextual: number };
  readonly temporalConflicts: number;
  /** Whether the lens's business time falls inside the claim's applicable period. */
  readonly applicableAtEffective: boolean;
};
