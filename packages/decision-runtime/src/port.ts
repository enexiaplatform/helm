/**
 * The Decision Runtime port, and the DecisionStore it persists through.
 *
 * Same shape as the scenario runtime: one runtime implementation of pure
 * orchestration over ports — the scenario runtime for quantitative evidence,
 * the value graph for metric semantics, and a DecisionStore for what only
 * decisions have. No Supabase or Postgres concern appears here; the Postgres
 * adapter lives in postgres.ts and is held to the same conformance suite as
 * the in-memory one.
 *
 * The runtime NEVER computes a business value. Every number a decision shows
 * is read from a scenario future state that the propagation engine produced.
 */

import type { Result, Scope, UserId } from '@helm/shared';
import type {
  ActionIntent,
  ActionIntentStatus,
  AlternativeStatus,
  AssumptionOutcome,
  CommitmentSnapshot,
  CriterionAssessment,
  CriterionEvaluation,
  Decision,
  DecisionAlternative,
  DecisionAssumption,
  DecisionChallenge,
  DecisionCommitment,
  DecisionCommittedEvent,
  DecisionCriterion,
  DecisionEvidence,
  DecisionExplanation,
  DecisionOutcomeReview,
  DecisionRevision,
  DecisionState,
  DecisionTimelineEvent,
  ManagementWeighting,
  ReadinessReport,
  TradeOffSpace,
  WeightedView,
} from './types.ts';

// ------------------------------------------------------------------ store

export type NewDecision = Omit<Decision, 'id' | 'orgId' | 'createdAt' | 'updatedAt'>;
export type NewDecisionRevision = Omit<DecisionRevision, 'id' | 'orgId' | 'createdAt' | 'sealedAt'>;
export type NewAlternative = Omit<DecisionAlternative, 'id' | 'orgId' | 'createdAt'>;
export type NewCriterion = Omit<DecisionCriterion, 'id' | 'orgId' | 'createdAt'>;
export type NewAssessment = Omit<CriterionAssessment, 'id' | 'orgId'>;
export type NewAssumption = Omit<DecisionAssumption, 'id' | 'orgId' | 'createdAt'>;
export type NewChallenge = Omit<DecisionChallenge, 'id' | 'orgId' | 'raisedAt'>;
export type NewEvidence = Omit<DecisionEvidence, 'id' | 'orgId' | 'createdAt'>;
export type NewWeighting = Omit<ManagementWeighting, 'id' | 'orgId'>;
export type NewCommitment = Omit<DecisionCommitment, 'id' | 'orgId'>;
export type NewSnapshot = Omit<CommitmentSnapshot, 'id' | 'orgId'>;
export type NewActionIntent = Omit<ActionIntent, 'id' | 'orgId' | 'createdAt'>;
export type NewOutcomeReview = Omit<DecisionOutcomeReview, 'id' | 'orgId'>;
export type NewTimelineEvent = Omit<DecisionTimelineEvent, 'id' | 'orgId' | 'recordedAt'>;

/**
 * Persistence for the decision layer. Every method is tenant-scoped by
 * `scope.orgId`; an id from another organization is simply not found.
 *
 * Immutability is the store's contract, not the runtime's courtesy: a SEALED
 * revision and everything hanging off it reject every change, a commitment
 * and its snapshot are write-once, and the timeline is append-only.
 */
export interface DecisionStore {
  createDecision(scope: Scope, input: NewDecision): Promise<Result<Decision>>;
  getDecision(scope: Scope, id: string): Promise<Result<Decision | null>>;
  listDecisions(scope: Scope): Promise<Result<readonly Decision[]>>;
  /** Enforces `decisionTransitions`. */
  setDecisionState(
    scope: Scope,
    id: string,
    state: DecisionState,
  ): Promise<Result<Decision>>;
  /** Framing only: title, question, context, owner, horizon, objectives, reversibility. */
  updateDecisionFraming(
    scope: Scope,
    id: string,
    patch: Partial<
      Pick<
        Decision,
        | 'title'
        | 'managementQuestion'
        | 'context'
        | 'problem'
        | 'scope'
        | 'owner'
        | 'horizon'
        | 'objectives'
        | 'reversibility'
        | 'reversalWindowDays'
        | 'metadata'
      >
    >,
  ): Promise<Result<Decision>>;

  createRevision(scope: Scope, input: NewDecisionRevision): Promise<Result<DecisionRevision>>;
  getRevision(scope: Scope, id: string): Promise<Result<DecisionRevision | null>>;
  listRevisions(scope: Scope, decisionId: string): Promise<Result<readonly DecisionRevision[]>>;
  /** DRAFT -> SEALED, once. */
  sealRevision(scope: Scope, id: string): Promise<Result<DecisionRevision>>;

