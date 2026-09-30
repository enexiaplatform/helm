/**
 * The management review vocabulary (ADR-0031).
 *
 * A review is the operating cadence of management made a first-class object —
 * not meeting notes. It BINDS what already exists (twin snapshots, decisions,
 * commitments, governance, outcomes, causal claims, genome memory) by reference;
 * it copies none of it and runs no decision logic of its own. Deciding,
 * committing and governing stay in the decision and authority runtimes; a review
 * only records that, in this review, management did.
 */

import type { UserId } from '@helm/shared';
import type { SensitivityClass, TwinScope } from '@helm/twin-runtime';

export const ReviewErrors = {
  INVALID: 'review.invalid_input',
  NOT_FOUND: 'review.not_found',
  NOT_KNOWN_AT_LENS: 'review.not_known_at_lens',
  ALREADY_OPEN: 'review.already_open',
  CLOSED: 'review.closed',
  PREVIOUS_NOT_CLOSED: 'review.previous_not_closed',
  PREVIOUS_OTHER_SCOPE: 'review.previous_other_scope',
  OPEN_ITEMS: 'review.items_without_disposition',
  BAD_REF: 'review.bad_reference',
  SOURCE_MISSING: 'review.source_unavailable',
  DUPLICATE: 'review.duplicate',
} as const;

export const cadences = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'STRATEGIC'] as const;
export type Cadence = (typeof cadences)[number];

export type ReviewLens = { readonly effectiveAsOf: string; readonly recordedThrough: string };

/** What an item of a review is about. Every kind but QUESTION points at an object that already exists. */
export const itemKinds = [
  'ATTENTION', // a twin attention item, by item key in the opening snapshot
  'DECISION',
  'COMMITMENT',
  'ASSUMPTION',
  'ACTION_INTENT',
  'EPISODE', // genome
  'PATTERN',
  'LESSON',
  'COUNTERFACTUAL_CASE',
  'CAUSAL_CLAIM',
  'QUESTION', // the one thing a review owns: a question management raised
] as const;
export type ItemKind = (typeof itemKinds)[number];

/** What happened to the object IN this review. Framing, committing and reconsidering are done in the decision runtime; the role only records that it was. */
export const itemRoles = ['RAISED', 'FRAMED', 'COMMITTED', 'RECONSIDERED', 'NOTED'] as const;
export type ItemRole = (typeof itemRoles)[number];

export type ItemRef = { readonly kind: ItemKind; readonly id: string; readonly label: string };

export type ManagementReview = {
  readonly id: string;
  readonly orgId: string;
  readonly title: string;
  readonly cadence: Cadence;
  /** '2026-W39', '2026-10', '2026-Q4' — a label people recognise, not a computed period. */
  readonly periodLabel: string;
  readonly scope: TwinScope;
  /** Null for the first review of a scope and cadence. */
  readonly previousReviewId: string | null;
  /** The twin state management opened the review with: known at, and composed under, the opening lens. */
  readonly openingSnapshotId: string;
  readonly openingLens: ReviewLens;
  /** The fingerprint of the preparation pack at the opening lens: what management was shown. */
  readonly preparationFingerprint: string;
  readonly sensitivityClasses: readonly SensitivityClass[];
  readonly visibility: 'ORG_WIDE' | 'RESTRICTED';
  readonly grantedUnitIds: readonly string[];
  readonly openedBy: UserId | null;
  readonly openedByLabel: string;
  readonly recordedAt: string;
};

export type ReviewItem = {
  readonly id: string;
  readonly orgId: string;
  readonly reviewId: string;
  readonly kind: ItemKind;
  readonly role: ItemRole;
  /** Null only for a QUESTION. */
  readonly ref: ItemRef | null;
  /** For decision-bound kinds: the decision the reference belongs to, so visibility can follow it. */
  readonly decisionId: string | null;
  /** The person's note; for a QUESTION, the question itself. */
  readonly note: string;
  /** The item of the previous review this one carries forward. The SAME object is referenced: nothing is duplicated. */
  readonly carriedFromItemId: string | null;
  readonly addedBy: UserId | null;
  readonly recordedAt: string;
};

export const dispositions = ['RESOLVED', 'CARRIED_FORWARD', 'DROPPED'] as const;
export type Disposition = (typeof dispositions)[number];

