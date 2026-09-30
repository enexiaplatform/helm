/**
 * PostgresGenomeStore — the GenomeStore over Supabase.
 *
 * The I/O boundary of @helm/genome-runtime, held to the same conformance suite
 * as the in-memory store. The database enforces the integrity rules
 * (helm_genome_* guards): write-once, record time stamped by the database,
 * same-organization references, sequential pattern revisions stopping at
 * retirement, one link per (pattern, episode), a stance that agrees with what
 * HELM observed, no self-endorsement of a lesson. A pattern and its revision 1
 * are written in ONE transaction by `helm_record_genome_pattern` (SECURITY
 * INVOKER — under the caller's own RLS).
 *
 * Reads are RLS-shaped: an episode is returned only whole (its unit audience,
 * every class it carries and the decision it wraps are visible to the caller),
 * a pattern or lesson only when every episode it rests on is. That is the
 * database's projection, never an error.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fail, ok, type OrgId, type Result, type Scope, type UserId } from '@helm/shared';
import type { GenomeStore } from './port.ts';
import {
  GenomeErrors,
  type EpisodeRef,
  type Lesson,
  type LessonReview,
  type ManagementEpisode,
  type ManagementPattern,
  type PatternEvidence,
  type PatternRevision,
} from './types.ts';

export type PostgresGenomeStoreOptions = { client: SupabaseClient };

type Row = Record<string, unknown>;
const iso = (v: unknown): string => new Date(v as string).toISOString();

const toEpisode = (r: Row): ManagementEpisode => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  decisionId: String(r.decision_id),
  commitmentId: (r.commitment_id as string | null) ?? null,
  title: String(r.title),
  scope: r.scope as ManagementEpisode['scope'],
  situation: r.situation as ManagementEpisode['situation'],
  boundary: { effectiveAsOf: iso(r.boundary_effective), recordedThrough: iso(r.boundary_recorded) },
  sensitivityClasses: ((r.sensitivity_classes as string[]) ?? []).slice().sort() as ManagementEpisode['sensitivityClasses'],
  visibility: r.visibility as ManagementEpisode['visibility'],
  grantedUnitIds: ((r.granted_unit_ids as string[]) ?? []).slice().sort(),
  authoredBy: (r.authored_by as UserId | null) ?? null,
  authoredByLabel: String(r.authored_by_label),
  recordedAt: iso(r.recorded_at),
});
const toRef = (r: Row): EpisodeRef => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  episodeId: String(r.episode_id),
  role: r.role as EpisodeRef['role'],
  ref: r.ref as EpisodeRef['ref'],
  note: (r.note as string | null) ?? null,
  boundBy: (r.bound_by as UserId | null) ?? null,
  recordedAt: iso(r.recorded_at),
});
const toPattern = (r: Row): ManagementPattern => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  title: String(r.title),
  scope: r.scope as ManagementPattern['scope'],
  conditions: (r.conditions as ManagementPattern['conditions']) ?? {},
  characteristic: r.characteristic as ManagementPattern['characteristic'],
  visibility: r.visibility as ManagementPattern['visibility'],
  grantedUnitIds: ((r.granted_unit_ids as string[]) ?? []).slice().sort(),
  authoredBy: (r.authored_by as UserId | null) ?? null,
  authoredByLabel: String(r.authored_by_label),
  recordedAt: iso(r.recorded_at),
});
const toRevision = (r: Row): PatternRevision => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  patternId: String(r.pattern_id),
  revision: Number(r.revision),
  statement: String(r.statement),
  limitations: String(r.limitations),
  retired: Boolean(r.retired),
  retirementReason: (r.retirement_reason as string | null) ?? null,
  recordedBy: (r.recorded_by as UserId | null) ?? null,
  recordedAt: iso(r.recorded_at),
});
const toEvidence = (r: Row): PatternEvidence => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  patternId: String(r.pattern_id),
  episodeId: String(r.episode_id),
  stance: r.stance as PatternEvidence['stance'],
  rationale: String(r.rationale),
  observed: r.observed as PatternEvidence['observed'],
  linkedBy: (r.linked_by as UserId | null) ?? null,
  recordedAt: iso(r.recorded_at),
});
const toLesson = (r: Row): Lesson => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  claim: String(r.claim),
  scope: r.scope as Lesson['scope'],
  evidence: (r.evidence as Lesson['evidence']) ?? [],
  visibility: r.visibility as Lesson['visibility'],
  grantedUnitIds: ((r.granted_unit_ids as string[]) ?? []).slice().sort(),
  authoredBy: (r.authored_by as UserId | null) ?? null,
  authoredByLabel: String(r.authored_by_label),
  recordedAt: iso(r.recorded_at),
});
const toReview = (r: Row): LessonReview => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  lessonId: String(r.lesson_id),
  status: r.status as LessonReview['status'],
  note: String(r.note),
  reviewedBy: (r.reviewed_by as UserId | null) ?? null,
  reviewedByLabel: String(r.reviewed_by_label),
  recordedAt: iso(r.recorded_at),
});

type Q = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

async function one<T>(q: Q, map: (r: Row) => T, what: string): Promise<Result<T>> {
  const { data, error } = await q;
  if (error) return fail(error.code === '23505' ? GenomeErrors.DUPLICATE : /endorse/.test(error.message) ? GenomeErrors.SELF_ENDORSEMENT : GenomeErrors.INVALID, `${what}: ${error.message}`);
  if (!data) return fail(GenomeErrors.NOT_FOUND, `${what}: nothing was returned (not visible, or refused by policy).`);
  return ok(map(data as Row));
}
async function many<T>(q: Q, map: (r: Row) => T, what: string): Promise<Result<readonly T[]>> {
  const { data, error } = await q;
  if (error) return fail(GenomeErrors.INVALID, `${what}: ${error.message}`);
  return ok(((data as Row[]) ?? []).map(map));
}

export function createPostgresGenomeStore(opts: PostgresGenomeStoreOptions): GenomeStore {
  const db = opts.client;
  const org = (s: Scope) => s.orgId as string;

  return {
    insertEpisode: (scope, e) =>
      one(
        db
          .from('helm_genome_episodes')
          .insert({
            org_id: org(scope),
            decision_id: e.decisionId,
            commitment_id: e.commitmentId,
            title: e.title,
            scope: e.scope,
            situation: e.situation,
            boundary_effective: e.boundary.effectiveAsOf,
            boundary_recorded: e.boundary.recordedThrough,
            sensitivity_classes: e.sensitivityClasses,
            visibility: e.visibility,
            granted_unit_ids: e.grantedUnitIds,
            authored_by: scope.actorId,
            authored_by_label: e.authoredByLabel,
          })
          .select('*')
          .single(),
        toEpisode,
        'open episode',
      ),
    async getEpisode(scope, id) {
      const { data, error } = await db.from('helm_genome_episodes').select('*').eq('org_id', org(scope)).eq('id', id).maybeSingle();
      if (error) return fail(GenomeErrors.INVALID, error.message);
      return ok(data ? toEpisode(data as Row) : null);
    },
    listEpisodes: (scope) => many(db.from('helm_genome_episodes').select('*').eq('org_id', org(scope)).order('recorded_at'), toEpisode, 'list episodes'),
    insertEpisodeRef: (scope, r) =>
      one(
        db.from('helm_genome_episode_refs').insert({ org_id: org(scope), episode_id: r.episodeId, role: r.role, ref: r.ref, note: r.note, bound_by: scope.actorId }).select('*').single(),
        toRef,
        'bind reference',
      ),
    listEpisodeRefs: (scope, episodeId) => {
      let q = db.from('helm_genome_episode_refs').select('*').eq('org_id', org(scope));
      if (episodeId) q = q.eq('episode_id', episodeId);
      return many(q.order('recorded_at'), toRef, 'list references');
    },

    async insertPattern(scope, pattern, first) {
      const { data, error } = await db.rpc('helm_record_genome_pattern', {
        p_pattern: {
          org_id: org(scope),
          title: pattern.title,
          scope: pattern.scope,
          conditions: pattern.conditions,
          characteristic: pattern.characteristic,
          visibility: pattern.visibility,
          granted_unit_ids: pattern.grantedUnitIds,
          authored_by_label: pattern.authoredByLabel,
        },
        p_revision: { statement: first.statement, limitations: first.limitations },
      });
      if (error) return fail(GenomeErrors.INVALID, `record pattern: ${error.message}`);
      const id = String(data);
      const p = await one(db.from('helm_genome_patterns').select('*').eq('id', id).single(), toPattern, 'read pattern');
      if (!p.ok) return p;
      const r = await one(db.from('helm_genome_pattern_revisions').select('*').eq('pattern_id', id).eq('revision', 1).single(), toRevision, 'read revision');
      if (!r.ok) return r;
      return ok({ pattern: p.value, revision: r.value });
    },
    async insertPatternRevision(scope, patternId, input) {
      const last = await db.from('helm_genome_pattern_revisions').select('revision').eq('pattern_id', patternId).order('revision', { ascending: false }).limit(1);
      if (last.error) return fail(GenomeErrors.INVALID, last.error.message);
      const prior = ((last.data as Row[]) ?? [])[0];
      if (!prior) return fail(GenomeErrors.NOT_FOUND, 'No such pattern visible in this organization.');
      return one(
        db
          .from('helm_genome_pattern_revisions')
          .insert({
            org_id: org(scope),
            pattern_id: patternId,
            revision: Number(prior.revision) + 1,
            statement: input.statement,
            limitations: input.limitations,
            retired: input.retired,
            retirement_reason: input.retirementReason,
            recorded_by: scope.actorId,
          })
          .select('*')
          .single(),
        toRevision,
        'revise pattern',
      );
    },
    async getPattern(scope, id) {
      const { data, error } = await db.from('helm_genome_patterns').select('*').eq('org_id', org(scope)).eq('id', id).maybeSingle();
      if (error) return fail(GenomeErrors.INVALID, error.message);
      return ok(data ? toPattern(data as Row) : null);
    },
    listPatterns: (scope) => many(db.from('helm_genome_patterns').select('*').eq('org_id', org(scope)).order('recorded_at'), toPattern, 'list patterns'),
    listPatternRevisions: (scope, patternId) => {
      let q = db.from('helm_genome_pattern_revisions').select('*').eq('org_id', org(scope));
      if (patternId) q = q.eq('pattern_id', patternId);
      return many(q.order('recorded_at'), toRevision, 'list revisions');
    },
    insertPatternEvidence: (scope, e) =>
      one(
        db
          .from('helm_genome_pattern_evidence')
          .insert({ org_id: org(scope), pattern_id: e.patternId, episode_id: e.episodeId, stance: e.stance, rationale: e.rationale, observed: e.observed, linked_by: scope.actorId })
          .select('*')
          .single(),
        toEvidence,
        'link episode',
      ),
    listPatternEvidence: (scope, patternId) => {
      let q = db.from('helm_genome_pattern_evidence').select('*').eq('org_id', org(scope));
      if (patternId) q = q.eq('pattern_id', patternId);
      return many(q.order('recorded_at'), toEvidence, 'list links');
    },

    insertLesson: (scope, l) =>
      one(
        db
          .from('helm_genome_lessons')
          .insert({ org_id: org(scope), claim: l.claim, scope: l.scope, evidence: l.evidence, visibility: l.visibility, granted_unit_ids: l.grantedUnitIds, authored_by: scope.actorId, authored_by_label: l.authoredByLabel })
          .select('*')
          .single(),
        toLesson,
        'record lesson',
      ),
    listLessons: (scope) => many(db.from('helm_genome_lessons').select('*').eq('org_id', org(scope)).order('recorded_at'), toLesson, 'list lessons'),
    insertLessonReview: (scope, r) =>
      one(
        db.from('helm_genome_lesson_reviews').insert({ org_id: org(scope), lesson_id: r.lessonId, status: r.status, note: r.note, reviewed_by: scope.actorId, reviewed_by_label: r.reviewedByLabel }).select('*').single(),
        toReview,
        'review lesson',
      ),
    listLessonReviews: (scope, lessonId) => {
      let q = db.from('helm_genome_lesson_reviews').select('*').eq('org_id', org(scope));
      if (lessonId) q = q.eq('lesson_id', lessonId);
      return many(q.order('recorded_at'), toReview, 'list reviews');
    },
  };
}