  addAlternative(scope: Scope, input: NewAlternative): Promise<Result<DecisionAlternative>>;
  /** Binds or unbinds a scenario future; only on a DRAFT revision. */
  setAlternativeBinding(
    scope: Scope,
    id: string,
    binding: {
      status: AlternativeStatus;
      scenarioId: string | null;
      scenarioRevisionId: string | null;
      scenarioRunId: string | null;
      unmodelledReason: string | null;
    },
  ): Promise<Result<DecisionAlternative>>;
  listAlternatives(scope: Scope, revisionId: string): Promise<Result<readonly DecisionAlternative[]>>;

  addCriterion(scope: Scope, input: NewCriterion): Promise<Result<DecisionCriterion>>;
  listCriteria(scope: Scope, revisionId: string): Promise<Result<readonly DecisionCriterion[]>>;
  recordAssessment(scope: Scope, input: NewAssessment): Promise<Result<CriterionAssessment>>;
  listAssessments(scope: Scope, revisionId: string): Promise<Result<readonly CriterionAssessment[]>>;
  declareWeighting(scope: Scope, input: NewWeighting): Promise<Result<ManagementWeighting>>;
  getWeighting(scope: Scope, revisionId: string): Promise<Result<ManagementWeighting | null>>;

  addAssumption(scope: Scope, input: NewAssumption): Promise<Result<DecisionAssumption>>;
  listAssumptions(scope: Scope, revisionId: string): Promise<Result<readonly DecisionAssumption[]>>;
  /** Outcome only, and only after the revision is sealed: the seed of review. */
  setAssumptionOutcome(
    scope: Scope,
    id: string,
    outcome: AssumptionOutcome,
    note: string | null,
  ): Promise<Result<DecisionAssumption>>;

  addChallenge(scope: Scope, input: NewChallenge): Promise<Result<DecisionChallenge>>;
  resolveChallenge(
    scope: Scope,
    id: string,
    outcome: { status: DecisionChallenge['status']; resolution: string; resolvedBy: UserId | null },
  ): Promise<Result<DecisionChallenge>>;
  listChallenges(scope: Scope, revisionId: string): Promise<Result<readonly DecisionChallenge[]>>;

  addEvidence(scope: Scope, input: NewEvidence): Promise<Result<DecisionEvidence>>;
  listEvidence(scope: Scope, revisionId: string): Promise<Result<readonly DecisionEvidence[]>>;

  createCommitment(scope: Scope, input: NewCommitment): Promise<Result<DecisionCommitment>>;
  getCommitment(scope: Scope, id: string): Promise<Result<DecisionCommitment | null>>;
  getCommitmentForRevision(scope: Scope, revisionId: string): Promise<Result<DecisionCommitment | null>>;
  listCommitments(scope: Scope, decisionId: string): Promise<Result<readonly DecisionCommitment[]>>;
  createSnapshot(scope: Scope, input: NewSnapshot): Promise<Result<CommitmentSnapshot>>;
  getSnapshot(scope: Scope, id: string): Promise<Result<CommitmentSnapshot | null>>;

  addActionIntent(scope: Scope, input: NewActionIntent): Promise<Result<ActionIntent>>;
  setActionIntentStatus(scope: Scope, id: string, status: ActionIntentStatus): Promise<Result<ActionIntent>>;
  listActionIntents(scope: Scope, commitmentId: string): Promise<Result<readonly ActionIntent[]>>;

  recordOutcomeReview(scope: Scope, input: NewOutcomeReview): Promise<Result<DecisionOutcomeReview>>;
  listOutcomeReviews(scope: Scope, decisionId: string): Promise<Result<readonly DecisionOutcomeReview[]>>;

  appendEvent(scope: Scope, input: NewTimelineEvent): Promise<Result<DecisionTimelineEvent>>;
  listEvents(scope: Scope, decisionId: string): Promise<Result<readonly DecisionTimelineEvent[]>>;
}

// --------------------------------------------------------------- runtime

export type CreateDecisionInput = {
  title: string;
  managementQuestion: string;
  context?: string;
  problem?: string;
  scope?: string;
  triggerType: Decision['triggerType'];
  triggerRefs?: Decision['triggerRefs'];
  owner?: Decision['owner'];
  /** Defaults to the clock now for both lenses, SOURCE_TRUTH. */
  fork?: Partial<Decision['fork']>;
  horizon?: Partial<Decision['horizon']>;
  objectives?: readonly string[];
  reversibility?: Decision['reversibility'];
  reversalWindowDays?: number | null;
  metadata?: Record<string, unknown>;
};

