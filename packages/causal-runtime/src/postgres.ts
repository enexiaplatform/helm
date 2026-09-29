/**
 * PostgresCausalStore — the CausalStore over Supabase.
 *
 * The I/O boundary of @helm/causal-runtime, held to the same conformance
 * suite as the in-memory store. The database enforces the integrity rules
 * (helm_causal_* guards): write-once, record time stamped by the database,
 * same-organization references, sequential revisions stopping at retirement,
 * a single supersession, no contradictory case as support. A claim and its
 * revision 1 are written in ONE transaction by `helm_record_causal_claim`
 * (SECURITY INVOKER — under the caller's own RLS).
 *
 * Reads are RLS-shaped: a claim is returned only whole (its unit audience,
 * every class it carries and every decision it rests on are visible to the
 * caller), evidence only where its class is cleared — so a read can be
 * narrower than what exists. That is the database's projection, never an error.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fail, ok, type OrgId, type Result, type Scope, type UserId } from '@helm/shared';
import type { CausalStore } from './port.ts';
import {
  CausalErrors,
  type CausalClaim,
  type CausalEvidence,
  type CausalQuestion,
  type CausalVariable,
  type ClaimRevision,
  type CorrelationFinding,
  type EvidenceLink,
  type QuestionCandidate,
} from './types.ts';

export type PostgresCausalStoreOptions = { client: SupabaseClient };

type Row = Record<string, unknown>;
const iso = (v: unknown): string => new Date(v as string).toISOString();
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

const toVariable = (r: Row): CausalVariable => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  key: String(r.key),
  label: String(r.label),
  kind: r.kind as CausalVariable['kind'],
  metricKey: (r.metric_key as string | null) ?? null,
  description: String(r.description ?? ''),
  sensitivity: r.sensitivity as CausalVariable['sensitivity'],
  refs: (r.refs as CausalVariable['refs']) ?? [],
  recordedBy: (r.recorded_by as UserId | null) ?? null,
  recordedAt: iso(r.recorded_at),
});
const toClaim = (r: Row): CausalClaim => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  causeKey: String(r.cause_key),
  effectKey: String(r.effect_key),
  relationshipType: r.relationship_type as CausalClaim['relationshipType'],
  targetClaimId: (r.target_claim_id as string | null) ?? null,
  scope: r.scope as CausalClaim['scope'],
  conditions: (r.conditions as CausalClaim['conditions']) ?? [],
  applicablePeriod: { from: isoOrNull(r.applicable_from), to: isoOrNull(r.applicable_to) },
  sensitivity: r.sensitivity as CausalClaim['sensitivity'],
  visibility: r.visibility as CausalClaim['visibility'],
  grantedUnitIds: ((r.granted_unit_ids as string[]) ?? []).slice().sort(),
  authoredBy: (r.authored_by as UserId | null) ?? null,
  authoredByLabel: String(r.authored_by_label),
  recordedAt: iso(r.recorded_at),
});
const toRevision = (r: Row): ClaimRevision => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  claimId: String(r.claim_id),
  revision: Number(r.revision),
  statement: String(r.statement),
  mechanism: (r.mechanism as ClaimRevision['mechanism']) ?? [],
  confounders: (r.confounders as ClaimRevision['confounders']) ?? [],
  rationale: String(r.rationale),
  externalValidity: String(r.external_validity ?? ''),
  links: (r.links as ClaimRevision['links']) ?? [],
  retired: Boolean(r.retired),
  retirementReason: (r.retirement_reason as string | null) ?? null,
  recordedBy: (r.recorded_by as UserId | null) ?? null,
  recordedAt: iso(r.recorded_at),
});
const toEvidence = (r: Row): CausalEvidence => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  type: r.type as CausalEvidence['type'],
  statement: String(r.statement),
  assessedStrength: r.assessed_strength as CausalEvidence['assessedStrength'],
  strengthRationale: String(r.strength_rationale),
  provenance: r.provenance as CausalEvidence['provenance'],
  causeObservedAt: isoOrNull(r.cause_observed_at),
  effectObservedAt: isoOrNull(r.effect_observed_at),
  statistical: (r.statistical as CausalEvidence['statistical']) ?? null,
  correlationFindingId: (r.correlation_finding_id as string | null) ?? null,
  refs: (r.refs as CausalEvidence['refs']) ?? [],
  sensitivity: r.sensitivity as CausalEvidence['sensitivity'],
  supersedesId: (r.supersedes_id as string | null) ?? null,
  recordedBy: (r.recorded_by as UserId | null) ?? null,
  recordedAt: iso(r.recorded_at),
});
const toLink = (r: Row): EvidenceLink => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  claimId: String(r.claim_id),
  evidenceId: String(r.evidence_id),
  stance: r.stance as EvidenceLink['stance'],
  rationale: String(r.rationale),
  linkedBy: (r.linked_by as UserId | null) ?? null,
  recordedAt: iso(r.recorded_at),
});
const toCorrelation = (r: Row): CorrelationFinding => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  xKey: String(r.x_key),
  yKey: String(r.y_key),
  direction: r.direction as CorrelationFinding['direction'],
  method: String(r.method),
  population: String(r.population),
  period: String(r.period),
  effectEstimate: String(r.effect_estimate),
  uncertainty: String(r.uncertainty),
  limitations: String(r.limitations),
  scope: r.scope as CorrelationFinding['scope'],
  refs: (r.refs as CorrelationFinding['refs']) ?? [],
  sensitivity: r.sensitivity as CorrelationFinding['sensitivity'],
  recordedBy: (r.recorded_by as UserId | null) ?? null,
  recordedAt: iso(r.recorded_at),
});
const toQuestion = (r: Row): CausalQuestion => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  statement: String(r.statement),
  target: r.target as CausalQuestion['target'],
  scope: r.scope as CausalQuestion['scope'],
  period: { from: isoOrNull(r.period_from), to: isoOrNull(r.period_to) },
  grantedUnitIds: ((r.granted_unit_ids as string[]) ?? []).slice().sort(),
  askedBy: (r.asked_by as UserId | null) ?? null,
  recordedAt: iso(r.recorded_at),
});
const toCandidate = (r: Row): QuestionCandidate => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  questionId: String(r.question_id),
  claimId: String(r.claim_id),
  rationale: String(r.rationale),
  proposedBy: (r.proposed_by as UserId | null) ?? null,
  recordedAt: iso(r.recorded_at),
});

type Q = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

async function one<T>(q: Q, map: (r: Row) => T, what: string): Promise<Result<T>> {
  const { data, error } = await q;
  if (error) return fail(error.code === '23505' ? CausalErrors.DUPLICATE_LINK : CausalErrors.INVALID, `${what}: ${error.message}`);
  if (!data) return fail(CausalErrors.NOT_FOUND, `${what}: nothing was returned (not visible, or refused by policy).`);
  return ok(map(data as Row));
}
async function many<T>(q: Q, map: (r: Row) => T, what: string): Promise<Result<readonly T[]>> {
  const { data, error } = await q;
  if (error) return fail(CausalErrors.INVALID, `${what}: ${error.message}`);
  return ok(((data as Row[]) ?? []).map(map));
}

export function createPostgresCausalStore(opts: PostgresCausalStoreOptions): CausalStore {
  const db = opts.client;
  const org = (s: Scope) => s.orgId as string;

  return {
    insertVariable: (scope, v) =>
      one(
        db
          .from('helm_causal_variables')
          .insert({
            org_id: org(scope),
            key: v.key,
            label: v.label,
            kind: v.kind,
            metric_key: v.metricKey,
            description: v.description,
            sensitivity: v.sensitivity,
            refs: v.refs,
            recorded_by: scope.actorId,
          })
          .select('*')
          .single(),
        toVariable,
        'insert causal variable',
      ),
    listVariables: (scope) => many(db.from('helm_causal_variables').select('*').eq('org_id', org(scope)).order('recorded_at'), toVariable, 'list variables'),

    async insertClaim(scope, claim, first) {
      const { data, error } = await db.rpc('helm_record_causal_claim', {
        p_claim: {
          org_id: org(scope),
          cause_key: claim.causeKey,
          effect_key: claim.effectKey,
          relationship_type: claim.relationshipType,
          target_claim_id: claim.targetClaimId,
          scope: claim.scope,
          conditions: claim.conditions,
          applicable_from: claim.applicablePeriod.from,
          applicable_to: claim.applicablePeriod.to,
          sensitivity: claim.sensitivity,
          visibility: claim.visibility,
          granted_unit_ids: claim.grantedUnitIds,
          authored_by_label: claim.authoredByLabel,
        },
        p_revision: {
          statement: first.statement,
          mechanism: first.mechanism,
          confounders: first.confounders,
          rationale: first.rationale,
          external_validity: first.externalValidity,
          links: first.links,
        },
      });
      if (error) return fail(CausalErrors.INVALID, `record causal claim: ${error.message}`);
      const id = String(data);
      const c = await one(db.from('helm_causal_claims').select('*').eq('id', id).single(), toClaim, 'read claim');
      if (!c.ok) return c;
      const r = await one(db.from('helm_causal_claim_revisions').select('*').eq('claim_id', id).eq('revision', 1).single(), toRevision, 'read revision');
      if (!r.ok) return r;
      return ok({ claim: c.value, revision: r.value });
    },
    async insertRevision(scope, claimId, input) {
      const last = await db.from('helm_causal_claim_revisions').select('revision').eq('claim_id', claimId).order('revision', { ascending: false }).limit(1);
      if (last.error) return fail(CausalErrors.INVALID, last.error.message);
      const prior = ((last.data as Row[]) ?? [])[0];
      if (!prior) return fail(CausalErrors.NOT_FOUND, 'No such claim visible in this organization.');
      return one(
        db
          .from('helm_causal_claim_revisions')
          .insert({
            org_id: org(scope),
            claim_id: claimId,
            revision: Number(prior.revision) + 1,
            statement: input.statement,
            mechanism: input.mechanism,
            confounders: input.confounders,
            rationale: input.rationale,
            external_validity: input.externalValidity,
            links: input.links,
            retired: input.retired,
            retirement_reason: input.retirementReason,
            recorded_by: scope.actorId,
          })
          .select('*')
          .single(),
        toRevision,
        'insert revision',
      );
    },
    async getClaim(scope, id) {
      const { data, error } = await db.from('helm_causal_claims').select('*').eq('org_id', org(scope)).eq('id', id).maybeSingle();
      if (error) return fail(CausalErrors.INVALID, error.message);
      return ok(data ? toClaim(data as Row) : null);
    },
    listClaims: (scope) => many(db.from('helm_causal_claims').select('*').eq('org_id', org(scope)).order('recorded_at'), toClaim, 'list claims'),
    listRevisions: (scope, claimId) => {
      let q = db.from('helm_causal_claim_revisions').select('*').eq('org_id', org(scope));
      if (claimId) q = q.eq('claim_id', claimId);
      return many(q.order('recorded_at'), toRevision, 'list revisions');
    },

    insertEvidence: (scope, e) =>
      one(
        db
          .from('helm_causal_evidence')
          .insert({
            org_id: org(scope),
            type: e.type,
            statement: e.statement,
            assessed_strength: e.assessedStrength,
            strength_rationale: e.strengthRationale,
            provenance: e.provenance,
            cause_observed_at: e.causeObservedAt,
            effect_observed_at: e.effectObservedAt,
            statistical: e.statistical,
            correlation_finding_id: e.correlationFindingId,
            refs: e.refs,
            sensitivity: e.sensitivity,
            supersedes_id: e.supersedesId,
            recorded_by: scope.actorId,
          })
          .select('*')
          .single(),
        toEvidence,
        'insert evidence',
      ),
    listEvidence: (scope) => many(db.from('helm_causal_evidence').select('*').eq('org_id', org(scope)).order('recorded_at'), toEvidence, 'list evidence'),

    insertLink: (scope, l) =>
      one(
        db
          .from('helm_causal_evidence_links')
          .insert({ org_id: org(scope), claim_id: l.claimId, evidence_id: l.evidenceId, stance: l.stance, rationale: l.rationale, linked_by: scope.actorId })
          .select('*')
          .single(),
        toLink,
        'link evidence',
      ),
    listLinks: (scope, claimId) => {
      let q = db.from('helm_causal_evidence_links').select('*').eq('org_id', org(scope));
      if (claimId) q = q.eq('claim_id', claimId);
      return many(q.order('recorded_at'), toLink, 'list links');
    },

    insertCorrelation: (scope, c) =>
      one(
        db
          .from('helm_correlation_findings')
          .insert({
            org_id: org(scope),
            x_key: c.xKey,
            y_key: c.yKey,
            direction: c.direction,
            method: c.method,
            population: c.population,
            period: c.period,
            effect_estimate: c.effectEstimate,
            uncertainty: c.uncertainty,
            limitations: c.limitations,
            scope: c.scope,
            refs: c.refs,
            sensitivity: c.sensitivity,
            recorded_by: scope.actorId,
          })
          .select('*')
          .single(),
        toCorrelation,
        'record correlation',
      ),
    listCorrelations: (scope) => many(db.from('helm_correlation_findings').select('*').eq('org_id', org(scope)).order('recorded_at'), toCorrelation, 'list correlations'),

    insertQuestion: (scope, q) =>
      one(
        db
          .from('helm_causal_questions')
          .insert({
            org_id: org(scope),
            statement: q.statement,
            target: q.target,
            scope: q.scope,
            period_from: q.period.from,
            period_to: q.period.to,
            granted_unit_ids: q.grantedUnitIds,
            asked_by: scope.actorId,
          })
          .select('*')
          .single(),
        toQuestion,
        'ask question',
      ),
    listQuestions: (scope) => many(db.from('helm_causal_questions').select('*').eq('org_id', org(scope)).order('recorded_at'), toQuestion, 'list questions'),
    insertCandidate: (scope, c) =>
      one(
        db
          .from('helm_causal_question_candidates')
          .insert({ org_id: org(scope), question_id: c.questionId, claim_id: c.claimId, rationale: c.rationale, proposed_by: scope.actorId })
          .select('*')
          .single(),
        toCandidate,
        'propose candidate',
      ),
    listCandidates: (scope, questionId) => {
      let q = db.from('helm_causal_question_candidates').select('*').eq('org_id', org(scope));
      if (questionId) q = q.eq('question_id', questionId);
      return many(q.order('recorded_at'), toCandidate, 'list candidates');
    },
  };
}