export type ItemDisposition = { readonly itemId: string; readonly disposition: Disposition; readonly reason: string };

export type ReviewClosure = {
  readonly id: string;
  readonly orgId: string;
  readonly reviewId: string;
  readonly closingSnapshotId: string;
  readonly closingLens: ReviewLens;
  /** The pack at the closing lens. Reproducible: recomputed later, it must match. */
  readonly closingFingerprint: string;
  /** What management concluded — a person's words. */
  readonly summary: string;
  /** Every item is resolved, carried forward or dropped; none is left hanging. */
  readonly dispositions: readonly ItemDisposition[];
  readonly closedBy: UserId | null;
  readonly closedByLabel: string;
  readonly recordedAt: string;
};

// -------------------------------------------------------------------- pack

export type PackChange = { readonly itemKey: string; readonly label: string; readonly category: string; readonly change: 'ADDED' | 'REMOVED' | 'CHANGED'; readonly statement: string; readonly sensitivity: SensitivityClass };

export type PackSection<T> = { readonly items: readonly T[]; readonly note: string | null };

/**
 * What a review is prepared with — assembled from the kernel, never typed in.
 * Kernel order, no ranking: nothing here is sorted by importance or scored.
 */
export type ReviewPack = {
  readonly lens: ReviewLens;
  /** The previous review's closing lens; null for a first review. */
  readonly since: ReviewLens | null;
  readonly previousReviewId: string | null;
  readonly openingSnapshotId: string;
  /** What changed? */
  readonly changed: {
    readonly fromSnapshotId: string | null;
    readonly toSnapshotId: string;
    readonly comparable: boolean;
    readonly warnings: readonly string[];
    readonly counts: Readonly<Record<string, number>>;
    readonly changes: readonly PackChange[];
    readonly statement: string;
  };
  /** What requires attention? */
  readonly attention: PackSection<{ readonly itemKey: string; readonly label: string; readonly condition: string; readonly statement: string; readonly sensitivity: SensitivityClass }>;
  /** What decisions are needed? Opened, and not yet committed, at the lens. */
  readonly decisionsNeeded: PackSection<{ readonly decisionId: string; readonly title: string; readonly question: string; readonly openedAt: string }>;
  /** What commitments are off-track? Lines beyond materiality, current against the committed future. */
  readonly commitmentsOffTrack: PackSection<{
    readonly commitmentId: string;
    readonly decisionId: string;
    readonly title: string;
    readonly relation: string;
    readonly lines: readonly { readonly label: string; readonly committed: string | null; readonly current: string | null; readonly difference: string | null; readonly unit: string | null }[];
    readonly unresolved: readonly string[];
  }>;
  /** What assumptions changed? Results recorded by outcome reviews in the window. */
  readonly assumptionsChanged: PackSection<{ readonly decisionId: string; readonly assumptionId: string; readonly statement: string; readonly outcome: string; readonly reviewedAt: string }>;
  /** What outcomes arrived? */
  readonly outcomesArrived: PackSection<{
    readonly decisionId: string;
    readonly commitmentId: string;
    readonly outcomeReviewId: string;
    readonly reviewedAt: string;
    readonly variances: readonly { readonly label: string; readonly expected: string | null; readonly actual: string | null; readonly variance: string | null; readonly unit: string | null }[];
  }>;
  /** What did we learn? Genome memory and counterfactual review recorded in the window. */
  readonly learning: {
    readonly episodes: PackSection<{ readonly id: string; readonly decisionId: string; readonly title: string; readonly status: string }>;
    readonly patterns: PackSection<{ readonly id: string; readonly title: string; readonly status: string }>;
    readonly lessons: PackSection<{ readonly id: string; readonly claim: string; readonly status: string }>;
    readonly counterfactuals: PackSection<{ readonly id: string; readonly decisionId: string; readonly title: string; readonly status: string }>;
  };
  /** What causal beliefs changed? */
  readonly causalChanges: PackSection<{ readonly claimId: string; readonly statement: string; readonly status: string; readonly revision: number; readonly recordedAt: string }>;
  /** Sources that were not available to this pack — a missing source is said out loud, never silently empty. */
  readonly unavailable: readonly string[];
  readonly statement: string;
  /** Content only: no clock, no reader. */
  readonly fingerprint: string;
};
