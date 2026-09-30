/**
 * PostgresReviewStore — the ReviewStore over Supabase.
 *
 * The I/O boundary of @helm/review-runtime, held to the same conformance suite
 * as the in-memory store. The database enforces the integrity rules
 * (helm_management_review* guards and CHECKs): write-once, record time stamped
 * by the database, a review follows a closed review of the same scope, a closed
 * review takes no more items, a review closes once with every item given exactly
 * one disposition.
 *
 * Reads are RLS-shaped: a review is returned only whole (its unit audience and
 * every class of its opening state), and an item about a decision only where
 * the decision can be seen — the database's projection, never an error.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fail, ok, type Result, type Scope, type UserId } from '@helm/shared';
import type { ReviewStore } from './port.ts';
import { ReviewErrors, type ManagementReview, type ReviewClosure, type ReviewItem } from './types.ts';

export type PostgresReviewStoreOptions = { client: SupabaseClient };

type Row = Record<string, unknown>;
const iso = (v: unknown): string => new Date(v as string).toISOString();

const toReview = (r: Row): ManagementReview => ({
  id: String(r.id),
  orgId: String(r.org_id),
  title: String(r.title),
  cadence: r.cadence as ManagementReview['cadence'],
  periodLabel: String(r.period_label),
  scope: r.scope as ManagementReview['scope'],
  previousReviewId: (r.previous_review_id as string | null) ?? null,
  openingSnapshotId: String(r.opening_snapshot_id),
  openingLens: { effectiveAsOf: iso(r.opening_effective), recordedThrough: iso(r.opening_recorded) },
  preparationFingerprint: String(r.preparation_fingerprint),
  sensitivityClasses: ((r.sensitivity_classes as string[]) ?? []).slice().sort() as ManagementReview['sensitivityClasses'],
  visibility: r.visibility as ManagementReview['visibility'],
  grantedUnitIds: ((r.granted_unit_ids as string[]) ?? []).slice().sort(),
  openedBy: (r.opened_by as UserId | null) ?? null,
  openedByLabel: String(r.opened_by_label),
  recordedAt: iso(r.recorded_at),
});

const toItem = (r: Row): ReviewItem => ({
  id: String(r.id),
  orgId: String(r.org_id),
  reviewId: String(r.review_id),
  kind: r.kind as ReviewItem['kind'],
  role: r.role as ReviewItem['role'],
  ref: (r.ref as ReviewItem['ref']) ?? null,
  decisionId: (r.decision_id as string | null) ?? null,
  note: String(r.note ?? ''),
  carriedFromItemId: (r.carried_from_item_id as string | null) ?? null,
  addedBy: (r.added_by as UserId | null) ?? null,
  recordedAt: iso(r.recorded_at),
});

const toClosure = (r: Row): ReviewClosure => ({
  id: String(r.id),
  orgId: String(r.org_id),
  reviewId: String(r.review_id),
  closingSnapshotId: String(r.closing_snapshot_id),
  closingLens: { effectiveAsOf: iso(r.closing_effective), recordedThrough: iso(r.closing_recorded) },
  closingFingerprint: String(r.closing_fingerprint),
  summary: String(r.summary),
  dispositions: (r.dispositions as ReviewClosure['dispositions']) ?? [],
  closedBy: (r.closed_by as UserId | null) ?? null,
  closedByLabel: String(r.closed_by_label),
  recordedAt: iso(r.recorded_at),
});

type Q = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

const codeOf = (message: string): string =>
  /closed review is memory|takes no more items/i.test(message)
    ? ReviewErrors.CLOSED
    : /none is left hanging|exactly one disposition/i.test(message)
      ? ReviewErrors.OPEN_ITEMS
      : /follows a closed review/i.test(message)
        ? ReviewErrors.PREVIOUS_NOT_CLOSED
        : /another scope/i.test(message)
          ? ReviewErrors.PREVIOUS_OTHER_SCOPE
          : ReviewErrors.INVALID;

async function one<T>(q: Q, map: (r: Row) => T, what: string): Promise<Result<T>> {
  const { data, error } = await q;
  if (error) return fail(codeOf(error.message), `${what}: ${error.message}`);
  if (!data) return fail(ReviewErrors.NOT_FOUND, `${what}: nothing was returned (not visible, or refused by policy).`);
  return ok(map(data as Row));
}
async function many<T>(q: Q, map: (r: Row) => T, what: string): Promise<Result<readonly T[]>> {
  const { data, error } = await q;
  if (error) return fail(ReviewErrors.INVALID, `${what}: ${error.message}`);
  return ok(((data as Row[]) ?? []).map(map));
}

export function createPostgresReviewStore(opts: PostgresReviewStoreOptions): ReviewStore {
  const db = opts.client;
  const org = (s: Scope) => s.orgId as string;
  return {
    insertReview: (scope, r) =>
      one(
        db
          .from('helm_management_reviews')
          .insert({
            org_id: org(scope),
            title: r.title,
            cadence: r.cadence,
            period_label: r.periodLabel,
            scope: r.scope,
            previous_review_id: r.previousReviewId,
            opening_snapshot_id: r.openingSnapshotId,
            opening_effective: r.openingLens.effectiveAsOf,
            opening_recorded: r.openingLens.recordedThrough,
            preparation_fingerprint: r.preparationFingerprint,
            sensitivity_classes: r.sensitivityClasses,
            visibility: r.visibility,
            granted_unit_ids: r.grantedUnitIds,
            opened_by: r.openedBy ?? scope.actorId,
            opened_by_label: r.openedByLabel,
          })
          .select('*')
          .single(),
        toReview,
        'Opening the review',
      ),
    async getReview(scope, id) {
      const { data, error } = await db.from('helm_management_reviews').select('*').eq('org_id', org(scope)).eq('id', id).maybeSingle();
      if (error) return fail(ReviewErrors.INVALID, `Reading the review: ${error.message}`);
      return ok(data ? toReview(data as Row) : null);
    },
    listReviews: (scope) => many(db.from('helm_management_reviews').select('*').eq('org_id', org(scope)).order('recorded_at', { ascending: true }), toReview, 'Listing reviews'),

    insertItem: (scope, i) =>
      one(
        db
          .from('helm_management_review_items')
          .insert({
            org_id: org(scope),
            review_id: i.reviewId,
            kind: i.kind,
            role: i.role,
            ref: i.ref,
            decision_id: i.decisionId,
            note: i.note,
            carried_from_item_id: i.carriedFromItemId,
            added_by: i.addedBy ?? scope.actorId,
          })
          .select('*')
          .single(),
        toItem,
        'Adding the item',
      ),
    listItems: (scope, reviewId) => {
      let q = db.from('helm_management_review_items').select('*').eq('org_id', org(scope)).order('recorded_at', { ascending: true });
      if (reviewId) q = q.eq('review_id', reviewId);
      return many(q, toItem, 'Listing items');
    },

    insertClosure: (scope, c) =>
      one(
        db
          .from('helm_management_review_closures')
          .insert({
            org_id: org(scope),
            review_id: c.reviewId,
            closing_snapshot_id: c.closingSnapshotId,
            closing_effective: c.closingLens.effectiveAsOf,
            closing_recorded: c.closingLens.recordedThrough,
            closing_fingerprint: c.closingFingerprint,
            summary: c.summary,
            dispositions: c.dispositions,
            closed_by: c.closedBy ?? scope.actorId,
            closed_by_label: c.closedByLabel,
          })
          .select('*')
          .single(),
        toClosure,
        'Closing the review',
      ),
    async getClosure(scope, reviewId) {
      const { data, error } = await db.from('helm_management_review_closures').select('*').eq('org_id', org(scope)).eq('review_id', reviewId).maybeSingle();
      if (error) return fail(ReviewErrors.INVALID, `Reading the closure: ${error.message}`);
      return ok(data ? toClosure(data as Row) : null);
    },
    listClosures: (scope) => many(db.from('helm_management_review_closures').select('*').eq('org_id', org(scope)).order('recorded_at', { ascending: true }), toClosure, 'Listing closures'),
  };
}
