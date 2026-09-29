/**
 * The CausalStore port (ADR-0026 §6) and the CausalGraph runtime interface.
 *
 * The store keeps records only — variables, claims, revisions, evidence,
 * links, correlation findings, questions and candidates — every one of them
 * append-only. A status is never stored: it is derived, at a lens, from the
 * records known at that lens, so "what did management believe on 30 Sep?" is
 * a query, not a copy. The store stamps record time itself; a caller cannot
 * back-date knowledge.
 *
 * No Postgres concept appears here.
 */

import type { Result, Scope } from '@helm/shared';
import type { OrgUnit } from '@helm/authority-runtime';
import type { SensitivityClass, TwinViewer } from '@helm/twin-runtime';
import type {
  ApplicabilityCondition,
  ApplicablePeriod,
  CausalClaim,
  CausalEvidence,
  CausalLens,
  CausalQuestion,
  CausalRelationshipType,
  CausalScope,
  CausalVariable,
  ClaimEvaluation,
  ClaimRevision,
  ClaimStatus,
  Confounder,
  CorrelationFinding,
  EvidenceAssessment,
  EvidenceLink,
  EvidenceMethod,
  EvidenceStance,
  EvidenceType,
  KernelRef,
  MechanismStep,
  QuestionCandidate,
  QuestionTarget,
  StatisticalDetail,
  StrengthLevel,
  VariableKind,
} from './types.ts';

export type NewVariable = Omit<CausalVariable, 'id' | 'orgId' | 'recordedAt'>;
export type NewClaim = Omit<CausalClaim, 'id' | 'orgId' | 'recordedAt'>;
export type NewRevision = Omit<ClaimRevision, 'id' | 'orgId' | 'claimId' | 'revision' | 'recordedAt'>;
export type NewEvidence = Omit<CausalEvidence, 'id' | 'orgId' | 'recordedAt'>;
export type NewLink = Omit<EvidenceLink, 'id' | 'orgId' | 'recordedAt'>;
export type NewCorrelation = Omit<CorrelationFinding, 'id' | 'orgId' | 'recordedAt'>;
export type NewQuestion = Omit<CausalQuestion, 'id' | 'orgId' | 'recordedAt'>;
export type NewCandidate = Omit<QuestionCandidate, 'id' | 'orgId' | 'recordedAt'>;

export interface CausalStore {
  /** Write-once. A key is unique per organization. */
  insertVariable(scope: Scope, input: NewVariable): Promise<Result<CausalVariable>>;
  listVariables(scope: Scope): Promise<Result<readonly CausalVariable[]>>;

  /** The claim's identity and its revision 1, together or not at all. */
  insertClaim(scope: Scope, claim: NewClaim, first: NewRevision): Promise<Result<{ claim: CausalClaim; revision: ClaimRevision }>>;
  /** Appends revision n+1. A retired claim takes no further revision. */
  insertRevision(scope: Scope, claimId: string, input: NewRevision): Promise<Result<ClaimRevision>>;
  getClaim(scope: Scope, id: string): Promise<Result<CausalClaim | null>>;
  listClaims(scope: Scope): Promise<Result<readonly CausalClaim[]>>;
  listRevisions(scope: Scope, claimId?: string): Promise<Result<readonly ClaimRevision[]>>;

  /** Write-once. A correction names what it supersedes; each item is superseded at most once. */
  insertEvidence(scope: Scope, input: NewEvidence): Promise<Result<CausalEvidence>>;
  listEvidence(scope: Scope): Promise<Result<readonly CausalEvidence[]>>;

  /** One link per (claim, evidence). A CONTRADICTORY_CASE never SUPPORTS. */
  insertLink(scope: Scope, input: NewLink): Promise<Result<EvidenceLink>>;
  listLinks(scope: Scope, claimId?: string): Promise<Result<readonly EvidenceLink[]>>;

  insertCorrelation(scope: Scope, input: NewCorrelation): Promise<Result<CorrelationFinding>>;
  listCorrelations(scope: Scope): Promise<Result<readonly CorrelationFinding[]>>;

  insertQuestion(scope: Scope, input: NewQuestion): Promise<Result<CausalQuestion>>;
  listQuestions(scope: Scope): Promise<Result<readonly CausalQuestion[]>>;
  insertCandidate(scope: Scope, input: NewCandidate): Promise<Result<QuestionCandidate>>;
  listCandidates(scope: Scope, questionId?: string): Promise<Result<readonly QuestionCandidate[]>>;
}

// ---------------------------------------------------------------- runtime inputs

export type DefineVariableInput = {
  key: string;
  label: string;
  kind: VariableKind;
  metricKey?: string | null;
  description?: string;
  /** For non-metric variables; a METRIC variable takes its metric's class unless this says otherwise. */
  sensitivity?: SensitivityClass;
  refs?: readonly KernelRef[];
};

