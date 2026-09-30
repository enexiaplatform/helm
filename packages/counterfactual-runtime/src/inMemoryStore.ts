/**
 * InMemoryCounterfactualStore — the reference adapter, held to the same
 * conformance suite as PostgresCounterfactualStore.
 *
 * Integrity it enforces (the database enforces the same, ADR-0029 §8):
 *   - every record is write-once; nothing is updated or deleted;
 *   - the store stamps record time from its own clock;
 *   - a world belongs to a case of this organization;
 *   - AS_KNOWN_THEN carries no hindsight input and is read at or before the
 *     decision boundary; WITH_HINDSIGHT carries at least one, each learned
 *     after it — the two lenses cannot be blended in storage;
 *   - a world's state is anchored at or before the boundary;
 *   - ESTIMATED means a scenario run stands behind it; NOT_ESTIMABLE says why;
 *   - a review has a world to be a review of, and states its limitations.
 */

import { fail, ok, type Clock, type IdGen, type Scope } from '@helm/shared';
import type { CounterfactualStore, NewCase, NewReview, NewWorld } from './port.ts';
import { CounterfactualErrors, retrospectiveLenses, type CounterfactualCase, type CounterfactualReview, type CounterfactualWorld } from './types.ts';

export type InMemoryCounterfactualStoreOptions = { clock: Clock; idGen: IdGen };

type Tenant = { cases: CounterfactualCase[]; worlds: CounterfactualWorld[]; reviews: CounterfactualReview[] };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

const ms = (t: string) => Date.parse(t);

export function createInMemoryCounterfactualStore(opts: InMemoryCounterfactualStoreOptions): CounterfactualStore {
  const tenants = new Map<string, Tenant>();
  const t = (scope: Scope): Tenant => {
    let x = tenants.get(scope.orgId);
    if (!x) {
      x = { cases: [], worlds: [], reviews: [] };
      tenants.set(scope.orgId, x);
    }
    return x;
  };
  const now = () => opts.clock.now().toISOString();
  const id = () => opts.idGen.next();
  const invalid = (msg: string) => fail(CounterfactualErrors.INVALID, msg);

  return {
    async insertCase(scope, input: NewCase) {
      if (!input.title.trim() || !input.question.trim()) return invalid('A case has a title and states its question.');
      if (ms(input.anchor.lens.recordedThrough) > ms(input.boundary.recordedThrough)) {
        return fail(CounterfactualErrors.HINDSIGHT_AS_ANCHOR, 'The anchor was known only after the decision boundary; a counterfactual is anchored to the past.');
      }
      const c: CounterfactualCase = deepFreeze({ ...input, id: id(), orgId: scope.orgId, recordedAt: now() });
      t(scope).cases.push(c);
      return ok(c);
    },
    async getCase(scope, caseId) {
      return ok(t(scope).cases.find((c) => c.id === caseId) ?? null);
    },
    async listCases(scope, filter) {
      return ok(t(scope).cases.filter((c) => !filter?.decisionId || c.decisionId === filter.decisionId));
    },

    async insertWorld(scope, input: NewWorld) {
      const x = t(scope);
      const c = x.cases.find((k) => k.id === input.caseId);
      if (!c) return fail(CounterfactualErrors.NOT_FOUND, 'No such case in this organization.');
      if (!(retrospectiveLenses as readonly string[]).includes(input.lens)) return invalid(`Unknown lens "${input.lens}".`);
      if (input.lens === 'AS_KNOWN_THEN') {
        if (input.hindsightInputs.length > 0) return fail(CounterfactualErrors.HINDSIGHT_IN_AS_KNOWN_THEN, 'AS_KNOWN_THEN carries no hindsight input.');
        if (ms(input.knowledge.recordedThrough) > ms(c.boundary.recordedThrough)) {
          return fail(CounterfactualErrors.HINDSIGHT_IN_AS_KNOWN_THEN, 'AS_KNOWN_THEN is read at or before the decision boundary.');
        }
      } else {
        if (input.hindsightInputs.length === 0) return fail(CounterfactualErrors.NO_HINDSIGHT_INPUTS, 'WITH_HINDSIGHT carries at least one hindsight input.');
        if (input.hindsightInputs.some((h) => ms(h.learnedAt) <= ms(c.boundary.recordedThrough))) {
          return fail(CounterfactualErrors.NOT_HINDSIGHT, 'Every hindsight input was learned after the decision boundary.');
        }
      }
      if (ms(input.anchorFork.recordedThrough) > ms(c.boundary.recordedThrough)) {
        return fail(CounterfactualErrors.HINDSIGHT_AS_ANCHOR, 'A world\'s state is anchored at or before the decision boundary.');
      }
      if ((input.estimability === 'ESTIMATED') !== (input.scenario !== null)) return invalid('ESTIMATED means a scenario run stands behind the world; NOT_ESTIMABLE has none.');
      if (input.estimability === 'NOT_ESTIMABLE' && input.notEstimableReasons.length === 0) return invalid('A world that cannot be estimated says why.');
      const w: CounterfactualWorld = deepFreeze({ ...input, id: id(), orgId: scope.orgId, recordedAt: now() });
      x.worlds.push(w);
      return ok(w);
    },
    async listWorlds(scope, caseId) {
      return ok(t(scope).worlds.filter((w) => caseId === undefined || w.caseId === caseId));
    },

    async insertReview(scope, input: NewReview) {
      const x = t(scope);
      if (!x.cases.some((c) => c.id === input.caseId)) return fail(CounterfactualErrors.NOT_FOUND, 'No such case in this organization.');
      if (!x.worlds.some((w) => w.caseId === input.caseId)) return fail(CounterfactualErrors.NOTHING_TO_REVIEW, 'There is no world yet to review: estimate one first.');
      if (!input.statement.trim()) return invalid('A review states its reading.');
      if (!input.limitations.trim()) return invalid('A review states its limitations: what the comparison does not show.');
      const r: CounterfactualReview = deepFreeze({ ...input, id: id(), orgId: scope.orgId, recordedAt: now() });
      x.reviews.push(r);
      return ok(r);
    },
    async listReviews(scope, caseId) {
      return ok(t(scope).reviews.filter((r) => caseId === undefined || r.caseId === caseId));
    },
  };
}
