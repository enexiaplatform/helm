/**
 * The ReviewStore port and the ReviewRuntime interface (ADR-0031).
 *
 * The store keeps records only — a review, its items and its closure — every
 * one append-only. A review's status (OPEN or CLOSED), the pack it was prepared
 * with and the change during it are derived, never stored as facts: the
 * preparation and closing fingerprints stored are the CHECK that a later
 * recomputation must match.
 *
 * No Postgres concept appears here.
 */

import type { Result, Scope } from '@helm/shared';
import type { OrgUnit } from '@helm/authority-runtime';
import type { CausalGraph } from '@helm/causal-runtime';
import type { CounterfactualRuntime } from '@helm/counterfactual-runtime';
import type { DecisionStore } from '@helm/decision-runtime';
import type { ManagementGenome } from '@helm/genome-runtime';
import type { TwinRuntime, TwinScope, TwinViewer } from '@helm/twin-runtime';
import type { Cadence, ItemKind, ItemRef, ItemRole, ItemDisposition, ManagementReview, ReviewClosure, ReviewItem, ReviewLens, ReviewPack } from './types.ts';

export type NewReview = Omit<ManagementReview, 'id' | 'orgId' | 'recordedAt'>;
export type NewItem = Omit<ReviewItem, 'id' | 'orgId' | 'recordedAt'>;
export type NewClosure = Omit<ReviewClosure, 'id' | 'orgId' | 'recordedAt'>;

export interface ReviewStore {
  /** Write-once. */
  insertReview(scope: Scope, input: NewReview): Promise<Result<ManagementReview>>;
  getReview(scope: Scope, id: string): Promise<Result<ManagementReview | null>>;
  listReviews(scope: Scope): Promise<Result<readonly ManagementReview[]>>;
  /** Write-once, and refused once the review is closed: a closed review is memory. */
  insertItem(scope: Scope, input: NewItem): Promise<Result<ReviewItem>>;
  listItems(scope: Scope, reviewId?: string): Promise<Result<readonly ReviewItem[]>>;
  /** Write-once, one per review; every item must be given a disposition. */
  insertClosure(scope: Scope, input: NewClosure): Promise<Result<ReviewClosure>>;
  getClosure(scope: Scope, reviewId: string): Promise<Result<ReviewClosure | null>>;
  listClosures(scope: Scope): Promise<Result<readonly ReviewClosure[]>>;
}

/**
 * What a review reads. `causal`, `genome` and `counterfactual` are optional and
 * read lazily: an enterprise that has no genome yet has an empty one, and a pack
 * built before it existed says "unavailable", it does not pretend.
 */
export type ReviewSources = {
  readonly twin: TwinRuntime;
  readonly decisions: DecisionStore;
  causal?: CausalGraph;
  genome?: ManagementGenome;
  counterfactual?: CounterfactualRuntime;
};

export type OpenReviewInput = {
  title: string;
  cadence: Cadence;
  periodLabel: string;
  scope: TwinScope;
  /** The twin periods the opening state is composed for. Default: those of the previous review. */
  periods?: readonly string[];
  /** Default: the latest CLOSED review of the same scope and cadence. Pass null to open without one. */
  previousReviewId?: string | null;
  visibility?: 'ORG_WIDE' | 'RESTRICTED';
  grantedUnitIds?: readonly string[];
  openedByLabel: string;
};

export type AddItemInput = { kind: ItemKind; ref?: ItemRef | null; role?: ItemRole; note?: string };

export type CloseReviewInput = { summary: string; dispositions: readonly ItemDisposition[]; closedByLabel: string };

export type ReviewView = {
  readonly review: ManagementReview;
  readonly lens: ReviewLens;
  /** OPEN until a closure is known at the lens. */
  readonly status: 'OPEN' | 'CLOSED';
  readonly items: readonly ReviewItem[];
  readonly closure: ReviewClosure | null;
  readonly previous: { readonly id: string; readonly title: string; readonly periodLabel: string } | null;
  /** The twin delta over the review itself (opening → closing); null while open. */
  readonly changeDuringReview: { readonly counts: Readonly<Record<string, number>>; readonly statement: string } | null;
  readonly statement: string;
};

export type Reproduction = {
  readonly reviewId: string;
  readonly which: 'PREPARATION' | 'CLOSING';
  readonly storedFingerprint: string;
  readonly recomputedFingerprint: string;
  readonly identical: boolean;
  readonly statement: string;
};

export type ReviewVisibilityFacts = { decisionVisible: (decisionId: string) => boolean };

export type ProjectedReviews = {
  readonly reviews: readonly ReviewView[];
  readonly withheld: number;
  readonly statement: string;
};

export interface ReviewRuntime {
  /** Opens the review: composes the opening twin state, prepares the pack, carries forward what the previous review left open. */
  openReview(scope: Scope, input: OpenReviewInput): Promise<Result<ReviewView>>;
  /** Records that this review touched an object that already exists. Refused once closed. */
  addItem(scope: Scope, reviewId: string, input: AddItemInput): Promise<Result<ReviewItem>>;
  /** Composes the closing twin state and records the closure. Every item needs a disposition. */
  closeReview(scope: Scope, reviewId: string, input: CloseReviewInput): Promise<Result<ReviewView>>;

  getReview(scope: Scope, id: string, lens?: ReviewLens): Promise<Result<ReviewView>>;
  listReviews(scope: Scope, lens?: ReviewLens): Promise<Result<readonly ReviewView[]>>;
  /** The preparation pack of a review: what changed, attention, decisions, commitments, assumptions, outcomes, learning, causal change. Derived at the opening lens. */
  prepare(scope: Scope, reviewId: string): Promise<Result<ReviewPack>>;
  /** The pack at the closing lens. Null while open. */
  closingPack(scope: Scope, reviewId: string): Promise<Result<ReviewPack | null>>;
  /** Recomputes a pack from the kernel as it stands NOW at the review's own lens; a closed review must come out identical. */
  reproduce(scope: Scope, reviewId: string, which: 'PREPARATION' | 'CLOSING'): Promise<Result<Reproduction>>;

  /**
   * The preparation pack as ONE viewer may read it: a review whole or not at all, then every section filtered by the viewer's
   * clearance, the decisions they can see and the genome's and causal graph's own rules. The pack's fingerprint stays the
   * full pack's — it names what management was shown, not what this viewer is shown of it.
   */
  preparedFor(scope: Scope, reviewId: string, viewer: TwinViewer, units: readonly OrgUnit[], facts: ReviewVisibilityFacts): Promise<Result<{ readonly pack: ReviewPack; readonly withheld: number; readonly statement: string }>>;

  /** What one viewer may read: a review whole or not at all, its decision-bound items only where they may see the decision. */
  projectForViewer(scope: Scope, viewer: TwinViewer, units: readonly OrgUnit[], facts: ReviewVisibilityFacts, lens?: ReviewLens): Promise<Result<ProjectedReviews>>;
}
