/**
 * The ReviewStore conformance suite.
 *
 * ONE contract, run against EVERY adapter: records are write-once and stamped
 * with the store's own record time; a review follows a CLOSED review of the same
 * scope; a closed review is memory and takes no more items; a review closes
 * once, after it opened, with every item given exactly one disposition; only a
 * question owns its content; nothing crosses a tenant wall.
 *
 * Runner-agnostic, so it works under `node --test` and anything later.
 */

import type { Result, Scope, UserId } from '@helm/shared';
import type { ReviewStore } from './port.ts';
import type { ManagementReview } from './types.ts';

export type ReviewTestApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
  };
};

export type ReviewStoreHarness = {
  name: string;
  create(): Promise<{
    store: ReviewStore;
    scopeA: Scope;
    scopeB: Scope;
    /** A twin snapshot of scopeA's organization to open and close against. */
    snapshotId: string;
    userId: UserId;
    now: () => Date;
    cleanup?: () => Promise<void>;
  }>;
};

function expectOk<T>(r: Result<T>, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${r.error.code} — ${r.error.message}`);
  return r.value;
}

export function runReviewStoreConformanceSuite(api: ReviewTestApi, harness: ReviewStoreHarness): void {
  const { describe, it, assert } = api;

  describe(`ReviewStore conformance — ${harness.name}`, () => {
    const reviewOf = (h: Awaited<ReturnType<ReviewStoreHarness['create']>>, over: Partial<Omit<ManagementReview, 'id' | 'orgId' | 'recordedAt'>> = {}) => {
      const at = new Date(h.now().getTime() - 60_000).toISOString();
      return {
        title: 'A conformance review',
        cadence: 'WEEKLY' as const,
        periodLabel: '2026-W40',
        scope: { kind: 'ENTERPRISE' as const, label: 'Conformance' },
        previousReviewId: null,
        openingSnapshotId: h.snapshotId,
        openingLens: { effectiveAsOf: at, recordedThrough: at },
        preparationFingerprint: 'rvp_fixture',
        sensitivityClasses: ['GENERAL_MANAGEMENT' as const],
        visibility: 'ORG_WIDE' as const,
        grantedUnitIds: [],
        openedBy: h.userId,
        openedByLabel: 'conformance',
        ...over,
      };
    };
    const question = (reviewId: string, userId: UserId) => ({ reviewId, kind: 'QUESTION' as const, role: 'RAISED' as const, ref: null, decisionId: null, note: 'Why did the margin move?', carriedFromItemId: null, addedBy: userId });
    const closureOf = (h: Awaited<ReturnType<ReviewStoreHarness['create']>>, reviewId: string, dispositions: { itemId: string; disposition: 'RESOLVED' | 'CARRIED_FORWARD' | 'DROPPED'; reason: string }[]) => {
      const at = h.now().toISOString();
      return { reviewId, closingSnapshotId: h.snapshotId, closingLens: { effectiveAsOf: at, recordedThrough: at }, closingFingerprint: 'rvp_closed', summary: 'Management concluded.', dispositions, closedBy: h.userId, closedByLabel: 'conformance' };
    };

    it('a review is recorded once with a record time the store stamped; nothing is edited', async () => {
      const h = await harness.create();
      try {
        const r = expectOk(await h.store.insertReview(h.scopeA, reviewOf(h)), 'open');
        assert.ok(r.recordedAt, 'the store stamps record time');
        assert.equal(expectOk(await h.store.getReview(h.scopeA, r.id), 'get')?.id, r.id);
      } finally {
        await h.cleanup?.();
      }
    });

    it('only a question owns its content: any other item references an object', async () => {
      const h = await harness.create();
      try {
        const r = expectOk(await h.store.insertReview(h.scopeA, reviewOf(h)), 'open');
        expectOk(await h.store.insertItem(h.scopeA, question(r.id, h.userId)), 'question');
        const hollow = await h.store.insertItem(h.scopeA, { ...question(r.id, h.userId), kind: 'DECISION', ref: null });
        assert.equal(hollow.ok, false, 'a DECISION item with no reference was recorded');
        const idle = await h.store.insertItem(h.scopeA, { ...question(r.id, h.userId), note: 'why?' });
        assert.equal(idle.ok, false, 'a question that is not a sentence was recorded');
      } finally {
        await h.cleanup?.();
      }
    });

    it('a review closes once, with every item given exactly one disposition; a closed review takes no more items', async () => {
      const h = await harness.create();
      try {
        const r = expectOk(await h.store.insertReview(h.scopeA, reviewOf(h)), 'open');
        const q1 = expectOk(await h.store.insertItem(h.scopeA, question(r.id, h.userId)), 'q1');
        const q2 = expectOk(await h.store.insertItem(h.scopeA, { ...question(r.id, h.userId), note: 'What did we learn from Rohto?' }), 'q2');
        const hanging = await h.store.insertClosure(h.scopeA, closureOf(h, r.id, [{ itemId: q1.id, disposition: 'RESOLVED', reason: 'Answered.' }]));
        assert.equal(hanging.ok, false, 'a closure that left an item hanging was accepted');
        const doubled = await h.store.insertClosure(h.scopeA, closureOf(h, r.id, [{ itemId: q1.id, disposition: 'RESOLVED', reason: 'a' }, { itemId: q1.id, disposition: 'DROPPED', reason: 'b' }, { itemId: q2.id, disposition: 'RESOLVED', reason: 'c' }]));
        assert.equal(doubled.ok, false, 'an item was given two dispositions');
        const closure = expectOk(await h.store.insertClosure(h.scopeA, closureOf(h, r.id, [{ itemId: q1.id, disposition: 'RESOLVED', reason: 'Answered.' }, { itemId: q2.id, disposition: 'CARRIED_FORWARD', reason: 'Needs the Q1 numbers.' }])), 'close');
        assert.ok(closure.recordedAt);
        assert.equal((await h.store.insertClosure(h.scopeA, closureOf(h, r.id, []))).ok, false, 'a review closed twice');
        const late = await h.store.insertItem(h.scopeA, question(r.id, h.userId));
        assert.equal(late.ok, false, 'a closed review took another item');
        assert.equal(late.ok ? '' : late.error.code, 'review.closed');
      } finally {
        await h.cleanup?.();
      }
    });

    it('a review follows a CLOSED review of the same scope', async () => {
      const h = await harness.create();
      try {
        const a = expectOk(await h.store.insertReview(h.scopeA, reviewOf(h)), 'first');
        const early = await h.store.insertReview(h.scopeA, reviewOf(h, { previousReviewId: a.id }));
        assert.equal(early.ok, false, 'a review followed one that was still open');
        expectOk(await h.store.insertClosure(h.scopeA, closureOf(h, a.id, [])), 'close first');
        expectOk(await h.store.insertReview(h.scopeA, reviewOf(h, { previousReviewId: a.id })), 'second');
        const elsewhere = await h.store.insertReview(h.scopeA, reviewOf(h, { previousReviewId: a.id, scope: { kind: 'ENTITY', entityId: '00000000-0000-4000-8000-0000000000aa', entityTypeKey: 'BusinessUnit', label: 'Elsewhere' } }));
        assert.equal(elsewhere.ok, false, 'a review followed one of another scope');
      } finally {
        await h.cleanup?.();
      }
    });

    it('nothing crosses a tenant wall', async () => {
      const h = await harness.create();
      try {
        const r = expectOk(await h.store.insertReview(h.scopeA, reviewOf(h)), 'open');
        assert.equal(expectOk(await h.store.getReview(h.scopeB, r.id), 'B get'), null);
        assert.equal(expectOk(await h.store.listReviews(h.scopeB), 'B list').filter((x) => x.id === r.id).length, 0);
      } finally {
        await h.cleanup?.();
      }
    });
  });
}