export type CreateClaimInput = {
  causeKey: string;
  effectKey: string;
  relationshipType: CausalRelationshipType;
  targetClaimId?: string | null;
  scope: CausalScope;
  conditions?: readonly ApplicabilityCondition[];
  applicablePeriod?: ApplicablePeriod;
  sensitivity?: SensitivityClass;
  visibility?: 'ORG_WIDE' | 'RESTRICTED';
  grantedUnitIds?: readonly string[];
  authoredByLabel: string;
  statement: string;
  mechanism?: readonly MechanismStep[];
  confounders?: readonly Confounder[];
  rationale: string;
  externalValidity?: string;
  links?: readonly KernelRef[];
};

export type ReviseClaimInput = Partial<Pick<ClaimRevision, 'statement' | 'mechanism' | 'confounders' | 'rationale' | 'externalValidity' | 'links'>>;

export type RecordEvidenceInput = {
  type: EvidenceType;
  statement: string;
  assessedStrength: StrengthLevel;
  strengthRationale: string;
  provenance: {
    sourceSystem: string;
    sourceReference: string;
    method: EvidenceMethod;
    assertedBy?: string | null;
    assertedByLabel: string;
    assertedRole?: string | null;
  };
  causeObservedAt?: string | null;
  effectObservedAt?: string | null;
  statistical?: StatisticalDetail | null;
  correlationFindingId?: string | null;
  refs?: readonly KernelRef[];
  sensitivity?: SensitivityClass;
};

export type RecordCorrelationInput = Omit<NewCorrelation, 'recordedBy' | 'sensitivity' | 'refs'> & {
  sensitivity?: SensitivityClass;
  refs?: readonly KernelRef[];
};

export type AskQuestionInput = {
  statement: string;
  target: Partial<QuestionTarget> & { variableKey: string };
  scope: CausalScope;
  period?: ApplicablePeriod;
  grantedUnitIds?: readonly string[];
};

// ---------------------------------------------------------------- runtime outputs

export type Applicability = {
  readonly verdict: 'APPLIES' | 'APPLIES_TO_PART' | 'OUTSIDE' | 'UNPLACEABLE';
  readonly reason: string;
};

export type ClaimView = {
  readonly claim: CausalClaim;
  readonly revision: ClaimRevision;
  readonly cause: CausalVariable;
  readonly effect: CausalVariable;
  readonly evaluation: ClaimEvaluation;
};

/**
 * A relationship HELM's MODEL computes, reported beside — never inside — a
 * causal claim. Its existence is not evidence.
 */
export type ModelDependency = {
  readonly kind: 'KNOWN_VALUE_DEPENDENCY';
  readonly fromMetricKey: string;
  readonly toMetricKey: string;
  readonly calculations: readonly string[];
  readonly statement: string;
};

export type ClaimExplanation = {
  readonly view: ClaimView;
  readonly question: string;
  readonly mechanism: readonly MechanismStep[];
  readonly supporting: readonly EvidenceAssessment[];
  readonly challenging: readonly EvidenceAssessment[];
  readonly contradicting: readonly EvidenceAssessment[];
  readonly contextual: readonly EvidenceAssessment[];
  readonly scope: CausalScope;
  readonly conditions: readonly ApplicabilityCondition[];
  readonly applicablePeriod: ApplicablePeriod;
  readonly confounders: readonly Confounder[];
  readonly externalValidity: string;
  /** How the belief changed: the status at each moment something was learned. */
  readonly history: readonly { readonly recordedAt: string; readonly event: string; readonly status: ClaimStatus; readonly confidence: ClaimEvaluation['confidence'] }[];
  readonly modelDependency: ModelDependency | null;
  readonly lineage: readonly KernelRef[];
  readonly statement: string;
};

export type TraversalEdge = {
  readonly claimId: string;
  readonly from: string;
  readonly to: string;
  readonly relationshipType: CausalRelationshipType;
  readonly status: ClaimStatus;
  readonly confidence: ClaimEvaluation['confidence'];
  readonly depth: number;
  /** The edge leads back to a variable already reached: a feedback loop, kept, not followed. */
  readonly closesCycle: boolean;
};

export type Traversal = {
  readonly from: string;
  readonly direction: 'UPSTREAM' | 'DOWNSTREAM';
  readonly maxDepth: number;
  readonly variables: readonly { readonly key: string; readonly depth: number }[];
  readonly edges: readonly TraversalEdge[];
  /** Edges exist beyond maxDepth. */
  readonly truncated: boolean;
  readonly cycles: number;
};

export type CausalPath = {
  readonly variables: readonly string[];
  readonly steps: readonly TraversalEdge[];
  /** The weakest claim on the path — a path is never scored or multiplied. */
  readonly weakest: ClaimStatus;
  readonly statement: string;
};

export type CandidateView = {
  readonly candidate: QuestionCandidate | null;
  /** QUESTION: a person proposed it for this question. CLAIM_ON_TARGET: an existing claim whose effect is the question's variable. */
  readonly via: 'QUESTION' | 'CLAIM_ON_TARGET';
  readonly view: ClaimView;
  readonly applicability: Applicability | null;
};

