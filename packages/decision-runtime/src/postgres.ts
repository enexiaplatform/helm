/**
 * PostgresDecisionStore — the DecisionStore over Supabase.
 *
 * The I/O boundary of @helm/decision-runtime, held to the same conformance
 * suite as the in-memory store. Two layers enforce the contract: this adapter
 * checks what it can before writing (so a caller gets a typed error), and the
 * database's guard triggers and RLS refuse the rest (so a client that bypasses
 * this adapter gets nowhere either). Tenant isolation is RLS's job; every
 * query is ALSO filtered by org_id, so a policy mistake could never widen a
 * read by itself.
 *
 * Exact decimals travel as text. Timestamps come back in Postgres' spelling
 * and are normalized to ISO, so a fork or a fingerprint compares equal
 * wherever it was read from.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fail,
  ok,
  type Clock,
  type Confidence,
  type OrgId,
  type Scope,
  type UserId,
} from '@helm/shared';
import type { ForkPoint, ModelRef } from '@helm/scenario-runtime';
import {
  DecisionErrors,
  decisionTransitions,
  type AcceptedTradeOff,
  type ActionIntent,
  type ActionIntentStatus,
  type AlternativeStatus,
  type AssumptionCriticality,
  type AssumptionOutcome,
  type AssumptionOwner,
  type AssumptionResult,
  type AuthorityStatus,
  type ChallengeStatus,
  type ChallengeTargetKind,
  type CommitmentAuthorship,
  type CommitmentSnapshot,
  type CriterionAssessment,
  type CriterionAuthor,
  type CriterionDirection,
  type CriterionEvaluation,
  type CriterionStyle,
  type Decision,
  type DecisionAlternative,
  type DecisionAssumption,
  type DecisionChallenge,
  type DecisionCommitment,
  type DecisionCriterion,
  type DecisionEvidence,
  type DecisionOutcomeReview,
  type DecisionRevision,
  type DecisionRevisionReason,
  type DecisionRevisionState,
  type DecisionState,
  type DecisionTimelineEvent,
  type DecisionTriggerType,
  type EvidenceKind,
  type EvidenceRelation,
  type EvidenceTargetKind,
  type ExpectedOutcome,
  type ManagementWeighting,
  type OutcomeVariance,
  type QualitativeRating,
  type RationaleItem,
  type Reversibility,
  type ReviewTrigger,
  type TriggerRef,
} from './types.ts';
import type { DecisionStore } from './port.ts';

export type PostgresDecisionStoreOptions = {
  client: SupabaseClient;
  clock: Clock;
};

type Row = Record<string, unknown>;

const iso = (t: unknown): string | null => (t === null || t === undefined ? null : new Date(t as string).toISOString());
const txt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const DECISION_COLS =
  'id, org_id, title, management_question, context, problem, decision_scope, trigger_type, ' +
  'trigger_refs, kernel_state, owner_kind, owner_label, owner_id, effective_as_of, ' +
  'recorded_through, observation_policy, decision_deadline, effective_from, ' +
  'expected_outcome_horizon, review_date, objectives, reversibility, reversal_window_days, ' +
  'authority_status, created_by, created_at, updated_at, kernel_metadata';
const REVISION_COLS =
  'id, org_id, decision_id, revision_number, state, reason, based_on_revision_id, ' +
  'reconsiders_commitment_id, reconsideration_reason, effective_as_of, recorded_through, ' +
  'observation_policy, notes, created_by, created_at, sealed_at';
const ALTERNATIVE_COLS =
  'id, org_id, decision_id, revision_id, name, description, status, scenario_id, ' +
  'scenario_revision_id, scenario_run_id, unmodelled_reason, sort, created_by, created_at, metadata';
const CRITERION_COLS =
  'id, org_id, decision_id, revision_id, key, name, description, style, required, metric_key, ' +
  'subject_hint, threshold, unit_type, direction, weight, author_kind, author_label, ' +
  'author_user_id, rationale, demo_policy, sort, created_at';
const ASSESSMENT_COLS =
  'id, org_id, revision_id, criterion_id, alternative_id, rating, rationale, author_kind, ' +
  'author_label, author_user_id, assessed_at';
const WEIGHTING_COLS =
  'id, org_id, revision_id, method, rationale, author_kind, author_label, author_user_id, declared_at';
const ASSUMPTION_COLS =
  'id, org_id, decision_id, revision_id, statement, owner_kind, owner_label, owner_user_id, ' +
  'source, rationale, confidence, criticality, scenario_revision_id, scenario_override_id, ' +
  'alternative_ids, outcome, outcome_note, created_by, created_at';
const CHALLENGE_COLS =
  'id, org_id, decision_id, revision_id, target_kind, target_id, author_kind, author_label, ' +
  'author_user_id, concern, evidence_id, status, resolution, resolved_by, resolved_at, raised_at';
const EVIDENCE_COLS =
  'id, org_id, decision_id, revision_id, kind, title, detail, relation, target_kind, target_id, ' +
  'source_system, source_ref, effective_at, recorded_at, confidence, author_kind, author_label, ' +
  'author_user_id, created_at';
const COMMITMENT_COLS =
  'id, org_id, decision_id, revision_id, chosen_alternative_id, authorship, committed_by, ' +
  'committed_by_label, committed_at, summary, rationale, accepted_trade_offs, expected_outcomes, ' +
  'review_triggers, authority_status, fingerprint, snapshot_id';
const SNAPSHOT_COLS =
  'id, org_id, decision_id, revision_id, captured_at, effective_as_of, recorded_through, ' +
  'observation_policy, model_ref, alternatives, criterion_ids, assumption_ids, challenge_ids, ' +
  'evidence_ids, criterion_evaluations, open_challenges, fingerprint';
const INTENT_COLS =
  'id, org_id, decision_id, commitment_id, title, detail, owner_label, owner_id, due_date, ' +
  'status, target_system, handoff_ref, created_at';
const REVIEW_COLS =
  'id, org_id, decision_id, commitment_id, reviewed_at, reviewed_by_label, variances, ' +
  'assumption_results, notes, statement';
const EVENT_COLS = 'id, org_id, decision_id, event_type, actor_id, payload, created_at';

// ------------------------------------------------------------------ mappers

const authorOf = (kind: unknown, label: unknown, userId: unknown): CriterionAuthor => ({
  kind: (kind as CriterionAuthor['kind']) ?? 'ROLE',
  label: (label as string) ?? '',
  userId: (userId as UserId) ?? null,
});

const forkOf = (r: Row): ForkPoint => ({
  effectiveAsOf: iso(r.effective_as_of)!,
  recordedThrough: iso(r.recorded_through)!,
  policy: (r.observation_policy as ForkPoint['policy']) ?? 'SOURCE_TRUTH',
});

const toDecision = (r: Row): Decision => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  title: r.title as string,
  managementQuestion: (r.management_question as string) ?? '',
  context: (r.context as string) ?? '',
  problem: (r.problem as string) ?? '',
  scope: (r.decision_scope as string) ?? '',
  triggerType: (r.trigger_type as DecisionTriggerType) ?? 'MANUAL',
  triggerRefs: arr<TriggerRef>(r.trigger_refs),
  state: r.kernel_state as DecisionState,
  owner: r.owner_label
    ? {
        kind: (r.owner_kind as Decision['owner'] extends null ? never : 'PERSON' | 'ROLE' | 'FUNCTION') ?? 'ROLE',
        label: r.owner_label as string,
        userId: (r.owner_id as UserId) ?? null,
      }
    : null,
  fork: forkOf(r),
  horizon: {
    decisionDeadline: txt(r.decision_deadline),
    effectiveFrom: txt(r.effective_from),
    expectedOutcomeHorizon: txt(r.expected_outcome_horizon),
    reviewDate: txt(r.review_date),
  },
  objectives: arr<string>(r.objectives),
  reversibility: (r.reversibility as Reversibility) ?? 'UNASSESSED',
  reversalWindowDays: r.reversal_window_days === null ? null : Number(r.reversal_window_days),
  authorityStatus: (r.authority_status as AuthorityStatus) ?? 'NOT_EVALUATED',
  createdBy: (r.created_by as UserId) ?? null,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  metadata: (r.kernel_metadata as Record<string, unknown>) ?? {},
});

const toRevision = (r: Row): DecisionRevision => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  decisionId: r.decision_id as string,
  revisionNumber: Number(r.revision_number),
  state: r.state as DecisionRevisionState,
  reason: r.reason as DecisionRevisionReason,
  basedOnRevisionId: (r.based_on_revision_id as string) ?? null,
  reconsidersCommitmentId: (r.reconsiders_commitment_id as string) ?? null,
  reconsiderationReason: (r.reconsideration_reason as string) ?? null,
  fork: forkOf(r),
  notes: (r.notes as string) ?? null,
  createdBy: (r.created_by as UserId) ?? null,
  createdAt: iso(r.created_at)!,
  sealedAt: iso(r.sealed_at),
});

const toAlternative = (r: Row): DecisionAlternative => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  decisionId: r.decision_id as string,
  revisionId: r.revision_id as string,
  label: r.name as string,
  description: (r.description as string) ?? '',
  status: r.status as AlternativeStatus,
  scenarioId: (r.scenario_id as string) ?? null,
  scenarioRevisionId: (r.scenario_revision_id as string) ?? null,
  scenarioRunId: (r.scenario_run_id as string) ?? null,
  unmodelledReason: (r.unmodelled_reason as string) ?? null,
  sort: Number(r.sort ?? 0),
  createdBy: (r.created_by as UserId) ?? null,
  createdAt: iso(r.created_at)!,
  metadata: (r.metadata as Record<string, unknown>) ?? {},
});

const toCriterion = (r: Row): DecisionCriterion => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  decisionId: r.decision_id as string,
  revisionId: r.revision_id as string,
  key: r.key as string,
  name: r.name as string,
  description: (r.description as string) ?? '',
  style: r.style as CriterionStyle,
  required: r.required === true,
  metricKey: (r.metric_key as string) ?? null,
  subjectHint: (r.subject_hint as string) ?? null,
  threshold: txt(r.threshold),
  unit: (r.unit_type as DecisionCriterion['unit']) ?? null,
  direction: (r.direction as CriterionDirection) ?? 'NONE',
  weight: txt(r.weight),
  author: authorOf(r.author_kind, r.author_label, r.author_user_id),
  rationale: (r.rationale as string) ?? '',
  demoPolicy: r.demo_policy === true,
  sort: Number(r.sort ?? 0),
  createdAt: iso(r.created_at)!,
});

const toAssessment = (r: Row): CriterionAssessment => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  revisionId: r.revision_id as string,
  criterionId: r.criterion_id as string,
  alternativeId: r.alternative_id as string,
  rating: r.rating as QualitativeRating,
  rationale: (r.rationale as string) ?? '',
  author: authorOf(r.author_kind, r.author_label, r.author_user_id),
  assessedAt: iso(r.assessed_at)!,
});

const toWeighting = (r: Row): ManagementWeighting => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  revisionId: r.revision_id as string,
  method: r.method as string,
  rationale: (r.rationale as string) ?? '',
  author: authorOf(r.author_kind, r.author_label, r.author_user_id),
  declaredAt: iso(r.declared_at)!,
});

const toAssumption = (r: Row): DecisionAssumption => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  decisionId: r.decision_id as string,
  revisionId: r.revision_id as string,
  statement: r.statement as string,
  owner: r.owner_label
    ? {
        kind: (r.owner_kind as AssumptionOwner['kind']) ?? 'ROLE',
        label: r.owner_label as string,
        userId: (r.owner_user_id as UserId) ?? null,
      }
    : null,
  source: (r.source as string) ?? '',
  rationale: (r.rationale as string) ?? '',
  confidence: r.confidence === null || r.confidence === undefined ? null : (Number(r.confidence) as Confidence),
  criticality: (r.criticality as AssumptionCriticality) ?? 'MATERIAL',
  scenarioRevisionId: (r.scenario_revision_id as string) ?? null,
  scenarioOverrideId: (r.scenario_override_id as string) ?? null,
  alternativeIds: arr<string>(r.alternative_ids),
  outcome: (r.outcome as AssumptionOutcome) ?? 'PENDING',
  outcomeNote: (r.outcome_note as string) ?? null,
  createdBy: (r.created_by as UserId) ?? null,
  createdAt: iso(r.created_at)!,
});

const toChallenge = (r: Row): DecisionChallenge => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  decisionId: r.decision_id as string,
  revisionId: r.revision_id as string,
  targetKind: r.target_kind as ChallengeTargetKind,
  targetId: (r.target_id as string) ?? null,
  author: authorOf(r.author_kind, r.author_label, r.author_user_id),
  concern: r.concern as string,
  evidenceId: (r.evidence_id as string) ?? null,
  status: r.status as ChallengeStatus,
  resolution: (r.resolution as string) ?? null,
  resolvedBy: (r.resolved_by as UserId) ?? null,
  resolvedAt: iso(r.resolved_at),
  raisedAt: iso(r.raised_at)!,
});

const toEvidence = (r: Row): DecisionEvidence => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  decisionId: r.decision_id as string,
  revisionId: r.revision_id as string,
  kind: r.kind as EvidenceKind,
  title: r.title as string,
  detail: (r.detail as string) ?? '',
  relation: r.relation as EvidenceRelation,
  targetKind: r.target_kind as EvidenceTargetKind,
  targetId: (r.target_id as string) ?? null,
  sourceSystem: r.source_system as string,
  sourceRef: (r.source_ref as string) ?? null,
  effectiveAt: iso(r.effective_at),
  recordedAt: iso(r.recorded_at)!,
  confidence: r.confidence === null || r.confidence === undefined ? null : (Number(r.confidence) as Confidence),
  author: r.author_label ? authorOf(r.author_kind, r.author_label, r.author_user_id) : null,
  createdAt: iso(r.created_at)!,
});

const toCommitment = (r: Row): DecisionCommitment => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  decisionId: r.decision_id as string,
  revisionId: r.revision_id as string,
  chosenAlternativeId: r.chosen_alternative_id as string,
  authorship: r.authorship as CommitmentAuthorship,
  committedBy: (r.committed_by as UserId) ?? null,
  committedByLabel: (r.committed_by_label as string) ?? '',
  committedAt: iso(r.committed_at)!,
  summary: (r.summary as string) ?? '',
  rationale: arr<RationaleItem>(r.rationale),
  acceptedTradeOffs: arr<AcceptedTradeOff>(r.accepted_trade_offs),
  expectedOutcomes: arr<ExpectedOutcome>(r.expected_outcomes),
  reviewTriggers: arr<ReviewTrigger>(r.review_triggers),
  authorityStatus: (r.authority_status as AuthorityStatus) ?? 'NOT_EVALUATED',
  fingerprint: r.fingerprint as string,
  snapshotId: r.snapshot_id as string,
});

const toSnapshot = (r: Row): CommitmentSnapshot => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  decisionId: r.decision_id as string,
  revisionId: r.revision_id as string,
  capturedAt: iso(r.captured_at)!,
  fork: forkOf(r),
  modelRef: (r.model_ref as ModelRef) ?? null,
  alternatives: arr<CommitmentSnapshot['alternatives'][number]>(r.alternatives),
  criterionIds: arr<string>(r.criterion_ids),
  assumptionIds: arr<string>(r.assumption_ids),
  challengeIds: arr<string>(r.challenge_ids),
  evidenceIds: arr<string>(r.evidence_ids),
  criterionEvaluations: arr<CriterionEvaluation>(r.criterion_evaluations),
  openChallenges: arr<string>(r.open_challenges),
  fingerprint: r.fingerprint as string,
});

const toIntent = (r: Row): ActionIntent => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  decisionId: r.decision_id as string,
  commitmentId: r.commitment_id as string,
  title: r.title as string,
  detail: (r.detail as string) ?? '',
  ownerLabel: (r.owner_label as string) ?? '',
  ownerUserId: (r.owner_id as UserId) ?? null,
  dueDate: txt(r.due_date),
  status: r.status as ActionIntentStatus,
  targetSystem: (r.target_system as string) ?? 'helm',
  handoffRef: (r.handoff_ref as string) ?? null,
  createdAt: iso(r.created_at)!,
});

const toReview = (r: Row): DecisionOutcomeReview => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  decisionId: r.decision_id as string,
  commitmentId: r.commitment_id as string,
  reviewedAt: iso(r.reviewed_at)!,
  reviewedByLabel: (r.reviewed_by_label as string) ?? '',
  variances: arr<OutcomeVariance>(r.variances),
  assumptionResults: arr<AssumptionResult>(r.assumption_results),
  notes: (r.notes as string) ?? '',
  statement: (r.statement as string) ?? '',
});

const toEvent = (r: Row): DecisionTimelineEvent => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  decisionId: r.decision_id as string,
  eventType: r.event_type as string,
  actorId: (r.actor_id as UserId) ?? null,
  payload: (r.payload as Record<string, unknown>) ?? {},
  recordedAt: iso(r.created_at)!,
});

// ------------------------------------------------------------------ store

export function createPostgresDecisionStore(opts: PostgresDecisionStoreOptions): DecisionStore {
  const { client, clock } = opts;
  const now = () => clock.now().toISOString();

  const writeFailed = (what: string, error: { message: string }) =>
    fail(DecisionErrors.WRITE_FAILED, `${what}: ${error.message}`);
  const readFailed = (what: string, error: { message: string }) =>
    fail(DecisionErrors.READ_FAILED, `${what}: ${error.message}`);

  const table = (name: string) => client.from(name);

  /** A revision this organization owns, and that still accepts changes. */
  const draftRevision = async (scope: Scope, revisionId: string) => {
    const { data, error } = await table('helm_decision_revisions')
      .select(REVISION_COLS)
      .eq('org_id', scope.orgId)
      .eq('id', revisionId)
      .maybeSingle();
    if (error) return { error: readFailed('read decision revision', error) };
    if (!data) return { error: fail(DecisionErrors.NOT_FOUND, `Decision revision ${revisionId} not found.`) };
    const revision = toRevision(data as unknown as Row);
    if (revision.state === 'SEALED') {
      return {
        error: fail(
          DecisionErrors.REVISION_SEALED,
          `Revision ${revision.revisionNumber} is sealed: its basis is what management saw, and it does not change. Open a new revision.`,
        ),
      };
    }
    return { revision };
  };

  return {
    // ------------------------------------------------------------ decisions
    async createDecision(scope, input) {
      const at = now();
      const { data, error } = await table('helm_decisions')
        .insert({
          org_id: scope.orgId,
          title: input.title,
          management_question: input.managementQuestion,
          context: input.context,
          problem: input.problem,
          decision_scope: input.scope,
          trigger_type: input.triggerType,
          trigger_refs: input.triggerRefs,
          kernel_state: input.state,
          owner_kind: input.owner?.kind ?? null,
          owner_label: input.owner?.label ?? null,
          owner_id: input.owner?.userId ?? null,
          effective_as_of: input.fork.effectiveAsOf,
          recorded_through: input.fork.recordedThrough,
          observation_policy: input.fork.policy,
          decision_deadline: input.horizon.decisionDeadline,
          effective_from: input.horizon.effectiveFrom,
          expected_outcome_horizon: input.horizon.expectedOutcomeHorizon,
          review_date: input.horizon.reviewDate,
          objectives: input.objectives,
          reversibility: input.reversibility,
          reversal_window_days: input.reversalWindowDays,
          authority_status: input.authorityStatus,
          created_by: input.createdBy ?? scope.actorId ?? null,
          created_at: at,
          updated_at: at,
          kernel_metadata: input.metadata,
        })
        .select(DECISION_COLS)
        .single();
      if (error) return writeFailed('create decision', error);
      return ok(toDecision(data as unknown as Row));
    },

    async getDecision(scope, id) {
      const { data, error } = await table('helm_decisions')
        .select(DECISION_COLS)
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .not('management_question', 'is', null)
        .maybeSingle();
      if (error) return readFailed('read decision', error);
      return ok(data ? toDecision(data as unknown as Row) : null);
    },

    async listDecisions(scope) {
      const { data, error } = await table('helm_decisions')
        .select(DECISION_COLS)
        .eq('org_id', scope.orgId)
        // Kernel decisions only: a pre-kernel row has no management question.
        .not('management_question', 'is', null)
        .order('created_at', { ascending: true });
      if (error) return readFailed('list decisions', error);
      return ok((data ?? []).map((r) => toDecision(r as unknown as Row)));
    },

    async setDecisionState(scope, id, state) {
      const { data: before, error: readError } = await table('helm_decisions')
        .select(DECISION_COLS)
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .maybeSingle();
      if (readError) return readFailed('read decision', readError);
      if (!before) return fail(DecisionErrors.NOT_FOUND, `Decision ${id} not found.`);
      const current = toDecision(before as unknown as Row);
      if (current.state !== state && !decisionTransitions[current.state].includes(state)) {
        return fail(DecisionErrors.INVALID_TRANSITION, `A ${current.state} decision cannot become ${state}.`);
      }
      const { data, error } = await table('helm_decisions')
        .update({ kernel_state: state, updated_at: now() })
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .select(DECISION_COLS)
        .single();
      if (error) return writeFailed('set decision state', error);
      return ok(toDecision(data as unknown as Row));
    },

    async updateDecisionFraming(scope, id, patch) {
      const row: Row = { updated_at: now() };
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.managementQuestion !== undefined) row.management_question = patch.managementQuestion;
      if (patch.context !== undefined) row.context = patch.context;
      if (patch.problem !== undefined) row.problem = patch.problem;
      if (patch.scope !== undefined) row.decision_scope = patch.scope;
      if (patch.owner !== undefined) {
        row.owner_kind = patch.owner?.kind ?? null;
        row.owner_label = patch.owner?.label ?? null;
        row.owner_id = patch.owner?.userId ?? null;
      }
      if (patch.horizon !== undefined) {
        row.decision_deadline = patch.horizon.decisionDeadline;
        row.effective_from = patch.horizon.effectiveFrom;
        row.expected_outcome_horizon = patch.horizon.expectedOutcomeHorizon;
        row.review_date = patch.horizon.reviewDate;
      }
      if (patch.objectives !== undefined) row.objectives = patch.objectives;
      if (patch.reversibility !== undefined) row.reversibility = patch.reversibility;
      if (patch.reversalWindowDays !== undefined) row.reversal_window_days = patch.reversalWindowDays;
      if (patch.metadata !== undefined) row.kernel_metadata = patch.metadata;

      const { data, error } = await table('helm_decisions')
        .update(row)
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .select(DECISION_COLS)
        .single();
      if (error) {
        // The database guard refuses framing changes after a commitment.
        if (/committed/i.test(error.message)) {
          return fail(
            DecisionErrors.COMMITMENT_IMMUTABLE,
            'The framing of a committed decision does not change: the question management answered is part of the record.',
          );
        }
        return writeFailed('update decision framing', error);
      }
      return ok(toDecision(data as unknown as Row));
    },

    // ------------------------------------------------------------ revisions
    async createRevision(scope, input) {
      const { data, error } = await table('helm_decision_revisions')
        .insert({
          org_id: scope.orgId,
          decision_id: input.decisionId,
          revision_number: input.revisionNumber,
          state: 'DRAFT',
          reason: input.reason,
          based_on_revision_id: input.basedOnRevisionId,
          reconsiders_commitment_id: input.reconsidersCommitmentId,
          reconsideration_reason: input.reconsiderationReason,
          effective_as_of: input.fork.effectiveAsOf,
          recorded_through: input.fork.recordedThrough,
          observation_policy: input.fork.policy,
          notes: input.notes,
          created_by: input.createdBy ?? scope.actorId ?? null,
          created_at: now(),
        })
        .select(REVISION_COLS)
        .single();
      if (error) {
        if (/one_draft|duplicate key/i.test(error.message)) {
          return fail(DecisionErrors.DRAFT_EXISTS, 'A draft revision of this decision is already open.');
        }
        return writeFailed('create decision revision', error);
      }
      return ok(toRevision(data as unknown as Row));
    },

    async getRevision(scope, id) {
      const { data, error } = await table('helm_decision_revisions')
        .select(REVISION_COLS)
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .maybeSingle();
      if (error) return readFailed('read decision revision', error);
      return ok(data ? toRevision(data as unknown as Row) : null);
    },

    async listRevisions(scope, decisionId) {
      const { data, error } = await table('helm_decision_revisions')
        .select(REVISION_COLS)
        .eq('org_id', scope.orgId)
        .eq('decision_id', decisionId)
        .order('revision_number', { ascending: true });
      if (error) return readFailed('list decision revisions', error);
      return ok((data ?? []).map((r) => toRevision(r as unknown as Row)));
    },

    async sealRevision(scope, id) {
      const { data, error } = await table('helm_decision_revisions')
        .update({ state: 'SEALED', sealed_at: now() })
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .eq('state', 'DRAFT')
        .select(REVISION_COLS)
        .maybeSingle();
      if (error) return writeFailed('seal decision revision', error);
      if (!data) return fail(DecisionErrors.REVISION_SEALED, `Decision revision ${id} is not an open draft.`);
      return ok(toRevision(data as unknown as Row));
    },

    // --------------------------------------------------------- alternatives
    async addAlternative(scope, input) {
      const guard = await draftRevision(scope, input.revisionId);
      if (guard.error) return guard.error;
      const { data, error } = await table('helm_decision_alternatives')
        .insert({
          org_id: scope.orgId,
          decision_id: input.decisionId,
          revision_id: input.revisionId,
          name: input.label,
          description: input.description,
          status: input.status,
          scenario_id: input.scenarioId,
          scenario_revision_id: input.scenarioRevisionId,
          scenario_run_id: input.scenarioRunId,
          unmodelled_reason: input.unmodelledReason,
          sort: input.sort,
          created_by: input.createdBy ?? scope.actorId ?? null,
          created_at: now(),
          metadata: input.metadata,
        })
        .select(ALTERNATIVE_COLS)
        .single();
      if (error) return writeFailed('add alternative', error);
      return ok(toAlternative(data as unknown as Row));
    },

    async setAlternativeBinding(scope, id, binding) {
      const { data: existing, error: readError } = await table('helm_decision_alternatives')
        .select(ALTERNATIVE_COLS)
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .maybeSingle();
      if (readError) return readFailed('read alternative', readError);
      if (!existing) return fail(DecisionErrors.NOT_FOUND, `Alternative ${id} not found.`);
      const guard = await draftRevision(scope, (existing as unknown as Row).revision_id as string);
      if (guard.error) return guard.error;

      const { data, error } = await table('helm_decision_alternatives')
        .update({
          status: binding.status,
          scenario_id: binding.scenarioId,
          scenario_revision_id: binding.scenarioRevisionId,
          scenario_run_id: binding.scenarioRunId,
          unmodelled_reason: binding.unmodelledReason,
        })
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .select(ALTERNATIVE_COLS)
        .single();
      if (error) return writeFailed('bind alternative', error);
      return ok(toAlternative(data as unknown as Row));
    },

    async listAlternatives(scope, revisionId) {
      const { data, error } = await table('helm_decision_alternatives')
        .select(ALTERNATIVE_COLS)
        .eq('org_id', scope.orgId)
        .eq('revision_id', revisionId)
        .order('sort', { ascending: true })
        .order('created_at', { ascending: true });
      if (error) return readFailed('list alternatives', error);
      return ok((data ?? []).map((r) => toAlternative(r as unknown as Row)));
    },

    // -------------------------------------------------------------- criteria
    async addCriterion(scope, input) {
      const guard = await draftRevision(scope, input.revisionId);
      if (guard.error) return guard.error;
      const { data, error } = await table('helm_decision_criteria')
        .insert({
          org_id: scope.orgId,
          decision_id: input.decisionId,
          revision_id: input.revisionId,
          key: input.key,
          name: input.name,
          description: input.description,
          style: input.style,
          required: input.required,
          metric_key: input.metricKey,
          subject_hint: input.subjectHint,
          threshold: input.threshold,
          unit_type: input.unit,
          direction: input.direction,
          weight: input.weight,
          author_kind: input.author.kind,
          author_label: input.author.label,
          author_user_id: input.author.userId,
          rationale: input.rationale,
          demo_policy: input.demoPolicy,
          sort: input.sort,
          created_at: now(),
        })
        .select(CRITERION_COLS)
        .single();
      if (error) {
        if (/duplicate key/i.test(error.message)) {
          return fail(DecisionErrors.INVALID_INPUT, `Criterion "${input.key}" is already stated on this revision.`);
        }
        return writeFailed('add criterion', error);
      }
      return ok(toCriterion(data as unknown as Row));
    },

    async listCriteria(scope, revisionId) {
      const { data, error } = await table('helm_decision_criteria')
        .select(CRITERION_COLS)
        .eq('org_id', scope.orgId)
        .eq('revision_id', revisionId)
        .order('sort', { ascending: true })
        .order('key', { ascending: true });
      if (error) return readFailed('list criteria', error);
      return ok((data ?? []).map((r) => toCriterion(r as unknown as Row)));
    },

    async recordAssessment(scope, input) {
      const guard = await draftRevision(scope, input.revisionId);
      if (guard.error) return guard.error;
      const { data, error } = await table('helm_decision_criterion_assessments')
        .upsert(
          {
            org_id: scope.orgId,
            revision_id: input.revisionId,
            criterion_id: input.criterionId,
            alternative_id: input.alternativeId,
            rating: input.rating,
            rationale: input.rationale,
            author_kind: input.author.kind,
            author_label: input.author.label,
            author_user_id: input.author.userId,
            assessed_at: input.assessedAt,
          },
          { onConflict: 'criterion_id,alternative_id' },
        )
        .select(ASSESSMENT_COLS)
        .single();
      if (error) return writeFailed('record assessment', error);
      return ok(toAssessment(data as unknown as Row));
    },

    async listAssessments(scope, revisionId) {
      const { data, error } = await table('helm_decision_criterion_assessments')
        .select(ASSESSMENT_COLS)
        .eq('org_id', scope.orgId)
        .eq('revision_id', revisionId);
      if (error) return readFailed('list assessments', error);
      return ok((data ?? []).map((r) => toAssessment(r as unknown as Row)));
    },

    async declareWeighting(scope, input) {
      const guard = await draftRevision(scope, input.revisionId);
      if (guard.error) return guard.error;
      const { data, error } = await table('helm_decision_weightings')
        .insert({
          org_id: scope.orgId,
          revision_id: input.revisionId,
          method: input.method,
          rationale: input.rationale,
          author_kind: input.author.kind,
          author_label: input.author.label,
          author_user_id: input.author.userId,
          declared_at: input.declaredAt,
        })
        .select(WEIGHTING_COLS)
        .single();
      if (error) return writeFailed('declare weighting', error);
      return ok(toWeighting(data as unknown as Row));
    },

    async getWeighting(scope, revisionId) {
      const { data, error } = await table('helm_decision_weightings')
        .select(WEIGHTING_COLS)
        .eq('org_id', scope.orgId)
        .eq('revision_id', revisionId)
        .maybeSingle();
      if (error) return readFailed('read weighting', error);
      return ok(data ? toWeighting(data as unknown as Row) : null);
    },

    // ----------------------------------------------------------- assumptions
    async addAssumption(scope, input) {
      const guard = await draftRevision(scope, input.revisionId);
      if (guard.error) return guard.error;
      const { data, error } = await table('helm_decision_assumptions')
        .insert({
          org_id: scope.orgId,
          decision_id: input.decisionId,
          revision_id: input.revisionId,
          statement: input.statement,
          owner_kind: input.owner?.kind ?? null,
          owner_label: input.owner?.label ?? null,
          owner_user_id: input.owner?.userId ?? null,
          source: input.source,
          rationale: input.rationale,
          confidence: input.confidence,
          criticality: input.criticality,
          scenario_revision_id: input.scenarioRevisionId,
          scenario_override_id: input.scenarioOverrideId,
          alternative_ids: input.alternativeIds,
          outcome: input.outcome,
          outcome_note: input.outcomeNote,
          created_by: input.createdBy ?? scope.actorId ?? null,
          created_at: now(),
        })
        .select(ASSUMPTION_COLS)
        .single();
      if (error) return writeFailed('add assumption', error);
      return ok(toAssumption(data as unknown as Row));
    },

    async listAssumptions(scope, revisionId) {
      const { data, error } = await table('helm_decision_assumptions')
        .select(ASSUMPTION_COLS)
        .eq('org_id', scope.orgId)
        .eq('revision_id', revisionId)
        .order('created_at', { ascending: true });
      if (error) return readFailed('list assumptions', error);
      return ok((data ?? []).map((r) => toAssumption(r as unknown as Row)));
    },

    async setAssumptionOutcome(scope, id, outcome, note) {
      const { data, error } = await table('helm_decision_assumptions')
        .update({ outcome, outcome_note: note })
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .select(ASSUMPTION_COLS)
        .maybeSingle();
      if (error) return writeFailed('set assumption outcome', error);
      if (!data) return fail(DecisionErrors.NOT_FOUND, `Assumption ${id} not found.`);
      return ok(toAssumption(data as unknown as Row));
    },

    // ------------------------------------------------------------ challenges
    async addChallenge(scope, input) {
      const guard = await draftRevision(scope, input.revisionId);
      if (guard.error) return guard.error;
      const { data, error } = await table('helm_decision_challenges')
        .insert({
          org_id: scope.orgId,
          decision_id: input.decisionId,
          revision_id: input.revisionId,
          target_kind: input.targetKind,
          target_id: input.targetId,
          author_kind: input.author.kind,
          author_label: input.author.label,
          author_user_id: input.author.userId,
          concern: input.concern,
          evidence_id: input.evidenceId,
          status: 'OPEN',
          raised_at: now(),
        })
        .select(CHALLENGE_COLS)
        .single();
      if (error) return writeFailed('raise challenge', error);
      return ok(toChallenge(data as unknown as Row));
    },

    async resolveChallenge(scope, id, outcome) {
      const { data, error } = await table('helm_decision_challenges')
        .update({
          status: outcome.status,
          resolution: outcome.resolution,
          resolved_by: outcome.resolvedBy,
          resolved_at: now(),
        })
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .eq('status', 'OPEN')
        .select(CHALLENGE_COLS)
        .maybeSingle();
      if (error) return writeFailed('resolve challenge', error);
      if (!data) return fail(DecisionErrors.INVALID_TRANSITION, `Challenge ${id} is not open.`);
      return ok(toChallenge(data as unknown as Row));
    },

    async listChallenges(scope, revisionId) {
      const { data, error } = await table('helm_decision_challenges')
        .select(CHALLENGE_COLS)
        .eq('org_id', scope.orgId)
        .eq('revision_id', revisionId)
        .order('raised_at', { ascending: true });
      if (error) return readFailed('list challenges', error);
      return ok((data ?? []).map((r) => toChallenge(r as unknown as Row)));
    },

    // -------------------------------------------------------------- evidence
    async addEvidence(scope, input) {
      // Evidence after a commitment is still recorded; it simply never enters
      // the frozen manifest. So this does NOT go through the draft guard.
      const { data, error } = await table('helm_decision_evidence')
        .insert({
          org_id: scope.orgId,
          decision_id: input.decisionId,
          revision_id: input.revisionId,
          kind: input.kind,
          title: input.title,
          detail: input.detail,
          relation: input.relation,
          target_kind: input.targetKind,
          target_id: input.targetId,
          source_system: input.sourceSystem,
          source_ref: input.sourceRef,
          effective_at: input.effectiveAt,
          recorded_at: input.recordedAt,
          confidence: input.confidence,
          author_kind: input.author?.kind ?? null,
          author_label: input.author?.label ?? null,
          author_user_id: input.author?.userId ?? null,
          created_at: now(),
        })
        .select(EVIDENCE_COLS)
        .single();
      if (error) return writeFailed('add evidence', error);
      return ok(toEvidence(data as unknown as Row));
    },

    async listEvidence(scope, revisionId) {
      const { data, error } = await table('helm_decision_evidence')
        .select(EVIDENCE_COLS)
        .eq('org_id', scope.orgId)
        .eq('revision_id', revisionId)
        .order('created_at', { ascending: true });
      if (error) return readFailed('list evidence', error);
      return ok((data ?? []).map((r) => toEvidence(r as unknown as Row)));
    },

    // ------------------------------------------------------------ commitment
    async createCommitment(scope, input) {
      const { data, error } = await table('helm_decision_commitments')
        .insert({
          org_id: scope.orgId,
          decision_id: input.decisionId,
          revision_id: input.revisionId,
          chosen_alternative_id: input.chosenAlternativeId,
          authorship: input.authorship,
          committed_by: input.committedBy ?? scope.actorId ?? null,
          committed_by_label: input.committedByLabel,
          committed_at: input.committedAt,
          summary: input.summary,
          rationale: input.rationale,
          accepted_trade_offs: input.acceptedTradeOffs,
          expected_outcomes: input.expectedOutcomes,
          review_triggers: input.reviewTriggers,
          authority_status: input.authorityStatus,
          fingerprint: input.fingerprint,
          snapshot_id: input.snapshotId,
        })
        .select(COMMITMENT_COLS)
        .single();
      if (error) {
        if (/duplicate key|already/i.test(error.message)) {
          return fail(
            DecisionErrors.ALREADY_COMMITTED,
            'That revision has already been committed. Reconsidering creates a new revision; it does not rewrite this one.',
          );
        }
        return writeFailed('create commitment', error);
      }
      return ok(toCommitment(data as unknown as Row));
    },

    async getCommitment(scope, id) {
      const { data, error } = await table('helm_decision_commitments')
        .select(COMMITMENT_COLS)
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .maybeSingle();
      if (error) return readFailed('read commitment', error);
      return ok(data ? toCommitment(data as unknown as Row) : null);
    },

    async getCommitmentForRevision(scope, revisionId) {
      const { data, error } = await table('helm_decision_commitments')
        .select(COMMITMENT_COLS)
        .eq('org_id', scope.orgId)
        .eq('revision_id', revisionId)
        .maybeSingle();
      if (error) return readFailed('read commitment', error);
      return ok(data ? toCommitment(data as unknown as Row) : null);
    },

    async listCommitments(scope, decisionId) {
      const { data, error } = await table('helm_decision_commitments')
        .select(COMMITMENT_COLS)
        .eq('org_id', scope.orgId)
        .eq('decision_id', decisionId)
        .order('committed_at', { ascending: true });
      if (error) return readFailed('list commitments', error);
      return ok((data ?? []).map((r) => toCommitment(r as unknown as Row)));
    },

    async createSnapshot(scope, input) {
      const { data, error } = await table('helm_decision_commitment_snapshots')
        .insert({
          org_id: scope.orgId,
          decision_id: input.decisionId,
          revision_id: input.revisionId,
          captured_at: input.capturedAt,
          effective_as_of: input.fork.effectiveAsOf,
          recorded_through: input.fork.recordedThrough,
          observation_policy: input.fork.policy,
          model_ref: input.modelRef,
          alternatives: input.alternatives,
          criterion_ids: input.criterionIds,
          assumption_ids: input.assumptionIds,
          challenge_ids: input.challengeIds,
          evidence_ids: input.evidenceIds,
          criterion_evaluations: input.criterionEvaluations,
          open_challenges: input.openChallenges,
          fingerprint: input.fingerprint,
        })
        .select(SNAPSHOT_COLS)
        .single();
      if (error) return writeFailed('capture commitment snapshot', error);
      return ok(toSnapshot(data as unknown as Row));
    },

    async getSnapshot(scope, id) {
      const { data, error } = await table('helm_decision_commitment_snapshots')
        .select(SNAPSHOT_COLS)
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .maybeSingle();
      if (error) return readFailed('read commitment snapshot', error);
      return ok(data ? toSnapshot(data as unknown as Row) : null);
    },

    // --------------------------------------------------------- action intent
    async addActionIntent(scope, input) {
      const { data, error } = await table('helm_actions')
        .insert({
          org_id: scope.orgId,
          decision_id: input.decisionId,
          commitment_id: input.commitmentId,
          title: input.title,
          detail: input.detail,
          owner_label: input.ownerLabel,
          owner_id: input.ownerUserId,
          due_date: input.dueDate,
          status: input.status,
          target_system: input.targetSystem,
          handoff_ref: input.handoffRef,
          created_at: now(),
        })
        .select(INTENT_COLS)
        .single();
      if (error) return writeFailed('add action intent', error);
      return ok(toIntent(data as unknown as Row));
    },

    async setActionIntentStatus(scope, id, status) {
      const { data, error } = await table('helm_actions')
        .update({ status })
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .not('commitment_id', 'is', null)
        .select(INTENT_COLS)
        .maybeSingle();
      if (error) return writeFailed('set action intent status', error);
      if (!data) return fail(DecisionErrors.NOT_FOUND, `Action intent ${id} not found.`);
      return ok(toIntent(data as unknown as Row));
    },

    async listActionIntents(scope, commitmentId) {
      const { data, error } = await table('helm_actions')
        .select(INTENT_COLS)
        .eq('org_id', scope.orgId)
        .eq('commitment_id', commitmentId)
        .order('created_at', { ascending: true });
      if (error) return readFailed('list action intents', error);
      return ok((data ?? []).map((r) => toIntent(r as unknown as Row)));
    },

    // -------------------------------------------------------- outcome review
    async recordOutcomeReview(scope, input) {
      const { data, error } = await table('helm_decision_outcome_reviews')
        .insert({
          org_id: scope.orgId,
          decision_id: input.decisionId,
          commitment_id: input.commitmentId,
          reviewed_at: input.reviewedAt,
          reviewed_by_label: input.reviewedByLabel,
          variances: input.variances,
          assumption_results: input.assumptionResults,
          notes: input.notes,
          statement: input.statement,
        })
        .select(REVIEW_COLS)
        .single();
      if (error) return writeFailed('record outcome review', error);
      return ok(toReview(data as unknown as Row));
    },

    async listOutcomeReviews(scope, decisionId) {
      const { data, error } = await table('helm_decision_outcome_reviews')
        .select(REVIEW_COLS)
        .eq('org_id', scope.orgId)
        .eq('decision_id', decisionId)
        .order('reviewed_at', { ascending: true });
      if (error) return readFailed('list outcome reviews', error);
      return ok((data ?? []).map((r) => toReview(r as unknown as Row)));
    },

    // -------------------------------------------------------------- timeline
    async appendEvent(scope, input) {
      const { data, error } = await table('helm_decision_events')
        .insert({
          org_id: scope.orgId,
          decision_id: input.decisionId,
          event_type: input.eventType,
          actor_id: input.actorId ?? scope.actorId ?? null,
          payload: input.payload,
          created_at: now(),
        })
        .select(EVENT_COLS)
        .single();
      if (error) return writeFailed('append decision event', error);
      return ok(toEvent(data as unknown as Row));
    },

    async listEvents(scope, decisionId) {
      const { data, error } = await table('helm_decision_events')
        .select(EVENT_COLS)
        .eq('org_id', scope.orgId)
        .eq('decision_id', decisionId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
      if (error) return readFailed('list decision events', error);
      return ok((data ?? []).map((r) => toEvent(r as unknown as Row)));
    },
  };
}