export type AddAlternativeInput = {
  label: string;
  description?: string;
  /** Bind now, or leave it UNMODELLED with a reason. */
  scenarioId?: string | null;
  unmodelledReason?: string | null;
  sort?: number;
  metadata?: Record<string, unknown>;
};

export type AddCriterionInput = {
  key: string;
  name: string;
  description?: string;
  style: DecisionCriterion['style'];
  required?: boolean;
  metricKey?: string | null;
  subjectHint?: string | null;
  threshold?: string | number | null;
  unit?: DecisionCriterion['unit'];
  direction?: DecisionCriterion['direction'];
  weight?: string | number | null;
  author: DecisionCriterion['author'];
  rationale: string;
  demoPolicy?: boolean;
  sort?: number;
};

export type AddAssumptionInput = {
  statement: string;
  owner?: DecisionAssumption['owner'];
  source?: string;
  rationale?: string;
  confidence?: number | null;
  criticality?: DecisionAssumption['criticality'];
  scenarioRevisionId?: string | null;
  scenarioOverrideId?: string | null;
  alternativeIds?: readonly string[];
};

export type ChallengeInput = {
  targetKind: DecisionChallenge['targetKind'];
  targetId?: string | null;
  author: DecisionChallenge['author'];
  concern: string;
  evidenceId?: string | null;
};

export type AddEvidenceInput = {
  kind: DecisionEvidence['kind'];
  title: string;
  detail?: string;
  relation: DecisionEvidence['relation'];
  targetKind: DecisionEvidence['targetKind'];
  targetId?: string | null;
  sourceSystem: string;
  sourceRef?: string | null;
  effectiveAt?: string | null;
  confidence?: number | null;
  author?: DecisionEvidence['author'];
};

export type CommitInput = {
  chosenAlternativeId: string;
  /** Always management's own; HELM never authors a commitment. */
  authorship: DecisionCommitment['authorship'];
  committedByLabel: string;
  summary: string;
  rationale: DecisionCommitment['rationale'];
  acceptedTradeOffs: DecisionCommitment['acceptedTradeOffs'];
  /** Node references into the chosen future state; values are read, not typed. */
  expectedOutcomes?: readonly {
    label: string;
    kind: 'MODELLED' | 'QUALITATIVE';
    metricKey?: string | null;
    subjectHint?: string | null;
    statement?: string | null;
  }[];
  reviewTriggers?: DecisionCommitment['reviewTriggers'];
  actionIntents?: readonly {
    title: string;
    detail?: string;
    ownerLabel: string;
    ownerUserId?: UserId | null;
    dueDate?: string | null;
    targetSystem: string;
  }[];
  /** Commit over an open challenge only when management says so explicitly. */
  acknowledgeOpenChallenges?: boolean;
};

export type ReconsiderInput = {
  reason: string;
  /** Rebase each bound scenario onto a new knowledge boundary before re-modelling. */
  rebaseScenarios?: boolean;
  /** The new boundary; defaults to the clock now. */
  fork?: Partial<Decision['fork']>;
};

export type DecisionWorkspace = {
  readonly decision: Decision;
  readonly revision: DecisionRevision;
  readonly revisions: readonly DecisionRevision[];
  readonly alternatives: readonly DecisionAlternative[];
  readonly criteria: readonly DecisionCriterion[];
  readonly assessments: readonly CriterionAssessment[];
  readonly assumptions: readonly DecisionAssumption[];
  readonly challenges: readonly DecisionChallenge[];
  readonly evidence: readonly DecisionEvidence[];
  readonly evaluations: readonly CriterionEvaluation[];
  readonly tradeOffs: TradeOffSpace | null;
  readonly readiness: ReadinessReport;
  readonly weighting: ManagementWeighting | null;
  readonly commitment: DecisionCommitment | null;
  readonly snapshot: CommitmentSnapshot | null;
  readonly actionIntents: readonly ActionIntent[];
  readonly timeline: readonly DecisionTimelineEvent[];
  readonly outcomeReviews: readonly DecisionOutcomeReview[];
};

export interface DecisionRuntime {
  createDecision(scope: Scope, input: CreateDecisionInput): Promise<Result<{ decision: Decision; revision: DecisionRevision }>>;
  updateFraming(
    scope: Scope,
    decisionId: string,
    patch: Parameters<DecisionStore['updateDecisionFraming']>[2],
  ): Promise<Result<Decision>>;
  setState(scope: Scope, decisionId: string, state: DecisionState): Promise<Result<Decision>>;

