/**
 * PostgresCounterfactualStore — the CounterfactualStore over Supabase.
 *
 * The I/O boundary of @helm/counterfactual-runtime, held to the same
 * conformance suite as the in-memory store. The database enforces the
 * integrity rules (helm_counterfactual_* guards and CHECKs): write-once, record
 * time stamped by the database, same-organization references, an anchor known
 * at or before the decision boundary, AS_KNOWN_THEN without hindsight and
 * WITH_HINDSIGHT with it (the two lenses cannot be blended in storage), and
 * ESTIMATED only where a scenario run stands behind the world.
 *
 * Reads are RLS-shaped: a case is returned only whole (its unit audience, every
 * class it carries and the decision it reviews are visible to the caller); its
 * worlds and reviews follow it. That is the database's projection, never an
 * error.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fail, ok, type OrgId, type Result, type Scope, type UserId } from '@helm/shared';
import type { CounterfactualStore } from './port.ts';
import { CounterfactualErrors, type CounterfactualCase, type CounterfactualReview, type CounterfactualWorld } from './types.ts';

export type PostgresCounterfactualStoreOptions = { client: SupabaseClient };

type Row = Record<string, unknown>;
const iso = (v: unknown): string => new Date(v as string).toISOString();

const toCase = (r: Row): CounterfactualCase => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  decisionId: String(r.decision_id),
  commitmentId: String(r.commitment_id),
  title: String(r.title),
  question: String(r.question),
  intervention: r.intervention as CounterfactualCase['intervention'],
  anchor: { snapshotId: String(r.anchor_snapshot_id), lens: { effectiveAsOf: iso(r.anchor_effective), recordedThrough: iso(r.anchor_recorded) } },
  boundary: { effectiveAsOf: iso(r.boundary_effective), recordedThrough: iso(r.boundary_recorded) },
  compared: (r.compared as CounterfactualCase['compared']) ?? [],
  scope: r.scope as CounterfactualCase['scope'],
  sensitivityClasses: ((r.sensitivity_classes as string[]) ?? []).slice().sort() as CounterfactualCase['sensitivityClasses'],
  visibility: r.visibility as CounterfactualCase['visibility'],
  grantedUnitIds: ((r.granted_unit_ids as string[]) ?? []).slice().sort(),
  authoredBy: (r.authored_by as UserId | null) ?? null,
  authoredByLabel: String(r.authored_by_label),
  recordedAt: iso(r.recorded_at),
});

const toWorld = (r: Row): CounterfactualWorld => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  caseId: String(r.case_id),
  lens: r.lens as CounterfactualWorld['lens'],
  method: r.method as CounterfactualWorld['method'],
  estimability: r.estimability as CounterfactualWorld['estimability'],
  notEstimableReasons: (r.not_estimable_reasons as string[]) ?? [],
  anchorFork: r.anchor_fork as CounterfactualWorld['anchorFork'],
  knowledge: { effectiveAsOf: iso(r.knowledge_effective), recordedThrough: iso(r.knowledge_recorded) },
  origin: (r.origin as CounterfactualWorld['origin']) ?? null,
  scenario: r.scenario_run_id
    ? { scenarioId: String(r.scenario_id), revisionId: (r.scenario_revision_id as string | null) ?? null, runId: String(r.scenario_run_id) }
    : null,
  model: (r.model as CounterfactualWorld['model']) ?? null,
  readings: (r.readings as CounterfactualWorld['readings']) ?? [],
  movedInputs: (r.moved_inputs as CounterfactualWorld['movedInputs']) ?? [],
  assumptions: (r.assumptions as CounterfactualWorld['assumptions']) ?? [],
  constraints: (r.constraints as CounterfactualWorld['constraints']) ?? [],
  hindsightInputs: (r.hindsight_inputs as CounterfactualWorld['hindsightInputs']) ?? [],
  uncertainty: (r.uncertainty as string[]) ?? [],
  statement: String(r.statement),
  fingerprint: String(r.fingerprint),
  createdBy: (r.created_by as UserId | null) ?? null,
  createdByLabel: String(r.created_by_label),
  recordedAt: iso(r.recorded_at),
});

const toReview = (r: Row): CounterfactualReview => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  caseId: String(r.case_id),
  comparisonFingerprint: String(r.comparison_fingerprint),
  statement: String(r.statement),
  limitations: String(r.limitations),
  reviewedBy: (r.reviewed_by as UserId | null) ?? null,
  reviewedByLabel: String(r.reviewed_by_label),
  recordedAt: iso(r.recorded_at),
});

type Q = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

const codeOf = (message: string, code?: string): string =>
  code === '23505'
    ? CounterfactualErrors.DUPLICATE
    : /hindsight/i.test(message)
      ? CounterfactualErrors.HINDSIGHT_IN_AS_KNOWN_THEN
      : /anchor/i.test(message)
        ? CounterfactualErrors.HINDSIGHT_AS_ANCHOR
        : CounterfactualErrors.INVALID;

async function one<T>(q: Q, map: (r: Row) => T, what: string): Promise<Result<T>> {
  const { data, error } = await q;
  if (error) return fail(codeOf(error.message, error.code), `${what}: ${error.message}`);
  if (!data) return fail(CounterfactualErrors.NOT_FOUND, `${what}: nothing was returned (not visible, or refused by policy).`);
  return ok(map(data as Row));
}
async function many<T>(q: Q, map: (r: Row) => T, what: string): Promise<Result<readonly T[]>> {
  const { data, error } = await q;
  if (error) return fail(CounterfactualErrors.INVALID, `${what}: ${error.message}`);
  return ok(((data as Row[]) ?? []).map(map));
}

export function createPostgresCounterfactualStore(opts: PostgresCounterfactualStoreOptions): CounterfactualStore {
  const db = opts.client;
  const org = (s: Scope) => s.orgId as string;
  return {
    insertCase: (scope, c) =>
      one(
        db
          .from('helm_counterfactual_cases')
          .insert({
            org_id: org(scope),
            decision_id: c.decisionId,
            commitment_id: c.commitmentId,
            title: c.title,
            question: c.question,
            intervention: c.intervention,
            anchor_snapshot_id: c.anchor.snapshotId,
            anchor_effective: c.anchor.lens.effectiveAsOf,
            anchor_recorded: c.anchor.lens.recordedThrough,
            boundary_effective: c.boundary.effectiveAsOf,
            boundary_recorded: c.boundary.recordedThrough,
            compared: c.compared,
            scope: c.scope,
            sensitivity_classes: c.sensitivityClasses,
            visibility: c.visibility,
            granted_unit_ids: c.grantedUnitIds,
            authored_by: scope.actorId,
            authored_by_label: c.authoredByLabel,
          })
          .select('*')
          .single(),
        toCase,
        'open case',
      ),
    async getCase(scope, id) {
      const { data, error } = await db.from('helm_counterfactual_cases').select('*').eq('org_id', org(scope)).eq('id', id).maybeSingle();
      if (error) return fail(CounterfactualErrors.INVALID, error.message);
      return ok(data ? toCase(data as Row) : null);
    },
    listCases: (scope, filter) => {
      let q = db.from('helm_counterfactual_cases').select('*').eq('org_id', org(scope));
      if (filter?.decisionId) q = q.eq('decision_id', filter.decisionId);
      return many(q.order('recorded_at'), toCase, 'list cases');
    },

    insertWorld: (scope, w) =>
      one(
        db
          .from('helm_counterfactual_worlds')
          .insert({
            org_id: org(scope),
            case_id: w.caseId,
            lens: w.lens,
            method: w.method,
            estimability: w.estimability,
            not_estimable_reasons: w.notEstimableReasons,
            anchor_fork: w.anchorFork,
            knowledge_effective: w.knowledge.effectiveAsOf,
            knowledge_recorded: w.knowledge.recordedThrough,
            origin: w.origin,
            scenario_id: w.scenario?.scenarioId ?? null,
            scenario_revision_id: w.scenario?.revisionId ?? null,
            scenario_run_id: w.scenario?.runId ?? null,
            model: w.model,
            readings: w.readings,
            moved_inputs: w.movedInputs,
            assumptions: w.assumptions,
            constraints: w.constraints,
            hindsight_inputs: w.hindsightInputs,
            uncertainty: w.uncertainty,
            statement: w.statement,
            fingerprint: w.fingerprint,
            created_by: scope.actorId,
            created_by_label: w.createdByLabel,
          })
          .select('*')
          .single(),
        toWorld,
        'record world',
      ),
    listWorlds: (scope, caseId) => {
      let q = db.from('helm_counterfactual_worlds').select('*').eq('org_id', org(scope));
      if (caseId) q = q.eq('case_id', caseId);
      return many(q.order('recorded_at'), toWorld, 'list worlds');
    },

    insertReview: (scope, r) =>
      one(
        db
          .from('helm_counterfactual_reviews')
          .insert({
            org_id: org(scope),
            case_id: r.caseId,
            comparison_fingerprint: r.comparisonFingerprint,
            statement: r.statement,
            limitations: r.limitations,
            reviewed_by: scope.actorId,
            reviewed_by_label: r.reviewedByLabel,
          })
          .select('*')
          .single(),
        toReview,
        'record review',
      ),
    listReviews: (scope, caseId) => {
      let q = db.from('helm_counterfactual_reviews').select('*').eq('org_id', org(scope));
      if (caseId) q = q.eq('case_id', caseId);
      return many(q.order('recorded_at'), toReview, 'list reviews');
    },
  };
}