export type QuestionInvestigation = {
  readonly question: CausalQuestion;
  readonly lens: CausalLens;
  readonly candidates: readonly CandidateView[];
  readonly status: 'OPEN' | 'UNRESOLVED' | 'SUPPORTED_EXPLANATION_EXISTS';
  readonly statement: string;
};

export type CausalView = {
  readonly lens: CausalLens;
  readonly claims: readonly ClaimView[];
};

export type ProjectedCausalView = {
  readonly claims: readonly ClaimView[];
  readonly withheld: number;
  readonly statement: string;
};

export type ClaimVisibilityFacts = {
  /** Can this viewer see decision `id`? The runtime never guesses — the host says. */
  decisionVisible: (decisionId: string) => boolean;
};

export interface CausalGraph {
  defineVariable(scope: Scope, input: DefineVariableInput): Promise<Result<CausalVariable>>;
  listVariables(scope: Scope): Promise<Result<readonly CausalVariable[]>>;

  createClaim(scope: Scope, input: CreateClaimInput): Promise<Result<ClaimView>>;
  reviseClaim(scope: Scope, claimId: string, input: ReviseClaimInput): Promise<Result<ClaimView>>;
  retireClaim(scope: Scope, claimId: string, reason: string): Promise<Result<ClaimView>>;

  recordEvidence(scope: Scope, input: RecordEvidenceInput): Promise<Result<CausalEvidence>>;
  correctEvidence(scope: Scope, evidenceId: string, input: RecordEvidenceInput): Promise<Result<CausalEvidence>>;
  linkEvidence(scope: Scope, claimId: string, evidenceId: string, stance: EvidenceStance, rationale: string): Promise<Result<ClaimView>>;
  supportClaim(scope: Scope, claimId: string, evidenceId: string, rationale: string): Promise<Result<ClaimView>>;
  challengeClaim(scope: Scope, claimId: string, evidenceId: string, rationale: string): Promise<Result<ClaimView>>;

  recordCorrelation(scope: Scope, input: RecordCorrelationInput): Promise<Result<CorrelationFinding>>;
  listCorrelations(scope: Scope): Promise<Result<readonly CorrelationFinding[]>>;

  askQuestion(scope: Scope, input: AskQuestionInput): Promise<Result<CausalQuestion>>;
  proposeCandidate(scope: Scope, questionId: string, claimId: string, rationale: string): Promise<Result<QuestionCandidate>>;
  listQuestions(scope: Scope): Promise<Result<readonly CausalQuestion[]>>;
  investigate(scope: Scope, questionId: string, lens?: CausalLens): Promise<Result<QuestionInvestigation>>;

  getClaim(scope: Scope, id: string, lens?: CausalLens): Promise<Result<ClaimView>>;
  listClaims(scope: Scope, filter?: { lens?: CausalLens; causeKey?: string; effectKey?: string; status?: ClaimStatus }): Promise<Result<readonly ClaimView[]>>;
  evaluateClaim(scope: Scope, id: string, lens?: CausalLens): Promise<Result<ClaimEvaluation>>;
  explainClaim(scope: Scope, id: string, lens?: CausalLens): Promise<Result<ClaimExplanation>>;
  listEvidence(scope: Scope): Promise<Result<readonly CausalEvidence[]>>;

  getCauses(scope: Scope, variableKey: string, lens?: CausalLens): Promise<Result<readonly ClaimView[]>>;
  getEffects(scope: Scope, variableKey: string, lens?: CausalLens): Promise<Result<readonly ClaimView[]>>;
  traverse(scope: Scope, input: { from: string; direction: 'UPSTREAM' | 'DOWNSTREAM'; maxDepth: number; lens?: CausalLens }): Promise<Result<Traversal>>;
  paths(scope: Scope, input: { from: string; to: string; maxDepth: number; lens?: CausalLens }): Promise<Result<readonly CausalPath[]>>;

  applicability(scope: Scope, claimId: string, context: string | readonly string[], lens?: CausalLens): Promise<Result<Applicability>>;
  claimsFor(scope: Scope, input: { effectKey: string; context: string | readonly string[]; lens?: CausalLens }): Promise<Result<{ applicable: readonly (ClaimView & { applicability: Applicability })[]; notApplicable: readonly (ClaimView & { applicability: Applicability })[] }>>;
  modelDependency(scope: Scope, causeKey: string, effectKey: string): Promise<Result<ModelDependency | null>>;

  /** The causal understanding at a lens, reconstructed from append-only records — the causal graph "snapshot". */
  viewAt(scope: Scope, lens?: CausalLens): Promise<Result<CausalView>>;
  projectForViewer(scope: Scope, viewer: TwinViewer, units: readonly OrgUnit[], facts: ClaimVisibilityFacts, lens?: CausalLens): Promise<Result<ProjectedCausalView>>;
}
