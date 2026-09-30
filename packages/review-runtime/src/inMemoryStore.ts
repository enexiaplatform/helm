/**
 * InMemoryReviewStore — the reference adapter, held to the same conformance
 * suite as PostgresReviewStore.
 *
 * Integrity it enforces (the database enforces the same, ADR-0031):
 *   - every record is write-once; the store stamps record time from its clock;
 *   - a review follows a CLOSED review of the same scope;
 *   - a closed review takes no more items (a closed review is memory);
 *   - a review is closed once, after it opened, and every item has exactly one
 *     disposition — none is left hanging;
 *   - only a QUESTION has no reference.
 */

import { fail, ok, type Clock, type IdGen, type Scope } from '@helm/shared';
import type { NewClosure, NewItem, NewReview, ReviewStore } from './port.ts';
import { ReviewErrors, dispositions as dispositionValues, type ManagementReview, type ReviewClosure, type ReviewItem } from './types.ts';

export type InMemoryReviewStoreOptions = { clock: Clock; idGen: IdGen };

type Tenant = { reviews: ManagementReview[]; items: ReviewItem[]; closures: ReviewClosure[] };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

const ms = (t: string) => Date.parse(t);
const scopeKey = (s: ManagementReview['scope']) => (s.kind === 'ENTERPRISE' ? 'ENTERPRISE' : s.entityId);

export function createInMemoryReviewStore(opts: InMemoryReviewStoreOptions): ReviewStore {
  const tenants = new Map<string, Tenant>();
  const t = (scope: Scope): Tenant => {
    let x = tenants.get(scope.orgId);
    if (!x) {
      x = { reviews: [], items: [], closures: [] };
      tenants.set(scope.orgId, x);
    }
    return x;
  };
  const now = () => opts.clock.now().toISOString();
  const invalid = (m: string) => fail(ReviewErrors.INVALID, m);

  return {
    async insertReview(scope, input: NewReview) {
      const x = t(scope);
      if (!input.title.trim() || !input.periodLabel.trim()) return invalid('A review has a title and a period.');
      if (ms(input.openingLens.effectiveAsOf) > ms(input.openingLens.recordedThrough)) return invalid('A review cannot be known before what it describes happened.');
      if (input.previousReviewId) {
        const p = x.reviews.find((r) => r.id === input.previousReviewId);
        if (!p) return fail(ReviewErrors.NOT_FOUND, 'The previous review is not in this organization.');
        if (!x.closures.some((c) => c.reviewId === p.id)) return fail(ReviewErrors.PREVIOUS_NOT_CLOSED, 'A review follows a closed review.');
        if (scopeKey(p.scope) !== scopeKey(input.scope)) return fail(ReviewErrors.PREVIOUS_OTHER_SCOPE, 'The previous review is of another scope.');
      }
      const r: ManagementReview = deepFreeze({ ...input, id: opts.idGen.next(), orgId: scope.orgId, recordedAt: now() });
      x.reviews.push(r);
      return ok(r);
    },
    async getReview(scope, id) {
      return ok(t(scope).reviews.find((r) => r.id === id) ?? null);
    },
    async listReviews(scope) {
      return ok([...t(scope).reviews]);
    },

    async insertItem(scope, input: NewItem) {
      const x = t(scope);
      if (!x.reviews.some((r) => r.id === input.reviewId)) return fail(ReviewErrors.NOT_FOUND, 'No such review in this organization.');
      if (x.closures.some((c) => c.reviewId === input.reviewId)) return fail(ReviewErrors.CLOSED, 'A closed review is memory: it takes no more items.');
      if (input.kind === 'QUESTION' ? input.ref !== null || input.note.trim().length < 8 : input.ref === null) return invalid('Only a question has no reference, and a question is a sentence.');
      const i: ReviewItem = deepFreeze({ ...input, id: opts.idGen.next(), orgId: scope.orgId, recordedAt: now() });
      x.items.push(i);
      return ok(i);
    },
    async listItems(scope, reviewId) {
      return ok(t(scope).items.filter((i) => !reviewId || i.reviewId === reviewId));
    },

    async insertClosure(scope, input: NewClosure) {
      const x = t(scope);
      const review = x.reviews.find((r) => r.id === input.reviewId);
      if (!review) return fail(ReviewErrors.NOT_FOUND, 'No such review in this organization.');
      if (x.closures.some((c) => c.reviewId === input.reviewId)) return fail(ReviewErrors.CLOSED, 'A review is closed once.');
      if (ms(input.closingLens.recordedThrough) < ms(review.openingLens.recordedThrough)) return invalid('A review cannot close before it opened.');
      if (!input.summary.trim()) return invalid('A closure carries management\'s summary.');
      const mine = x.items.filter((i) => i.reviewId === input.reviewId);
      for (const d of input.dispositions) {
        if (!(dispositionValues as readonly string[]).includes(d.disposition) || !d.reason.trim()) return invalid('Every disposition is one of three and says why.');
      }
      const missing = mine.filter((i) => input.dispositions.filter((d) => d.itemId === i.id).length !== 1);
      if (missing.length > 0) return fail(ReviewErrors.OPEN_ITEMS, `${missing.length} item(s) do not have exactly one disposition.`);
      const c: ReviewClosure = deepFreeze({ ...input, id: opts.idGen.next(), orgId: scope.orgId, recordedAt: now() });
      x.closures.push(c);
      return ok(c);
    },
    async getClosure(scope, reviewId) {
      return ok(t(scope).closures.find((c) => c.reviewId === reviewId) ?? null);
    },
    async listClosures(scope) {
      return ok([...t(scope).closures]);
    },
  };
}