  addAlternative(scope: Scope, revisionId: string, input: AddAlternativeInput): Promise<Result<DecisionAlternative>>;
  /** Binds an alternative to a scenario's latest completed simulation. */
  bindScenario(scope: Scope, alternativeId: string, scenarioId: string, runId?: string): Promise<Result<DecisionAlternative>>;
  withdrawAlternative(scope: Scope, alternativeId: string, reason: string): Promise<Result<DecisionAlternative>>;

  addCriterion(scope: Scope, revisionId: string, input: AddCriterionInput): Promise<Result<DecisionCriterion>>;
  recordAssessment(
    scope: Scope,
    input: { criterionId: string; alternativeId: string; rating: CriterionAssessment['rating']; rationale: string; author: CriterionAssessment['author'] },
  ): Promise<Result<CriterionAssessment>>;
  /** Declares management's own weighting method. Without it, a weighted view is refused. */
  declareWeighting(
    scope: Scope,
    revisionId: string,
    input: { method: string; rationale: string; author: ManagementWeighting['author'] },
  ): Promise<Result<ManagementWeighting>>;
  weightedView(scope: Scope, revisionId: string): Promise<Result<WeightedView>>;

  addAssumption(scope: Scope, revisionId: string, input: AddAssumptionInput): Promise<Result<DecisionAssumption>>;
  challenge(scope: Scope, revisionId: string, input: ChallengeInput): Promise<Result<DecisionChallenge>>;
  resolveChallenge(
    scope: Scope,
    challengeId: string,
    outcome: { status: DecisionChallenge['status']; resolution: string },
  ): Promise<Result<DecisionChallenge>>;
  addEvidence(scope: Scope, revisionId: string, input: AddEvidenceInput): Promise<Result<DecisionEvidence>>;

  /** Criterion-by-criterion facts. No ranking, no total. */
  evaluateCriteria(scope: Scope, revisionId: string): Promise<Result<readonly CriterionEvaluation[]>>;
  /** What each alternative gains and gives up, relative to a reference. */
  tradeOffSpace(scope: Scope, revisionId: string, referenceAlternativeId?: string): Promise<Result<TradeOffSpace>>;
  evaluateReadiness(scope: Scope, revisionId: string): Promise<Result<ReadinessReport>>;

  /** What committing WOULD freeze, without committing. */
  prepareCommitment(scope: Scope, revisionId: string, chosenAlternativeId: string): Promise<Result<CommitmentSnapshot>>;
  commit(scope: Scope, revisionId: string, input: CommitInput): Promise<Result<{ commitment: DecisionCommitment; snapshot: CommitmentSnapshot }>>;
  /** A NEW revision linked to the committed one. The commitment is untouched. */
  reconsider(scope: Scope, decisionId: string, input: ReconsiderInput): Promise<Result<DecisionRevision>>;

  recordOutcomeReview(
    scope: Scope,
    commitmentId: string,
    input: {
      reviewedByLabel: string;
      actuals: readonly { label: string; metricKey?: string | null; actual: string | null; note?: string | null }[];
      assumptionResults?: readonly { assumptionId: string; outcome: AssumptionOutcome; evidenceId?: string | null; note?: string | null }[];
      notes?: string;
    },
  ): Promise<Result<DecisionOutcomeReview>>;

  /**
   * Moves an action intent along INTENDED → IN_PROGRESS → DONE (or CANCELLED)
   * and appends ACTION_INTENT_STATUS_CHANGED, so the status an intent had at
   * any record time can be reconstructed — the store keeps only the latest.
   */
  setActionIntentStatus(
    scope: Scope,
    commitmentId: string,
    actionIntentId: string,
    status: ActionIntent['status'],
    note?: string,
  ): Promise<Result<ActionIntent>>;

  getCommitmentSnapshot(scope: Scope, commitmentId: string): Promise<Result<CommitmentSnapshot>>;
  /** "Why did management choose this?" — all the way down to source provenance. */
  explainDecision(scope: Scope, decisionId: string): Promise<Result<DecisionExplanation>>;
  /** The integration payload a connector would receive. Phase 5 never sends it. */
  committedEvent(scope: Scope, commitmentId: string): Promise<Result<DecisionCommittedEvent>>;

  getWorkspace(scope: Scope, decisionId: string, revisionId?: string): Promise<Result<DecisionWorkspace>>;
  getDecision(scope: Scope, id: string): Promise<Result<Decision | null>>;
  listDecisions(scope: Scope): Promise<Result<readonly Decision[]>>;
  listRevisions(scope: Scope, decisionId: string): Promise<Result<readonly DecisionRevision[]>>;
  timeline(scope: Scope, decisionId: string): Promise<Result<readonly DecisionTimelineEvent[]>>;
}
