/**
 * InMemoryGenomeStore — the reference adapter, held to the same conformance
 * suite as PostgresGenomeStore.
 *
 * Integrity it enforces (the database enforces the same, ADR-0028 §9):
 *   - every record is write-once; nothing is updated or deleted;
 *   - the store stamps record time from its own clock;
 *   - references stay inside the organization;
 *   - an episode reference is bound once per (episode, role, referenced id);
 *   - pattern revisions are numbered 1, 2, 3 … and a retired pattern takes no more;
 *   - one link per (pattern, episode);
 *   - a lesson rests on at least one reference, and its author cannot endorse it.
 */

import { fail, ok, type Clock, type IdGen, type Scope } from '@helm/shared';
import type { GenomeStore, NewEpisode, NewEpisodeRef, NewLesson, NewLessonReview, NewPattern, NewPatternEvidence, NewPatternRevision } from './port.ts';
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

export type InMemoryGenomeStoreOptions = { clock: Clock; idGen: IdGen };

type Tenant = {
  episodes: ManagementEpisode[];
  refs: EpisodeRef[];
  patterns: ManagementPattern[];
  revisions: PatternRevision[];
  evidence: PatternEvidence[];
  lessons: Lesson[];
  reviews: LessonReview[];
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export function createInMemoryGenomeStore(opts: InMemoryGenomeStoreOptions): GenomeStore {
  const tenants = new Map<string, Tenant>();
  const t = (scope: Scope): Tenant => {
    let x = tenants.get(scope.orgId);
    if (!x) {
      x = { episodes: [], refs: [], patterns: [], revisions: [], evidence: [], lessons: [], reviews: [] };
      tenants.set(scope.orgId, x);
    }
    return x;
  };
  const now = () => opts.clock.now().toISOString();
  const id = () => opts.idGen.next();
  const invalid = (msg: string) => fail(GenomeErrors.INVALID, msg);

  const store: GenomeStore = {
    async insertEpisode(scope, input: NewEpisode) {
      if (!input.title.trim()) return invalid('An episode has a title.');
      const e: ManagementEpisode = deepFreeze({ ...input, id: id(), orgId: scope.orgId, recordedAt: now() });
      t(scope).episodes.push(e);
      return ok(e);
    },
    async getEpisode(scope, episodeId) {
      return ok(t(scope).episodes.find((e) => e.id === episodeId) ?? null);
    },
    async listEpisodes(scope) {
      return ok([...t(scope).episodes]);
    },
    async insertEpisodeRef(scope, input: NewEpisodeRef) {
      const x = t(scope);
      if (!x.episodes.some((e) => e.id === input.episodeId)) return fail(GenomeErrors.NOT_FOUND, 'No such episode in this organization.');
      if (x.refs.some((r) => r.episodeId === input.episodeId && r.role === input.role && r.ref.id === input.ref.id)) {
        return fail(GenomeErrors.DUPLICATE, 'That reference is already bound to the episode in that role.');
      }
      const r: EpisodeRef = deepFreeze({ ...input, id: id(), orgId: scope.orgId, recordedAt: now() });
      x.refs.push(r);
      return ok(r);
    },
    async listEpisodeRefs(scope, episodeId) {
      return ok(t(scope).refs.filter((r) => episodeId === undefined || r.episodeId === episodeId));
    },

    async insertPattern(scope, pattern: NewPattern, first: NewPatternRevision) {
      if (!pattern.title.trim()) return invalid('A pattern has a title.');
      if (first.retired) return invalid('A pattern cannot be created retired.');
      if (!first.limitations.trim()) return invalid('A pattern states its limitations.');
      const at = now();
      const p: ManagementPattern = deepFreeze({ ...pattern, id: id(), orgId: scope.orgId, recordedAt: at });
      const r: PatternRevision = deepFreeze({ ...first, id: id(), orgId: scope.orgId, patternId: p.id, revision: 1, recordedAt: at });
      const x = t(scope);
      x.patterns.push(p);
      x.revisions.push(r);
      return ok({ pattern: p, revision: r });
    },
    async insertPatternRevision(scope, patternId, input: NewPatternRevision) {
      const x = t(scope);
      if (!x.patterns.some((p) => p.id === patternId)) return fail(GenomeErrors.NOT_FOUND, 'No such pattern in this organization.');
      const prior = x.revisions.filter((r) => r.patternId === patternId).sort((a, b) => a.revision - b.revision);
      const last = prior[prior.length - 1];
      if (last.retired) return fail(GenomeErrors.IMMUTABLE, 'The pattern is retired; it takes no further revision. Author a new pattern.');
      if (!input.limitations.trim()) return invalid('A pattern states its limitations.');
      const r: PatternRevision = deepFreeze({ ...input, id: id(), orgId: scope.orgId, patternId, revision: last.revision + 1, recordedAt: now() });
      x.revisions.push(r);
      return ok(r);
    },
    async getPattern(scope, patternId) {
      return ok(t(scope).patterns.find((p) => p.id === patternId) ?? null);
    },
    async listPatterns(scope) {
      return ok([...t(scope).patterns]);
    },
    async listPatternRevisions(scope, patternId) {
      return ok(t(scope).revisions.filter((r) => patternId === undefined || r.patternId === patternId));
    },
    async insertPatternEvidence(scope, input: NewPatternEvidence) {
      const x = t(scope);
      if (!x.patterns.some((p) => p.id === input.patternId)) return fail(GenomeErrors.NOT_FOUND, 'No such pattern in this organization.');
      if (!x.episodes.some((e) => e.id === input.episodeId)) return fail(GenomeErrors.NOT_FOUND, 'No such episode in this organization.');
      const agrees =
        input.stance === 'CONTEXTUAL_EPISODE' ||
        (input.stance === 'SUPPORTING_EPISODE' && input.observed === 'SUPPORTS') ||
        (input.stance === 'CONTRADICTORY_EPISODE' && input.observed === 'CONTRADICTS');
      if (!agrees) return fail(GenomeErrors.INCONSISTENT_STANCE, 'The stance must agree with what HELM observed in the episode.');
      const latest = x.revisions.filter((r) => r.patternId === input.patternId).sort((a, b) => a.revision - b.revision).pop();
      if (latest?.retired) return fail(GenomeErrors.IMMUTABLE, 'The pattern is retired; it takes no further episode.');
      if (x.evidence.some((e) => e.patternId === input.patternId && e.episodeId === input.episodeId)) {
        return fail(GenomeErrors.DUPLICATE, 'This episode is already linked to this pattern; a stance is not rewritten by linking again.');
      }
      const e: PatternEvidence = deepFreeze({ ...input, id: id(), orgId: scope.orgId, recordedAt: now() });
      x.evidence.push(e);
      return ok(e);
    },
    async listPatternEvidence(scope, patternId) {
      return ok(t(scope).evidence.filter((e) => patternId === undefined || e.patternId === patternId));
    },

    async insertLesson(scope, input: NewLesson) {
      if (!input.claim.trim()) return invalid('A lesson states its claim.');
      if (input.evidence.length === 0) return invalid('A lesson rests on at least one episode or pattern.');
      const l: Lesson = deepFreeze({ ...input, id: id(), orgId: scope.orgId, recordedAt: now() });
      t(scope).lessons.push(l);
      return ok(l);
    },
    async listLessons(scope) {
      return ok([...t(scope).lessons]);
    },
    async insertLessonReview(scope, input: NewLessonReview) {
      const x = t(scope);
      const lesson = x.lessons.find((l) => l.id === input.lessonId);
      if (!lesson) return fail(GenomeErrors.NOT_FOUND, 'No such lesson in this organization.');
      if (input.status === 'ENDORSED' && input.reviewedBy !== null && input.reviewedBy === lesson.authoredBy) {
        return fail(GenomeErrors.SELF_ENDORSEMENT, 'An author cannot endorse their own lesson; someone else reviews it.');
      }
      if (!input.note.trim()) return invalid('A review says why.');
      const r: LessonReview = deepFreeze({ ...input, id: id(), orgId: scope.orgId, recordedAt: now() });
      x.reviews.push(r);
      return ok(r);
    },
    async listLessonReviews(scope, lessonId) {
      return ok(t(scope).reviews.filter((r) => lessonId === undefined || r.lessonId === lessonId));
    },
  };
  return store;
}
